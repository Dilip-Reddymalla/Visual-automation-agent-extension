/**
 * The detect phase: run the deterministic layers, then turn their values into stable
 * placeholders.
 *
 * L0 and L1 are node-pure and need no model, so they run here in the worker rather than
 * crossing to the offscreen document and back. The allocator does not run here, because
 * the map that makes «PERSON_1» the same human on step 9 as on step 2 must not be
 * persisted and must outlive an MV3 worker termination -- so values go over the bus and
 * tokens come back (offscreen/allocator.ts explains the choice).
 *
 * L2 is implemented and is awaited: the NER model runs in the offscreen document over the
 * text the deterministic layers did not already claim, and its spans join the same
 * FindingDraft[]. L3 runs last and appends to the same list: faces over the whole frame,
 * and OCR over the DOM-opaque regions invariant 9 names (images, canvases, cross-origin
 * iframes). OCR's recognised text is not simply painted -- it goes back through L1 and L2
 * exactly as page text would, so an Aadhaar or a name baked into a scanned ID is detected
 * and redacted before the frame is sealed, not shipped in the clear.
 */

import { detectStructural } from '../redaction/l0-structural';
import { detectLexical } from '../redaction/l1-lexical';
import { makeFinding, strongerDraft, type FindingDraft } from '../redaction/findings';
import { send, type OcrLine } from '../shared/messages';
import type { Finding, Origin, Viewport } from '../shared/contract';
import type { ObservedElement } from '../shared/observed';
import { iou } from '../shared/coords';
import type { FrameRef } from '../shared/frames';
import { MIN_OCR_SIDE, opaqueRegions } from '../offscreen/tasks/ocr';
import { detectEntities, type NerRunner, type Operating } from '../offscreen/tasks/ner';
import {
  isEmailValid,
  isIndianMobileValid,
  isPlausibleBirthDate,
} from '../redaction/validators';

export interface DetectResult {
  findings: Finding[];
  /** finding id -> the raw string it matched. Never persisted, never sent. */
  values: Map<string, string>;
  /** finding id -> placeholder, for substituting into the element list. */
  placeholders: Map<string, string>;
  /**
   * finding id -> element index.
   *
   * Kept here rather than on the wire Finding, which has no such field and should not
   * gain one: which DOM node a finding came from is a device-side detail, and putting
   * it in the manifest would hand the server a little more of the page's shape for no
   * benefit to the planner.
   */
  elementOf: Map<string, number>;
  /**
   * finding id -> where its box came from, which decides its padding in the gate.
   *
   * Never 'container': resolveContainers narrows or drops those before they get here,
   * and the narrowed type is how that invariant is stated to the rest of the chain.
   */
  boxKinds: Record<string, 'element' | 'text'>;
  /** How many container boxes were narrowed, and how many dropped for lack of a target. */
  containers: ContainerResolution;
  /** Set when L2 threw. Null when it ran, whether or not it found anything. */
  semanticError: string | null;
  /** Set when L3 face detector threw. Null when it ran, or was correctly skipped for having nowhere to look. */
  faceError: string | null;
  /** Set when L3 OCR threw. Null when it ran, or was correctly skipped. */
  ocrError: string | null;
}

/**
 * Two drafts for the same class in the same place are one finding.
 *
 * L0 says "this field is an Aadhaar field" from its autocomplete attribute and L1 says
 * "this string passes Verhoeff" about the value inside it -- the same fact, arrived at
 * twice. Keeping both would double-count in the manifest's coverage numbers and give
 * merge.ts two boxes to union where one would do.
 */
/** Two drafts on the same indexed control. */
function sameElement(a: FindingDraft, b: FindingDraft): boolean {
  return a.elementIndex !== undefined && a.elementIndex === b.elementIndex;
}

/**
 * Two drafts over the same pixels.
 *
 * Needed because a text block carries no index -- it is not clickable, so perception
 * deliberately gives it none -- and the index was the only thing dedup keyed on. So the
 * label rule and the checksum rule, firing on one `<dd>`, produced two drafts that could
 * not be recognised as the same thing and painted two boxes over one value.
 *
 * Measured when L0 first started reading prose: false positives went 33 to 123 and
 * over-redaction 0.094 to 0.327, almost all of it this.
 */
function sameRegion(a: FindingDraft, b: FindingDraft): boolean {
  return iou(a.box, b.box) > SAME_REGION_IOU;
}

