import { describe, it, expect } from 'vitest';
import { dedupeDrafts, resolveContainers, ocrFindings } from './detect';
import { makeFinding, type FindingDraft } from '../redaction/findings';
import type { ObservedElement } from '../shared/observed';
import type { OcrLine } from '../shared/messages';
import type { NerRunner } from '../offscreen/tasks/ner';

describe('containers are never painted', () => {
  const el = (over: Partial<ObservedElement> = {}): ObservedElement => ({
    role: 'text',
    box: { x: 10, y: 10, w: 400, h: 40 },
    state: { visible: true, enabled: true, focused: false, filled: false },
    occluded: 0,
    isNew: false,
    tag: 'dd',
    key: 'k',
    name: 'n',
    textRuns: [],
    ...over,
  });

  it('narrows a container to the run that holds the value', () => {
    // A <dd> spans the row it sits in. Painting that box blacks out the <dt> beside it
    // as well, and across the corpus container-shaped boxes were about half of all
    // over-redaction.
    const tight = { x: 200, y: 14, w: 120, h: 18 };
    const { drafts, resolution } = resolveContainers(
      [
        {
          cls: 'AADHAAR',
          box: { x: 10, y: 10, w: 400, h: 40 },
          boxKind: 'container',
          layer: 'L1',
          confidence: 0.98,
          reason: 'verhoeff-ok',
          value: '919442736092',
          elementIndex: undefined,
        },
      ],
      [el({ textRuns: [{ text: '919442736092', box: tight, nodeIndex: 0 }] })],
    );

    expect(drafts[0]?.box).toEqual(tight);
    expect(drafts[0]?.boxKind).toBe('text');
    expect(resolution).toEqual({ resolved: 1, dropped: 0 });
  });

  it('drops a container it cannot narrow, rather than painting it', () => {
    // A box we cannot justify is worse than a miss we can count: the miss shows up in
    // recall, the box shows up as a page with a hole in it and no explanation.
    const { drafts, resolution } = resolveContainers(
      [
        {
          cls: 'ADDRESS',
          box: { x: 10, y: 10, w: 400, h: 40 },
          boxKind: 'container',
          layer: 'L0',
          confidence: 0.8,
          reason: 'autocomplete',
        },
      ],
      [el({ textRuns: [] })],
    );

    expect(drafts).toHaveLength(0);
    expect(resolution).toEqual({ resolved: 0, dropped: 1 });
  });

  it('leaves element and text boxes alone', () => {
    const input = [
      {
        cls: 'EMAIL' as const,
        box: { x: 1, y: 1, w: 2, h: 2 },
        boxKind: 'element' as const,
        layer: 'L0' as const,
        confidence: 0.9,
        reason: 'autocomplete',
      },
      {
        cls: 'PHONE' as const,
        box: { x: 3, y: 3, w: 4, h: 4 },
        boxKind: 'text' as const,
        layer: 'L1' as const,
        confidence: 0.9,
        reason: 'mobile',
      },
    ];
    const { drafts, resolution } = resolveContainers(input, []);

    expect(drafts).toEqual(input);
    expect(resolution).toEqual({ resolved: 0, dropped: 0 });
  });
});

/**
 * The panel was showing four manifest rows for two boxes.
 *
 * A w3schools contact form, First Name and Last Name, both holding an email address --
 * because the agent had typed one into each. L0 read the labels and said PERSON twice;
 * L1 read the values and said EMAIL twice; dedupe required the classes to match, so all
 * four survived. Two classes for one field, and the planner handed «PERSON_1» for
 * something that is not a person.
 */
