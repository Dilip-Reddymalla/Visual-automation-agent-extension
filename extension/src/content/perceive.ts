/**
 * The nine steps, in order, in one place.
 *
 *   traverse -> filter -> score -> occlusion -> collapse -> index -> diff -> observe
 *
 * Everything the browser provides arrives through `PerceiveEnv`. That is what lets the
 * whole pipeline run under jsdom, which has no layout engine and no hit-testing: the
 * tests supply boxes and probes directly and assert on the ordering, the collapsing and
 * the diff, which is where the bugs actually are.
 *
 * Timing: there is none here. The router already measures the perceive phase
 * (worker/router.ts) and offscreen/timings.ts owns the model clock. A third mechanism
 * would just be a third number to disagree with the other two.
 */

import { containment, type Box, type Viewport } from '../shared/coords';
import type { ObservedElement, TextRun } from '../shared/observed';
import {
  accessibleName,
  associatedLabelText,
  isLabelProxy,
  isValidationRelevant,
  isVisible,
  nearbyLabelText,
  normaliseSpace,
  resolveIdRefs,
  roleOf,
  scoreInteractivity,
  stateOf,
  type StyleLike,
} from './interactivity';
import { documentHitTest, isOccluded, occlusionFraction, type HitTest } from './occlusion';
import { isOverlayHost } from './overlay';
import { typedByAgent } from './executor';
import { domPath, walk, type DomEl, type RawNode, type WalkOptions } from './walker';

/** A candidate at least this far inside another one is a part of it, not a peer. */
export const CONTAINMENT_COLLAPSE = 0.9;

/** Rects whose origins are within this many CSS px count as the same row. */
const ROW_TOLERANCE = 12;

/**
 * How many text-bearing blocks one walk will emit.
 *
 * A prose-heavy page has hundreds. Emitting all of them explodes both the walk and the
 * request payload, and trades a fifth of the marks for a sixth. When the cap bites the
 * smallest blocks go first -- a two-word caption is far less likely to hold an
 * identifier than a paragraph -- and the count of what was dropped goes in the trace,
 * because a silent truncation is a silent recall loss.
 */
export const TEXT_BLOCK_CAP = 120;

/** Below this many CSS px^2 a text block is a bullet, a dash or an icon caption. */
export /**
 * Smallest side of a visual element worth reporting, in CSS px.
 *
 * Mirrors `MIN_OCR_SIDE` in offscreen/tasks/ocr.ts, which is where the same judgement is
 * made about what is worth reading. Sides rather than area: a 2000x1 tracking pixel has
 * plenty of area and nothing in it.
 */
const MIN_VISUAL_SIDE = 48;

/** Tags whose content is pixels. The DOM can say one is here and not what is in it. */
function isVisualTag(el: DomEl): boolean {
  const tag = el.tagName.toLowerCase();
  return tag === 'img' || tag === 'canvas' || tag === 'video';
}

function visualRole(el: DomEl): 'image' | 'canvas' | 'video' {
  const tag = el.tagName.toLowerCase();
  return tag === 'canvas' ? 'canvas' : tag === 'video' ? 'video' : 'image';
}

const TEXT_BLOCK_MIN_AREA = 240;

export interface PerceiveEnv {
  doc: Document;
  viewport: Viewport;
  measure(el: DomEl): Box;
  /**
   * The rect a text node actually inks, via a Range.
   *
   * Separate from `measure` because it takes a text node, and optional because jsdom has
   * no layout to measure with -- the tests supply geometry through `measure` and get the
   * element rect, which is the honest answer when there is no layout engine.
   */
  measureText?(node: ChildNode): Box | undefined;
  /**
   * Has this extension typed into that node?
   *
   * Injected rather than imported so this module stays node-pure and the set stays where
   * it belongs -- with the executor that filled it. Absent in tests, which means "we typed
   * nothing", and that is the right answer for a walk with no executor behind it.
   */
  typedByAgent?(el: DomEl): boolean;
  style(el: DomEl): StyleLike;
  hitTest: HitTest;
  /** Keys from the previous step. Anything not in here is marked `*`. */
  previousKeys?: ReadonlySet<string>;
  walkOptions?: WalkOptions;
}