/** Boxes overlapping this much are the same value seen twice, not two values. */
const SAME_REGION_IOU = 0.5;

/**
 * user > agent > page.
 *
 * Not arbitrary: it is decreasing strength of claim. `page` is the absence of any special
 * knowledge; `agent` is our own keystroke; `user` is the operator's own data, which
 * outranks the fact that we were the ones who typed it into the field.
 *
 * That last rung is what M13 added. "leo" from the task box, typed into the page by our
 * own executor, is both `user` and `agent` -- and recording it as `agent` would drop it
 * out of the protected count, under-reporting exactly the values the operator cares most
 * about. Redacted either way; counted only if the provenance is right.
 */
const ORIGIN_RANK: Record<Origin, number> = { user: 2, agent: 1, page: 0 };

function strongestOrigin(a: Origin = 'page', b: Origin = 'page'): Origin {
  return ORIGIN_RANK[a] >= ORIGIN_RANK[b] ? a : b;
}

/** Did this draft read the string in the box, as opposed to the label on it? */
function readAValue(draft: FindingDraft): boolean {
  return typeof draft.value === 'string' && draft.value.length > 0;
}

/**
 * Which of two drafts about one thing decides its class.
 *
 * `strongerDraft` answers this for everything except the case that matters most, and it
 * answers it wrongly there on purpose: LAYER_RANK puts L0 above L1, because a fact about
 * the markup is normally worth more than a pattern match. But when the two disagree about
 * an element that *holds a value*, the pattern match has read the data and the markup rule
 * has only read the label.
 *
 * We redact what the data IS, not what the field is FOR. A box labelled "First Name"
 * holding an email address holds an email address, and the class decides both the
 * operation and the placeholder -- so getting it wrong gets both wrong, and the planner is
 * handed «PERSON_1» for something that is not a person.
 *
 * Everything else falls through to the one precedence rule this project has.
 */
function decideClass(
  a: FindingDraft,
  b: FindingDraft,
): { winner: FindingDraft; loser: FindingDraft } {
  const validated = (x: FindingDraft, y: FindingDraft): boolean =>
    x.layer === 'L1' && y.layer === 'L0' && readAValue(x);

  if (validated(a, b)) return { winner: a, loser: b };
  if (validated(b, a)) return { winner: b, loser: a };

  const winner = strongerDraft(a, b);
  return { winner, loser: winner === a ? b : a };
}

/**
 * One thing, one draft -- across classes, which is the part that was missing.
 *
 * This used to require `existing.cls === draft.cls`, so two layers that agreed about
 * *where* and disagreed about *what* were treated as two separate findings. On a contact
 * form whose First Name and Last Name fields both held an email address, that is four
 * manifest rows for two boxes and two classes for one field -- and the panel showed
 * exactly that.
 *
 * Agreement about where is the whole test. What it is called is then arbitrated, once,
 * and the losing opinion is kept in the reason rather than thrown away: "L1:email-shape
 * over L0:label-person" is a better audit line than either half, and it costs one string.
 */
export function dedupeDrafts(drafts: FindingDraft[]): FindingDraft[] {
  const kept: FindingDraft[] = [];

  for (const draft of drafts) {
    const at = kept.findIndex(
      (existing) => sameElement(existing, draft) || sameRegion(existing, draft),
    );
    if (at === -1) {
      kept.push(draft);
      continue;
    }

    const existing = kept[at] as FindingDraft;
    const { winner, loser } = decideClass(existing, draft);

    kept[at] = {
      ...winner,
      // A draft that actually read a value keeps it: L0 knows what a field is for, L1
      // knows what is in it, and the allocator needs the string either way.
      value: winner.value ?? loser.value,
      // Provenance survives losing the class argument. One layer knowing the agent typed
      // this is knowledge; the other not saying so is only silence, and a semantic layer
      // reading document text has no element to ask. Getting this backwards would put our
      // own keystrokes back into the protected count by way of whichever layer won.
      origin: strongestOrigin(winner.origin, loser.origin),
      reason:
        winner.cls === loser.cls
          ? winner.reason
          : `${winner.layer}:${winner.reason} over ${loser.layer}:${loser.reason}`,
    };
  }

  return kept;
}

export function runDeterministicLayers(
  elements: ObservedElement[],
  viewport: Viewport,
): FindingDraft[] {
  return dedupeDrafts([
    ...detectStructural(elements, viewport),
    ...detectLexical(elements, viewport),
  ]);
}