describe('two layers, one element, one class', () => {
  const box = { x: 40, y: 100, w: 300, h: 30 };

  const label = (over: Partial<FindingDraft> = {}): FindingDraft => ({
    cls: 'PERSON',
    box,
    layer: 'L0',
    confidence: 0.8,
    reason: 'label-person',
    elementIndex: 3,
    ...over,
  });

  const validated = (over: Partial<FindingDraft> = {}): FindingDraft => ({
    cls: 'EMAIL',
    box,
    layer: 'L1',
    confidence: 0.8,
    reason: 'email-shape',
    elementIndex: 3,
    value: 'applicant@example.in',
    ...over,
  });

  it('keeps one draft, not one per class', () => {
    expect(dedupeDrafts([label(), validated()])).toHaveLength(1);
  });

  it('classes it by what the box holds, not by what the label says', () => {
    // Both orders, because dedupe walks the list once and must not depend on which
    // detector happened to run first.
    expect(dedupeDrafts([label(), validated()])[0]?.cls).toBe('EMAIL');
    expect(dedupeDrafts([validated(), label()])[0]?.cls).toBe('EMAIL');
  });

  it('records the opinion it overruled', () => {
    expect(dedupeDrafts([label(), validated()])[0]?.reason).toBe(
      'L1:email-shape over L0:label-person',
    );
  });

  it('keeps the value, whichever draft carried it', () => {
    expect(dedupeDrafts([label(), validated()])[0]?.value).toBe('applicant@example.in');
  });

  /**
   * The other half of the rule, and the reason it is not simply "L1 always wins": an
   * empty field has no data to be about, so the markup is the only evidence there is.
   */
  it('leaves the label class standing when nothing read a value', () => {
    const noValue = validated({ value: undefined, confidence: 0.5 });
    expect(dedupeDrafts([label(), noValue])[0]?.cls).toBe('PERSON');
  });

  it('does not merge two drafts about different elements', () => {
    const other = validated({ elementIndex: 9, box: { x: 40, y: 400, w: 300, h: 30 } });
    expect(dedupeDrafts([label(), other])).toHaveLength(2);
  });

  it('leaves an uncontested reason alone', () => {
    const second = validated({ cls: 'EMAIL', reason: 'email-shape', confidence: 0.9 });
    const first = validated({ cls: 'EMAIL', reason: 'autocomplete-email', layer: 'L0' });
    expect(dedupeDrafts([first, second])[0]?.reason).toBe('email-shape');
  });
});

/**
 * Provenance survives losing the class argument.
 *
 * One layer knowing the agent typed a value is knowledge; another not saying so is only
 * silence -- a semantic layer reading document text has no element to ask. Taking the
 * winner's origin unconditionally would put our own keystrokes back into the protected
 * count by way of whichever layer happened to win.
 */
describe('where the value came from', () => {
  const box = { x: 40, y: 100, w: 300, h: 30 };

  const draft = (over: Partial<FindingDraft> = {}): FindingDraft => ({
    cls: 'EMAIL',
    box,
    layer: 'L1',
    confidence: 0.9,
    reason: 'email-shape',
    elementIndex: 3,
    value: 'applicant@example.in',
    origin: 'page',
    ...over,
  });

  it('keeps agent origin when the layer that knew it lost', () => {
    const typed = draft({ layer: 'L0', reason: 'autocomplete-email', origin: 'agent' });
    const found = draft({ layer: 'L1', confidence: 0.95, origin: 'page' });

    expect(dedupeDrafts([typed, found])[0]?.origin).toBe('agent');
    expect(dedupeDrafts([found, typed])[0]?.origin).toBe('agent');
  });

  it('stays page when neither layer saw the agent type', () => {
    expect(dedupeDrafts([draft(), draft({ layer: 'L0' })])[0]?.origin).toBe('page');
  });
});

/**
 * A face draft carries a box and no value, which is a shape the dedupe had never seen.
 *
 * Checked rather than assumed, because the prompt for this module said to check: `decideClass`
 * reads `draft.value` to decide whether a layer read the data or only the label, and a class
 * that never has a value goes down a path nothing had exercised.
 */