export interface PerceiveResult {
  observed: ObservedElement[];
  /** index -> live node. Never leaves the content script.  */
  handles: Map<number, DomEl>;
  keys: Set<string>;
  /** Text blocks the cap discarded. Non-zero means recall was traded for payload. */
  textBlocksDropped: number;
}

interface Candidate {
  node: RawNode;
  style: StyleLike;
  role: ReturnType<typeof roleOf>;
  name: string;
  reason: string;
  occluded: number;
  /** Kept although off-screen, so there is nothing for the hit test to find. */
  exemptFromHitTest?: boolean;
  /**
   * Admitted for what it says rather than what it does. Gets no index: it is not
   * clickable, and handing the planner a number it cannot act on invites it to try.
   */
  textOnly?: boolean;
}

export function perceive(env: PerceiveEnv): PerceiveResult {
  // 1. Traverse.
  const nodes = walk(env.doc, { measure: env.measure, ...env.walkOptions });

  // 2 and 3. Filter for visibility, score interactivity.
  const scored: Candidate[] = [];
  for (const node of nodes) {
    // Never perceive our own overlay. The next walk has to find what the last one
    // found, and an overlay that showed up in its own snapshot would not be a mirror.
    if (isOverlayHost(node.el)) continue;

    const style = env.style(node.el);
    const visible = isVisible(node, style);
    const keepHidden = !visible && isValidationRelevant(node.el);
    if (!visible && !keepHidden) continue;

    // Something we cannot see into is worth reporting even though it is not clickable.
    if (node.opaque) {
      scored.push({
        node,
        style,
        role: 'other',
        name: accessibleName(node.el),
        reason: 'closed-shadow-root',
        occluded: 0,
      });
      continue;
    }

    // An alert or an aria-invalid field is kept whether or not it is clickable. After
    // a failed submit it is the most useful thing on the page, and an agent that
    // cannot see it retries a form it has already filled.
    const validation = isValidationRelevant(node.el);
    // Only fetched when it can change the answer: one extra getComputedStyle per
    // pointer-cursor candidate, rather than one per node.
    const parentCursor =
      style.cursor === 'pointer' && node.el.parentElement
        ? env.style(node.el.parentElement).cursor
        : undefined;
    const verdict = scoreInteractivity(node.el, style, node.box, parentCursor);

    // The fourth admission class: pixels the DOM cannot describe.
    //
    // An `<img>`, a `<canvas>`, a `<video>` -- not clickable and carrying no text, so
    // neither of the classes below admits one, and until M5c-A none of them reached the
    // element list at all. That was not a small gap. It is the difference between an
    // agent that works on a form and one that works on a scanned certificate, a challan
    // or a KYC page, and the whole L3 layer reads this list to decide where to look: face
    // detection gated on "is there an <img> here?" could never fire, because the <img> was
    // not there to find.
    //
    // No index, deliberately, matching what the contract has always said about visual-only
    // elements: there is no integer for a plan to name one by, they are reachable by
    // coordinate, and `markable` skips them for exactly that reason.
    if (!verdict.interactive && !validation && isVisualTag(node.el)) {
      if (verdict.reason === 'aria-hidden') continue;
      if (node.el.closest?.('[aria-hidden="true"]')) continue;
      if (!intersectsViewport(node.box, env.viewport)) continue;
      // Below this it is an icon, a spacer or a tracking pixel: nothing a face or a line
      // of text could be hiding in, and a list full of them costs bytes on the wire.
      if (node.box.w < MIN_VISUAL_SIDE || node.box.h < MIN_VISUAL_SIDE) continue;

      scored.push({
        node,
        style,
        role: visualRole(node.el),
        name: accessibleName(node.el),
        reason: 'visual',
        occluded: 0,
        textOnly: true,
      });
      continue;
    }

    // The third admission class. Perception was built for actionable elements, which
    // left a read-only page -- a profile, a passbook, a policy summary -- reporting two
    // elements and producing no findings at all while carrying a dozen identifiers.
    // Measured across the corpus: recall 0.175, and essentially every miss was this.
    if (!verdict.interactive && !validation) {
      // A page saying "this is not content" is as binding here as it is for clicking.
      // Without this an aria-hidden control re-enters through the text door.
      if (verdict.reason === 'aria-hidden') continue;
      if (node.el.closest?.('[aria-hidden="true"]')) continue;
      // A <label for=...> is not a value, and its text already reaches the detectors as
      // the input's labelText. Emitting it again would add a second box over a caption
      // -- which is precisely the container-shaped over-redaction this module is fixing.
      if (isLabelProxy(node.el)) continue;
      if (!hasOwnText(node.el)) continue;
      if (!intersectsViewport(node.box, env.viewport)) continue;
      if (node.box.w * node.box.h < TEXT_BLOCK_MIN_AREA) continue;

      scored.push({
        node,
        style,
        role: isHeading(node.el) ? 'heading' : 'text',
        name: accessibleName(node.el),
        reason: 'text-bearing',
        occluded: 0,
        textOnly: true,
      });
      continue;
    }

    if (!intersectsViewport(node.box, env.viewport) && !keepHidden) continue;

    scored.push({
      node,
      style,
      role: roleOf(node.el),
      name: accessibleName(node.el),
      reason: verdict.interactive ? verdict.reason : 'validation',
      occluded: 0,
      // Not on screen yet: there is nothing to hit-test against.
      exemptFromHitTest: keepHidden,
    });
  }

  // 4. Occlusion. A hidden-but-validation-relevant element is not hit-testable, so it
  // is exempt: it is being kept precisely because it is not on screen yet.
  const visible = scored.filter((c) => {
    if (c.exemptFromHitTest) return true;
    if (c.node.box.w <= 0 || c.node.box.h <= 0) return true;
    c.occluded = occlusionFraction(c.node.el, c.node.box, {
      hitTest: env.hitTest,
      viewport: env.viewport,
    });
    return !isOccluded(c.occluded);
  });

  // 5. Collapse containment.
  const collapsed = collapseContained(visible);

  // 5b. Cap the prose. See TEXT_BLOCK_CAP.
  const { kept, dropped } = capTextBlocks(collapsed);

  // 6. Index in paint order.
  const ordered = [...kept].sort(byPaintOrder);

  // 7 and 8. Diff, then observe.
  const previous = env.previousKeys ?? new Set<string>();
  const handles = new Map<number, DomEl>();
  const keys = new Set<string>();
  const observed: ObservedElement[] = [];

  // Indices number the actionable elements only, and count only those. A text block
  // gets no index: it cannot be clicked, and a number the planner cannot act on is an
  // invitation to try. It is still reachable by coordinate, which is what the schema's
  // optional index is for.
  let index = 0;
  for (const candidate of ordered) {
    const key = stableKey(candidate);
    keys.add(key);

    if (candidate.textOnly) {
      observed.push(observeElement(candidate, undefined, key, !previous.has(key), env));
      continue;
    }

    index += 1;
    handles.set(index, candidate.node.el);
    observed.push(observeElement(candidate, index, key, !previous.has(key), env));
  }

  return { observed, handles, keys, textBlocksDropped: dropped };
}