/** What a container resolved to, or why it did not. Counts only, for the trace. */
export interface ContainerResolution {
  resolved: number;
  dropped: number;
}

/**
 * Refuse to paint a container.
 *
 * A container box spans a caption and a value together -- a `<dd>` beside its `<dt>`, a
 * `<td>` under its `<th>`, a wrapper around a field. Painting one blacks out the label as
 * well as the thing it labels, and across the corpus that was about half of all
 * over-redaction: the page comes back with whole rows missing and the visual context the
 * planner needs goes with them.
 *
 * So a container is never sent to the gate. It resolves to the element's own text runs,
 * which are drawn tight around the glyphs that hold the value -- the caption lives in a
 * sibling node and has runs of its own, so it is excluded by construction. A container
 * with nothing to resolve to is dropped rather than widened, because a box we cannot
 * justify is worse than a miss we can count.
 */
export function resolveContainers(
  drafts: FindingDraft[],
  elements: ObservedElement[],
): { drafts: FindingDraft[]; resolution: ContainerResolution } {
  const byIndex = new Map<number, ObservedElement>();
  for (const el of elements) {
    if (el.index !== undefined) byIndex.set(el.index, el);
  }

  const out: FindingDraft[] = [];
  let resolved = 0;
  let dropped = 0;

  for (const draft of drafts) {
    if (draft.boxKind !== 'container') {
      out.push(draft);
      continue;
    }

    const el =
      (draft.elementIndex !== undefined ? byIndex.get(draft.elementIndex) : undefined) ??
      elements.find((candidate) => sameBox(candidate.box, draft.box));

    const runs = el?.textRuns ?? [];
    const match =
      draft.value !== undefined && draft.value !== ''
        ? runs.find((run) => run.text.includes(draft.value as string))
        : undefined;
    const chosen = match ?? (runs.length === 1 ? runs[0] : undefined);

    if (!chosen) {
      dropped += 1;
      continue;
    }

    resolved += 1;
    out.push({ ...draft, box: chosen.box, boxKind: 'text' });
  }

  return { drafts: out, resolution: { resolved, dropped } };
}