describe('face drafts, which have no value', () => {
  const face = (over: Partial<FindingDraft> = {}): FindingDraft => ({
    cls: 'FACE',
    box: { x: 100, y: 100, w: 80, h: 80 },
    layer: 'L3',
    confidence: 0.95,
    reason: 'face',
    ...over,
  });

  it('survives dedupe with no value to carry', () => {
    const kept = dedupeDrafts([face()]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.cls).toBe('FACE');
    expect(kept[0]?.value).toBeUndefined();
  });

  it('collapses two detections of one face', () => {
    // NMS should have done this already; a second line of defence costs nothing and the
    // alternative is two blurs and two manifest rows over one photograph.
    const kept = dedupeDrafts([face(), face({ confidence: 0.9 })]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.confidence).toBe(0.95);
  });

  it('does not merge a face with a text finding somewhere else', () => {
    const text: FindingDraft = {
      cls: 'EMAIL',
      box: { x: 400, y: 400, w: 200, h: 20 },
      layer: 'L1',
      confidence: 0.9,
      reason: 'email-shape',
      value: 'a@b.in',
    };
    expect(dedupeDrafts([face(), text])).toHaveLength(2);
  });

  /**
   * The one that matters: a face box overlapping a text finding must not steal its value.
   * L1 read a string; L3 read pixels. Whichever wins the box, the string has to survive or
   * the allocator has nothing to tokenise and the planner gets a field with no placeholder.
   */
  it('keeps the value when a face overlaps a text finding', () => {
    const overlapping: FindingDraft = {
      cls: 'EMAIL',
      box: { x: 100, y: 100, w: 80, h: 80 },
      layer: 'L1',
      confidence: 0.9,
      reason: 'email-shape',
      value: 'a@b.in',
    };
    expect(dedupeDrafts([face(), overlapping])[0]?.value).toBe('a@b.in');
  });
});

/**
 * L3 OCR, the part that had never contributed a finding.
 *
 * The offscreen OCR task was complete and coordinate-correct, but the worker fed its lines
 * into a synthetic element missing `textRuns`, so L1's text scan threw, the throw was
 * swallowed, and every scanned Aadhaar reached the wire in the clear -- a hole in invariant
 * 9, not a latency problem. These exercise the reconnected path: recovered text goes
 * through L1 and L2 exactly as page text does, the box is carried through with no second
 * coordinate conversion, and the raw string never crosses the wire boundary.
 *
 * `ocrFindings` is node-pure by construction (the model call is injected), so this needs no
 * browser, no GPU and no weights -- the same reason ner.ts tests its arithmetic against a
 * fake classifier.
 */