// -- The survey -----------------------------------------------------------------

/**
 * Every control in the whole document, whether or not it is on screen.
 *
 * ## The bug this exists for
 *
 * `perceive` filters every admission class through `intersectsViewport`, and it is right
 * to: what leaves this machine is a screenshot of the visual viewport, and a box outside
 * that frame cannot be redacted in it. But the same list is what `resolve.ts` scores the
 * user's sentence against -- and so "fill first name with leo" worked or did not work
 * depending on where the operator happened to have left the scrollbar. Scrolled to the
 * form: tier 0, filled, done. Scrolled two screens down: `below-floor`, escalated, and on
 * a laptop with no planner running, `failed at plan`. Same page, same sentence, same
 * build, opposite outcomes. The agent could not see a field that was four hundred pixels
 * above it.
 *
 * The survey answers one question -- *where is the thing the user named* -- over the whole
 * document. The worker scores it, asks for the winner to be scrolled into view, and then
 * perceives normally. Every action still comes from a real in-viewport walk, so the
 * redaction guarantee is untouched: the survey never produces an index anyone acts on and
 * never reaches the gate.
 *
 * ## What it deliberately leaves out
 *
 * Controls only. No text blocks, no images, no occlusion test, no cap. And no values:
 * `observeElement` reads `input.value` into `rawValue`, which is the single most sensitive
 * string in the project, and a whole-document sweep of every field's contents is not
 * something this feature needs in order to find a label. Locating is not perceiving, and
 * the list is stripped to the attributes the scorer actually reads.
 *
 * Occlusion is skipped rather than forgotten. `occlusionFraction` hit-tests at viewport
 * coordinates; for an element two screens down those coordinates address something else
 * entirely, so the honest answer for an off-screen element is "not applicable" rather than
 * a number that looks measured.
 */