function sameBox(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * Detection, allocation, and the two maps the rest of the step needs.
 *
 * `values` stays in the worker's step context and goes no further than the offscreen
 * document, which needs it to allocate. It is never written to storage and never put in
 * a trace line.
 */
/**
 * Does a model's guess survive the deterministic check for its own class?
 *
 * The model proposes; the validator disposes. For every class where L1 already knows how
 * to recognise the real thing, a span the model produced has to pass the same test the
 * page text would have had to pass -- and if it does not, the model has found something
 * that merely looks like the class.
 *
 * This is not belt-and-braces. Measured on the corpus the moment L2 went live: hard
 * negatives redacted went from 12 to 72 and precision from 0.82 to 0.68, because the
 * model labels a transaction date DATE, a reference number TELEPHONENUM, and a support
 * address EMAIL -- all correctly, in the sense that they are dates and numbers and
 * addresses. They are just not the *person's*.
 *
 * DOB carries the rule the module brief names explicitly: DATE maps to DOB only when the
 * text also reads as a birth date. A statement period is a date and is not a birthday.
 *
 * PERSON, ADDRESS and ORG have no validator, by their nature -- there is no checksum for
 * a name. Those are left to the model and to its confidence, which is where the two
 * operating points earn their keep.
 */
function semanticIsPlausible(draft: FindingDraft): boolean {
  const value = draft.value;
  if (value === undefined || value === '') return false;

  switch (draft.cls) {
    case 'DOB':
      return isPlausibleBirthDate(value);
    case 'PHONE':
      return isIndianMobileValid(value);
    case 'EMAIL':
      return isEmailValid(value);
    default:
      return true;
  }
}

/**
 * The model call, bound to a session, as an injectable NerRunner.
 *
 * Extracted so both callers share it: L2 over DOM text (detectSemantic) and L2 over the
 * text OCR recovered from pixels (ocrFindings). The offscreen host keys its per-session
 * state on the real sessionId -- handing it '' made every step look like the same nameless
 * session to the one component whose whole job is per-session bookkeeping.
 *
 * The bus lives here; the arithmetic that consumes the spans is node-pure in
 * offscreen/tasks/ner.ts, which is why that half is tested against a fake runner and this
 * half is a two-line adapter.
 */
function makeNerRunner(sessionId: string): NerRunner {
  return async (text) => {
    const reply = await send('INFER', { task: 'ner', sessionId, texts: [text] }, { to: 'offscreen' });
    if (reply.task !== 'ner') return [];
    return (reply.spans[0] ?? []).map((span) => ({
      start: span.start,
      end: span.end,
      label: span.cls,
      score: span.score,
    }));
  };
}

/**
 * L2, through the inference host.
 *
 * Failure here is not failure of the step. The deterministic layers have already run and
 * their findings are the ones with checksums behind them; a model that will not load --
 * no GPU, a corrupt file, an offscreen document that just went away -- must cost recall
 * on names, not the whole redaction.
 */
async function detectSemantic(
  elements: ObservedElement[],
  claimed: FindingDraft[],
  operating: Operating,
  sessionId: string,
): Promise<FindingDraft[]> {
  try {
    return await detectEntities(
      {
        elements,
        operating,
        claimed: claimed.flatMap((draft) =>
          draft.value ? [[draft.box.x, draft.box.y] as [number, number]] : [],
        ),
      },
      makeNerRunner(sessionId),
    );
  } catch (err) {
    // Recorded, not swallowed. A layer that fails silently costs its full latency and
    // produces nothing, which is indistinguishable from a layer that ran and found
    // nothing -- and that is exactly how this shipped once: 1.7 s a step, 340 MB of
    // heap, zero findings, and no way to tell from the outside.
    lastSemanticError = err instanceof Error ? err.message : String(err);
    return [];
  }
}

/** Why L2 produced nothing, when it produced nothing because it broke. */
let lastSemanticError: string | null = null;

export function semanticError(): string | null {
  return lastSemanticError;
}

/** Why L3 produced nothing, on the same terms. */
let lastFaceError: string | null = null;

export function faceError(): string | null {
  return lastFaceError;
}

/**
 * Is there anywhere on this page a photograph could be?
 *
 * The same shape of gate `opaqueRegions` uses, for the same reason: running a 640x640 model
 * on every step of every text form spends the latency budget to find nothing, and the p95
 * target is 3.5 s. Sides rather than area, because a 2000x1 tracking pixel has plenty of
 * area and no face in it.
 */
function hasPhotographShapedRegion(elements: ObservedElement[]): boolean {
  return elements.some((el) => {
    const tag = el.tag.toLowerCase();
    if (tag !== 'img' && tag !== 'canvas' && tag !== 'video') return false;
    return el.box.w >= MIN_OCR_SIDE && el.box.h >= MIN_OCR_SIDE;
  });
}

/**
 * L3: faces, over the whole frame, when the page has somewhere to hide one.
 */
async function detectFaces(
  elements: ObservedElement[],
  viewport: Viewport,
  sessionId: string,
  frame: FrameRef | undefined,
): Promise<FindingDraft[]> {
  lastFaceError = null;
  if (!frame || !hasPhotographShapedRegion(elements)) return [];

  try {
    const reply = await send(
      'INFER',
      { task: 'face', sessionId, frame, viewport },
      { to: 'offscreen' },
    );
    if (reply.task !== 'face') return [];

    return reply.boxes.map((box, i) => ({
      cls: 'FACE' as const,
      box,
      layer: 'L3' as const,
      confidence: reply.scores[i] ?? 0,
      reason: 'face',
      boxKind: 'element' as const,
    }));
  } catch (err) {
    lastFaceError = err instanceof Error ? err.message : String(err);
    return [];
  }
}

/** Why L3 OCR produced nothing, on the same terms. */
let lastOcrError: string | null = null;

export function ocrError(): string | null {
  return lastOcrError;
}

/**
 * Turn OCR lines into throwaway ObservedElements the deterministic and semantic layers
 * can scan.
 *
 * These never leave detect(): they are not DOM nodes, carry no handle the planner could
 * use, and are gone the moment the drafts are built. They exist only so L1 and L2 -- which
 * read `textRuns` and `rawValue`, not pixels -- can run over recovered text with no special
 * casing. The whole line is one run at the line's own box, because that is the only
 * geometry OCR gives us: a baked-in glyph has no per-character rect the way a DOM range
 * does.
 *
 * `fromPixels` marks the provenance. `index` is a *local* join key (the line's position),
 * used only to read the OCR confidence back in decorateOcr and stripped there before these
 * drafts meet a real element index -- see the note in decorateOcr.
 *
 * Coordinate space: `line.box` is already CSS px of the visual viewport. The offscreen OCR
 * task mapped detector output through the frame's own scale once (invariant 2); this code
 * copies that box through untouched and introduces no second conversion.
 */
export function buildOcrElements(lines: OcrLine[]): ObservedElement[] {
  const elements: ObservedElement[] = [];

  lines.forEach((line, index) => {
    const text = line.text;
    if (!text.trim()) return;

    elements.push({
      index,
      role: 'text',
      box: line.box,
      state: { visible: true, enabled: true, focused: false, filled: false },
      occluded: 0,
      isNew: false,
      tag: 'text',
      textRuns: [{ text, box: line.box, nodeIndex: 0 }],
      key: `ocr:${index}`,
      name: text,
      fromPixels: true,
    });
  });

  return elements;
}

/**
 * Re-stamp OCR drafts as L3, and blend in the recognition confidence.
 *
 * `layer: 'L3'` because a Verhoeff-valid Aadhaar read from pixels is still only as certain
 * as the read: L1's checksum says the digits form a valid Aadhaar, `line.score` says the
 * OCR probably got the digits right, and the finding is worth the lower of those two
 * certainties, not L1's alone.
 *
 * `elementIndex` is stripped to undefined. It was a join key into `lines` (set by
 * buildOcrElements, carried through by detectLexical/detectEntities) and is read here, once,
 * to recover the score -- but it is not a DOM handle. Leaving it on would make an OCR draft
 * collide with a real element of the same index in dedupeDrafts' sameElement test and in
 * detect()'s elementOf map. Stripped, these findings dedupe by region like any other
 * text block, which is exactly what a run of baked-in text is.
 */
function decorateOcr(drafts: FindingDraft[], lines: OcrLine[]): FindingDraft[] {
  return drafts.map((draft) => {
    const line = draft.elementIndex !== undefined ? lines[draft.elementIndex] : undefined;
    const score = line?.score ?? 0;
    return {
      ...draft,
      layer: 'L3' as const,
      boxKind: 'text' as const,
      reason: `ocr:${draft.reason}`,
      confidence: score > 0 ? (draft.confidence + score) / 2 : draft.confidence,
      elementIndex: undefined,
    };
  });
}

/**
 * The detection half of L3 OCR: recovered text through L1 and L2, node-pure.
 *
 * Split from the bus adapter (detectOcr) so the wiring that matters for privacy -- that
 * OCR text is scanned for PII rather than shipped, and that a name in an image reaches the
 * model -- is testable with a fake NerRunner and no browser, the same way ner.ts tests its
 * arithmetic.
 *
 * L1 and L2 run over the same lines. L2 gets its own try/catch: a model that will not load
 * (no GPU, a missing file) must cost the names and addresses only a model can find in an
 * image, never the checksummed Aadhaar or card L1 already recovered. No `claimed` is passed
 * -- where L1 and L2 fire on the same line their boxes are the line's box, so dedupeDrafts
 * merges them downstream and the class is arbitrated once, which is cheaper than mapping L1
 * spans into the model's document coordinates to suppress a duplicate the merge removes
 * anyway.
 */
export async function ocrFindings(
  lines: OcrLine[],
  viewport: Viewport,
  operating: Operating,
  ner: NerRunner,
): Promise<{ drafts: FindingDraft[]; nerError: string | null }> {
  const elements = buildOcrElements(lines);
  if (elements.length === 0) return { drafts: [], nerError: null };

  const lexical = detectLexical(elements, viewport);

  let semantic: FindingDraft[] = [];
  let nerError: string | null = null;
  try {
    semantic = (await detectEntities({ elements, operating }, ner)).filter(semanticIsPlausible);
  } catch (err) {
    nerError = err instanceof Error ? err.message : String(err);
  }

  return { drafts: decorateOcr([...lexical, ...semantic], lines), nerError };
}

/**
 * L3: OCR over the DOM-opaque regions invariant 9 names (images, canvases, videos,
 * iframes).
 *
 * The bus half lives here -- guard on there being an opaque region at all, ask the
 * offscreen host to read the frame -- and the detection half is `ocrFindings`, kept
 * node-pure so the L1/L2 wiring can be tested without a model or a browser.
 *
 * Recognised text is scanned by L1 (a Verhoeff-valid Aadhaar or a Luhn-valid card baked
 * into a scanned ID is exactly as sensitive as one typed into a field) and by L2 (a name
 * or address no pattern will catch), so it is detected and redacted before the frame is
 * sealed rather than shipped in the clear. A NER failure inside ocrFindings surfaces as
 * lastOcrError but does not lose the L1 findings.
 */
async function detectOcr(
  elements: ObservedElement[],
  viewport: Viewport,
  sessionId: string,
  operating: Operating,
  frame: FrameRef | undefined,
): Promise<FindingDraft[]> {
  lastOcrError = null;
  const regions = opaqueRegions(elements);
  if (!frame || regions.length === 0) return [];

  try {
    const reply = await send(
      'INFER',
      {
        task: 'ocr',
        sessionId,
        frame,
        regions: regions.map((r) => r.box),
        viewport,
      },
      { to: 'offscreen' },
    );
    if (reply.task !== 'ocr') return [];

    const { drafts, nerError } = await ocrFindings(
      reply.lines,
      viewport,
      operating,
      makeNerRunner(sessionId),
    );
    lastOcrError = nerError;
    return drafts;
  } catch (err) {
    lastOcrError = err instanceof Error ? err.message : String(err);
    return [];
  }
}

export async function detect(
  elements: ObservedElement[],
  viewport: Viewport,
  sessionId: string,
  operating: Operating = 'highPrecision',
  /** The captured frame, for the pixel layers. Absent means L3 does not run. */
  frame?: FrameRef,
): Promise<DetectResult> {
  const deterministic = runDeterministicLayers(elements, viewport);

  // L2 last, and only over text the deterministic layers did not already claim. A model
  // guess is worth less than a checksum everywhere the two overlap, and running it over
  // ground L1 has covered spends latency to produce duplicates.
  const semantic = (await detectSemantic(elements, deterministic, operating, sessionId)).filter(
    semanticIsPlausible,
  );

  // L3 reads pixels, not the text the other layers claimed, so there is no overlap to
  // avoid and no ordering to respect -- only the gate, which keeps it off pages with
  // nowhere for a photograph to be.
  const faces = await detectFaces(elements, viewport, sessionId, frame);
  const ocr = await detectOcr(elements, viewport, sessionId, operating, frame);

  const { drafts, resolution } = resolveContainers(
    dedupeDrafts([...deterministic, ...semantic, ...faces, ...ocr]),
    elements,
  );

  const findings: Finding[] = [];
  const values = new Map<string, string>();
  const elementOf = new Map<string, number>();
  const boxKinds: Record<string, 'element' | 'text'> = {};

  for (const draft of drafts) {
    const finding = makeFinding(draft);
    findings.push(finding);
    if (draft.value !== undefined && draft.value !== '') values.set(finding.id, draft.value);
    if (draft.elementIndex !== undefined) elementOf.set(finding.id, draft.elementIndex);
    // resolveContainers has already run, so 'container' cannot reach here -- the cast
    // is the type system catching up with an invariant enforced above.
    boxKinds[finding.id] = (draft.boxKind ?? 'element') as 'element' | 'text';
  }

  const placeholders = new Map<string, string>();
  if (values.size > 0) {
    const items = findings
      .filter((f) => values.has(f.id))
      .map((f) => ({ id: f.id, cls: f.cls, value: values.get(f.id) ?? '' }));

    const reply = await send('PLACEHOLDER_ALLOCATE', { sessionId, items }, { to: 'offscreen' });
    for (const [id, token] of Object.entries(reply.placeholders)) placeholders.set(id, token);

    // A value found on the page that the operator had already typed into the task box is
    // theirs, whoever put it in the field. The allocator is the only thing that can say
    // so -- it holds the value-to-token map and this process holds no such history -- and
    // the answer arrives as ids rather than values, so nothing sensitive comes back.
    for (const id of reply.fromUser ?? []) {
      const at = findings.findIndex((f) => f.id === id);
      const finding = findings[at];
      if (finding) findings[at] = { ...finding, origin: 'user' };
    }
  }

  return {
    findings,
    values,
    placeholders,
    elementOf,
    boxKinds,
    containers: resolution,
    semanticError: semanticError(),
    faceError: faceError(),
    ocrError: ocrError(),
  };
}