describe('OCR text through L1 and L2', () => {
  const viewport = { w: 1280, h: 800 };

  /** A NER model that finds nothing -- isolates the deterministic (L1) path. */
  const noNer: NerRunner = async () => [];

  it('finds nothing in benign image text, so paints nothing', async () => {
    // Over-redaction is a first-class failure: readable, non-sensitive text baked into an
    // image must not become a box. The string is long enough to clear needsModel, so L2
    // runs too and still finds nothing.
    const lines: OcrLine[] = [
      { text: 'Welcome to the enrolment portal', box: { x: 5, y: 5, w: 300, h: 20 }, score: 0.9 },
    ];
    const { drafts, nerError } = await ocrFindings(lines, viewport, 'highPrecision', noNer);
    expect(drafts).toHaveLength(0);
    expect(nerError).toBeNull();
  });

  it('redacts a Verhoeff-valid Aadhaar baked into an image (L1 over OCR)', async () => {
    // '7237 2429 6561' is a real Verhoeff-valid Aadhaar from eval/corpus/identifiers.json.
    // No NER: the checksum path alone must catch it, so a missing model cannot leak it.
    const box = { x: 12, y: 40, w: 220, h: 26 };
    const lines: OcrLine[] = [{ text: 'Aadhaar 7237 2429 6561', box, score: 0.92 }];

    const { drafts } = await ocrFindings(lines, viewport, 'highPrecision', noNer);

    expect(drafts).toHaveLength(1);
    const hit = drafts[0];
    expect(hit?.cls).toBe('AADHAAR');
    expect(hit?.layer).toBe('L3'); // pixel-derived, however deterministic the pattern
    expect(hit?.boxKind).toBe('text');
    expect(hit?.reason).toBe('ocr:verhoeff-ok');
    expect(hit?.value).toBe('7237 2429 6561'); // device-side, for the allocator
    expect(hit?.confidence).toBeCloseTo((0.98 + 0.92) / 2); // checksum blended with the read
    expect(hit?.elementIndex).toBeUndefined(); // the synthetic join key is stripped
  });

  it('routes OCR text through L2, so a name in a scanned ID is caught', async () => {
    // The connection the old code could not make at all: detectOcr took no `operating`, so
    // it structurally could not reach the model. A name has no checksum; only L2 finds it.
    const box = { x: 12, y: 80, w: 260, h: 22 };
    const lines: OcrLine[] = [{ text: 'Asha Menon Kumar Bengaluru resident', box, score: 0.88 }];

    const person: NerRunner = async (text) => {
      const needle = 'Asha Menon Kumar';
      const at = text.indexOf(needle);
      return at < 0 ? [] : [{ start: at, end: at + needle.length, label: 'GIVENNAME', score: 0.95 }];
    };

    const { drafts, nerError } = await ocrFindings(lines, viewport, 'highPrecision', person);

    expect(nerError).toBeNull();
    const names = drafts.filter((d) => d.cls === 'PERSON');
    expect(names).toHaveLength(1);
    expect(names[0]?.layer).toBe('L3');
    expect(names[0]?.boxKind).toBe('text');
    expect(names[0]?.reason).toBe('ocr:ner-givenname');
    expect(names[0]?.value).toBe('Asha Menon Kumar');
  });

  it('a NER failure costs the names, not the checksummed L1 findings', async () => {
    // The two run in one line each in ocrFindings, and L2 has its own try/catch for exactly
    // this: no GPU must not mean a scanned Aadhaar ships in the clear.
    const box = { x: 12, y: 40, w: 220, h: 26 };
    const lines: OcrLine[] = [{ text: 'ID 7237 2429 6561 Asha Menon Kumar', box, score: 0.9 }];
    const brokenNer: NerRunner = async () => {
      throw new Error('no webgpu adapter');
    };

    const { drafts, nerError } = await ocrFindings(lines, viewport, 'highPrecision', brokenNer);

    expect(nerError).toBe('no webgpu adapter');
    expect(drafts.map((d) => d.cls)).toEqual(['AADHAAR']); // L1 survived the L2 throw
  });

  it('carries the OCR box straight through, introducing no second coordinate conversion', async () => {
    // line.box is already CSS px of the visual viewport (invariant 2). The finding's box
    // must equal it exactly -- a scale or offset here is how a redaction box lands next to
    // the number instead of on it.
    const box = { x: 137, y: 293, w: 211, h: 29 };
    const lines: OcrLine[] = [{ text: '6933 7752 9506', box, score: 1 }];

    const { drafts } = await ocrFindings(lines, viewport, 'highPrecision', noNer);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.box).toEqual(box);
  });

  it('merges an OCR finding with a DOM finding over the same region', () => {
    // A scanned value and its DOM twin at the same box are one thing. OCR findings carry no
    // element index, so they merge by region -- the same path a prose text block takes --
    // and the DOM layer, being authoritative, wins the class.
    const box = { x: 50, y: 50, w: 160, h: 24 };
    const domFinding: FindingDraft = {
      cls: 'AADHAAR',
      box,
      layer: 'L1',
      confidence: 0.98,
      reason: 'verhoeff-ok',
      value: '7237 2429 6561',
      elementIndex: 7,
      boxKind: 'text',
    };
    const ocrFinding: FindingDraft = {
      cls: 'AADHAAR',
      box: { x: 51, y: 50, w: 160, h: 24 },
      layer: 'L3',
      confidence: 0.95,
      reason: 'ocr:verhoeff-ok',
      value: '7237 2429 6561',
      elementIndex: undefined,
      boxKind: 'text',
    };

    const kept = dedupeDrafts([domFinding, ocrFinding]);

    expect(kept).toHaveLength(1);
    expect(kept[0]?.layer).toBe('L1'); // DOM is authoritative (invariant 9)
  });

  it('drops the raw OCR value at the wire boundary', async () => {
    // The privacy line. The value lives in the draft (the allocator needs it) but the wire
    // Finding has no value field at all, so raw OCR text cannot cross with the manifest.
    const box = { x: 12, y: 40, w: 220, h: 26 };
    const lines: OcrLine[] = [{ text: 'Aadhaar 7237 2429 6561', box, score: 0.9 }];

    const { drafts } = await ocrFindings(lines, viewport, 'highPrecision', noNer);
    const draft = drafts[0];
    expect(draft?.cls).toBe('AADHAAR');
    expect(draft?.value).toBe('7237 2429 6561');

    const finding = makeFinding(draft as FindingDraft);
    expect('value' in finding).toBe(false);
    expect(JSON.stringify(finding)).not.toContain('7237');
  });
});