export interface SurveyResult {
  /** One per control, in document order. Indices are local to this list. */
  elements: ObservedElement[];
  /** Stable key to live node, so the winner can be scrolled into view. */
  nodes: Map<string, DomEl>;
}

export function survey(env: PerceiveEnv): SurveyResult {
  const nodes = walk(env.doc, { measure: env.measure, ...env.walkOptions });
  const elements: ObservedElement[] = [];
  const byKey = new Map<string, DomEl>();

  let index = 0;
  for (const node of nodes) {
    if (isOverlayHost(node.el)) continue;

    const style = env.style(node.el);
    // Style visibility still applies. A `display: none` field is not somewhere to scroll
    // to, it is somewhere that does not exist, and offering to reveal it would be a
    // promise the page cannot keep.
    if (!isVisible(node, style)) continue;

    const verdict = scoreInteractivity(node.el, style, node.box);
    if (!verdict.interactive) continue;
    if (node.el.closest?.('[aria-hidden="true"]')) continue;

    const candidate: Candidate = {
      node,
      style,
      role: roleOf(node.el),
      name: accessibleName(node.el),
      reason: verdict.reason,
      occluded: 0,
    };

    const key = stableKey(candidate);
    index += 1;
    byKey.set(key, node.el);
    elements.push(strip(observeElement(candidate, index, key, false, env)));
  }

  return { elements, nodes: byKey };
}

/**
 * Drop everything the scorer does not read.
 *
 * Belt and braces over the comment above: if `observeElement` grows a new field carrying
 * page content, this list is what stops it reaching a whole-document sweep by default.
 */
function strip(observed: ObservedElement): ObservedElement {
  const { rawValue: _value, selectedText: _selected, ...rest } = observed;
  return { ...rest, textRuns: [], state: { ...rest.state, filled: false } };
}

/**
 * A candidate almost entirely inside another, with no accessible name of its own, is
 * that other one. Without this a card with a heading, a link and an image renders as
 * four entries; the list triples in size and the planner has four ways to say one thing.
 */
export function collapseContained(candidates: Candidate[]): Candidate[] {
  return candidates.filter((inner) => {
    return !candidates.some((outer) => {
      if (outer === inner) return false;
      if (outer.node.el === inner.node.el) return false;
      // Only collapse into a genuine ancestor: two overlapping siblings are two things.
      if (!outer.node.el.contains(inner.node.el)) return false;
      if (containment(inner.node.box, outer.node.box) < CONTAINMENT_COLLAPSE) return false;
      // A distinct accessible name earns its own entry, however nested it is.
      const distinct = inner.name !== '' && inner.name !== outer.name;
      return !distinct;
    });
  });
}

/** Top to bottom, then left to right, with a tolerance so one row stays one row. */
function byPaintOrder(a: Candidate, b: Candidate): number {
  const dy = a.node.box.y - b.node.box.y;
  if (Math.abs(dy) > ROW_TOLERANCE) return dy;
  const dx = a.node.box.x - b.node.box.x;
  if (dx !== 0) return dx;
  return a.node.depth - b.node.depth;
}

/**
 * Does this element have text of its OWN, rather than text somewhere beneath it?
 *
 * Own-text is the whole trick. `textContent` is true of every ancestor up to <body>, so
 * admitting on it would emit a paragraph, its wrapping div, that div's section, and the
 * main element -- four boxes for one sentence, each larger and less useful than the
 * last. Direct text-node children emit the block that actually holds the words.
 */
export function hasOwnText(el: DomEl): boolean {
  for (const child of el.childNodes) {
    if (child.nodeType !== 3) continue; // Node.TEXT_NODE
    if ((child.textContent ?? '').trim() !== '') return true;
  }
  return false;
}

function isHeading(el: DomEl): boolean {
  return /^H[1-6]$/.test(el.tagName);
}

/**
 * Apply the text-block cap: smallest first, document order preserved among survivors.
 *
 * Smallest-first because area is the best cheap proxy for how much a block can hold. A
 * caption of two words is far less likely to carry an identifier than a paragraph, and
 * when something has to go it should be the one with least in it.
 */
export function capTextBlocks(
  candidates: Candidate[],
  cap: number = TEXT_BLOCK_CAP,
): { kept: Candidate[]; dropped: number } {
  const text = candidates.filter((c) => c.textOnly);
  if (text.length <= cap) return { kept: candidates, dropped: 0 };

  const byArea = [...text].sort(
    (a, b) => b.node.box.w * b.node.box.h - a.node.box.w * a.node.box.h,
  );
  const survivors = new Set(byArea.slice(0, cap));
  return {
    kept: candidates.filter((c) => !c.textOnly || survivors.has(c)),
    dropped: text.length - cap,
  };
}

function intersectsViewport(box: Box, vp: Viewport): boolean {
  return box.x < vp.w && box.y < vp.h && box.x + box.w > 0 && box.y + box.h > 0;
}

/**
 * Identity that survives a re-render. Not the index -- that renumbers whenever the page
 * reflows -- and not the DOM node, which React replaces wholesale. Tag, role, name and
 * a normalised path together are stable enough that a no-op re-perceive marks nothing
 * as new, which is what acceptance criterion 8 asks for.
 */
export function stableKey(candidate: Candidate): string {
  const { el } = candidate.node;
  const frame = candidate.node.framePath;
  return [
    frame,
    el.tagName.toLowerCase(),
    candidate.role,
    normaliseSpace(candidate.name).slice(0, 60),
    domPath(el),
  ].join('|');
}

function observeElement(
  candidate: Candidate,
  index: number | undefined,
  key: string,
  isNew: boolean,
  env: PerceiveEnv,
): ObservedElement {
  const el = candidate.node.el;
  const input = el as HTMLInputElement;
  const observed: ObservedElement = {
    role: candidate.role,
    box: candidate.node.box,
    state: stateOf(el, candidate.style),
    occluded: candidate.occluded,
    isNew,
    tag: el.tagName.toLowerCase(),
    key,
    name: candidate.name,
    textRuns: textRuns(el, env),
  };

  if (index !== undefined) observed.index = index;

  // A wrapper's rect covers its caption too. Record what the control alone occupies, so
  // a finding can be attributed to the value rather than to the row it sits in.
  if (candidate.reason === 'wraps-control') {
    const control = el.querySelector('input, select, textarea');
    if (control) observed.controlBox = env.measure(control);
  }
  if (candidate.node.framePath) observed.frame = candidate.node.framePath;
  if (candidate.node.opaque) observed.opaque = true;
  if (env.typedByAgent?.(el)) observed.agentTyped = true;

  // The attributes L0 sniffs. Recorded raw, and never projected onto the wire.
  copyAttr(el, 'type', observed, 'inputType');
  copyAttr(el, 'autocomplete', observed, 'autocomplete');
  copyAttr(el, 'inputmode', observed, 'inputMode');
  copyAttr(el, 'name', observed, 'nameAttr');
  copyAttr(el, 'id', observed, 'idAttr');
  copyAttr(el, 'placeholder', observed, 'placeholder');
  copyAttr(el, 'aria-label', observed, 'ariaLabel');
  copyAttr(el, 'pattern', observed, 'pattern');
  copyAttr(el, 'href', observed, 'href');
  copyAttr(el, 'alt', observed, 'alt');

  const label = associatedLabelText(el);
  if (label) observed.labelText = label;

  // Only when the page declared nothing. A caption inferred from layout is a fallback for
  // a broken form, not a second opinion on a working one.
  if (!label && !observed.ariaLabel) {
    const nearby = nearbyLabelText(el);
    if (nearby) observed.nearbyText = nearby;
  }

  const describedBy = resolveIdRefs(el, 'aria-describedby');
  if (describedBy) observed.ariaDescribedByText = describedBy;

  if (candidate.style.textSecurity && candidate.style.textSecurity !== 'none') {
    observed.textSecurity = candidate.style.textSecurity;
  }

  const maxLength = el.getAttribute('maxlength');
  if (maxLength !== null) {
    const parsed = Number.parseInt(maxLength, 10);
    if (Number.isFinite(parsed) && parsed >= 0) observed.maxLength = parsed;
  }

  if (isValueBearing(el)) {
    const value = input.value ?? '';
    if (value !== '') {
      observed.rawValue = value;
      // The one fact about the value that crosses the wire.
      observed.state.filled = true;
    }
  }

  if (el.tagName === 'SELECT') {
    const select = el as unknown as HTMLSelectElement;
    observed.optionCount = select.options?.length ?? el.querySelectorAll('option').length;
    const selected =
      select.selectedIndex >= 0 ? select.options?.[select.selectedIndex] : undefined;
    const text = normaliseSpace(selected?.textContent ?? '');
    if (text) observed.selectedText = text;
  }

  return observed;
}

function isValueBearing(el: DomEl): boolean {
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
}

function copyAttr(
  el: DomEl,
  attr: string,
  target: ObservedElement,
  field: keyof ObservedElement,
): void {
  const value = el.getAttribute(attr);
  if (value === null || value === '') return;
  (target as unknown as Record<string, unknown>)[field] = value;
}

/**
 * The element's own text nodes, each with a box. L2 concatenates the text, runs NER
 * over it, and needs to turn a character offset back into pixels; these are the only
 * thing that makes that possible.
 */
export function textRuns(el: DomEl, env: PerceiveEnv): TextRun[] {
  const runs: TextRun[] = [];
  let nodeIndex = 0;

  for (const child of el.childNodes) {
    if (child.nodeType !== 3) continue; // Node.TEXT_NODE
    const text = normaliseSpace(child.textContent ?? '');
    const at = nodeIndex;
    nodeIndex += 1;
    if (!text) continue;

    // The glyphs, not the block that contains them. This used to return the element's
    // own rect, which made every run box identical to its element's -- so narrowing a
    // container to "the run that holds the value" narrowed it to exactly the same
    // rectangle, and a `<dd>` spanning a whole row was painted whole. A Range around the
    // text node is the only thing that measures what is actually inked.
    const box = env.measureText?.(child) ?? env.measure(el);
    runs.push({ text, box, nodeIndex: at });
  }

  return runs;
}

/** The real environment, assembled from the live document. */
export function browserEnv(
  doc: Document,
  win: Window,
  previousKeys?: ReadonlySet<string>,
): PerceiveEnv {
  return {
    doc,
    viewport: {
      w: win.visualViewport?.width ?? win.innerWidth,
      h: win.visualViewport?.height ?? win.innerHeight,
    },
    measure: (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    },
    typedByAgent,
    style: (el) => {
      const s = win.getComputedStyle(el);
      return {
        display: s.display,
        visibility: s.visibility,
        opacity: s.opacity,
        cursor: s.cursor,
        textSecurity: s.getPropertyValue('-webkit-text-security'),
      };
    },
    // documentHitTest, not elementFromPoint directly: the plain API stops at a shadow
    // host, so every element inside an open shadow root would be reported as covered
    // by the very component it belongs to, and dropped.
    hitTest: documentHitTest(doc),
    previousKeys,
  };
}
