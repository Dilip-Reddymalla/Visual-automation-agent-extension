import { describe, it, expect, beforeEach } from 'vitest';
import { buildOffsetTable, type DocSpan } from './chunks';
import { classForLabel, detectEntities, needsModel, THRESHOLDS } from './ner';
import { createOcrCache, linesToViewport, opaqueRegions, type OcrLine } from './ocr';
import {
  allocatorFor,
  disposeAllocator,
  resetAllocators,
  resolvePlaceholder,
} from '../allocator';
import type { ObservedElement } from '../../shared/observed';

function element(over: Partial<ObservedElement> = {}): ObservedElement {
  return {
    index: 1,
    role: 'text',
    box: { x: 10, y: 10, w: 200, h: 40 },
    state: { visible: true, enabled: true, focused: false, filled: false },
    occluded: 0,
    isNew: false,
    tag: 'div',
    key: 'k',
    name: '',
    textRuns: [],
    ...over,
  };
}

function textElement(text: string, index = 1): ObservedElement {
  return element({
    index,
    textRuns: [{ text, box: { x: 10, y: 10 + index * 30, w: 300, h: 18 }, nodeIndex: 0 }],
  });
}

// ── L2 ────────────────────────────────────────────────────────────────────────

describe('the label table', () => {
  it('maps what it knows', () => {
    // The shipped checkpoint's own labels, not CoNLL's. It is a PII model rather than a
    // general NER one, so a person arrives as GIVENNAME and SURNAME and an address as
    // four separate labels.
    expect(classForLabel('B-GIVENNAME')).toBe('PERSON');
    expect(classForLabel('I-SURNAME')).toBe('PERSON');
    expect(classForLabel('B-STREET')).toBe('ADDRESS');
    expect(classForLabel('B-CITY')).toBe('ADDRESS');
    expect(classForLabel('B-ZIPCODE')).toBe('ADDRESS');
    expect(classForLabel('B-TELEPHONENUM')).toBe('PHONE');
    expect(classForLabel('B-EMAIL')).toBe('EMAIL');
  });

  it('drops the identifier labels that L1 owns with a checksum behind it', () => {
    // This model calls a twelve-digit invoice number a SOCIALNUM at 0.38. L1 calls the
    // same string nothing at all, because it fails Verhoeff and is captioned "Invoice".
    // Merging the two would trade a certainty for a guess.
    for (const label of ['B-SOCIALNUM', 'B-IDCARDNUM', 'B-TAXNUM', 'B-CREDITCARDNUMBER']) {
      expect(classForLabel(label)).toBeNull();
    }
  });

  it('has no ORG mapping, because the checkpoint has no ORGANIZATION label', () => {
    // Stated as a test so it reads as a known gap rather than an omission.
    expect(classForLabel('B-ORGANIZATION')).toBeNull();
  });

  it('drops what it does not, rather than coercing it', () => {
    // Funnelling an unknown label into ORG "to be safe" produces findings whose class
    // is a guess, and over-redaction is a first-class failure here.
    expect(classForLabel('B-MISC')).toBeNull();
    expect(classForLabel('O')).toBeNull();
    expect(classForLabel('B-WHATEVER')).toBeNull();
    expect(classForLabel('CARDINAL')).toBeNull();
  });
});

describe('the early exit', () => {
  it('does not want a model for an empty page', () => {
    expect(needsModel(buildOffsetTable([]))).toBe(false);
  });

  it('does not want a model when L0 and L1 claimed everything', () => {
    // The common case on the forms this agent is built for: loading forty megabytes to
    // confirm there is nothing left is the most expensive way to learn nothing.
    const table = buildOffsetTable([
      { runs: [{ text: 'Asha Menon', box: { x: 0, y: 0, w: 1, h: 1 }, nodeIndex: 0 }] },
    ]);
    expect(needsModel(table, [[0, 10]])).toBe(false);
  });

  it('wants a model when there is unclaimed prose', () => {
    const table = buildOffsetTable([
      {
        runs: [
          {
            text: 'A long paragraph nobody has classified yet.',
            box: { x: 0, y: 0, w: 1, h: 1 },
            nodeIndex: 0,
          },
        ],
      },
    ]);
    expect(needsModel(table, [])).toBe(true);
  });

  it('ignores a few stray characters', () => {
    const table = buildOffsetTable([
      { runs: [{ text: 'OK', box: { x: 0, y: 0, w: 1, h: 1 }, nodeIndex: 0 }] },
    ]);
    expect(needsModel(table, [])).toBe(false);
  });
});

describe('detectEntities', () => {
  /** A fake classifier: finds a fixed name wherever it appears in the chunk. */
  function findName(name: string, label = 'B-GIVENNAME', score = 0.9) {
    return async (text: string): Promise<DocSpan[]> => {
      const spans: DocSpan[] = [];
      let at = text.indexOf(name);
      while (at !== -1) {
        spans.push({ start: at, end: at + name.length, label, score });
        at = text.indexOf(name, at + 1);
      }
      return spans;
    };
  }

  it('turns a span into a finding with a box', async () => {
    const drafts = await detectEntities(
      { elements: [textElement('Applicant is Asha Menon, resident of Bengaluru.')] },
      findName('Asha Menon'),
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ cls: 'PERSON', layer: 'L2', reason: 'ner-b-givenname' });
    expect(drafts[0]?.box).toEqual({ x: 10, y: 40, w: 300, h: 18 });
    expect(drafts[0]?.value).toBe('Asha Menon');
    expect(drafts[0]?.elementIndex).toBe(1);
  });

  it('honours the operating point', async () => {
    const input = { elements: [textElement('Applicant is Asha Menon of Bengaluru.')] };
    const unsure = findName('Asha Menon', 'B-GIVENNAME', 0.5);

    expect(await detectEntities({ ...input, operating: 'highPrecision' }, unsure)).toEqual([]);
    expect(await detectEntities({ ...input, operating: 'highRecall' }, unsure)).toHaveLength(1);
    expect(THRESHOLDS.highRecall).toBeLessThan(THRESHOLDS.highPrecision);
  });

  it('drops a label it has no class for', async () => {
    const drafts = await detectEntities(
      { elements: [textElement('The Kaveri river basin dispute continues.')] },
      findName('Kaveri', 'B-MISC'),
    );
    expect(drafts).toEqual([]);
  });

  it('never runs the model when the early exit fires', async () => {
    let called = 0;
    await detectEntities({ elements: [] }, async () => {
      called += 1;
      return [];
    });
    expect(called).toBe(0);
  });

  it('finds an entity spanning two elements', async () => {
    // A per-run pass cannot see this at all: "Asha" ends one element and "Menon"
    // begins the next, and only the concatenated document contains the whole name.
    const drafts = await detectEntities(
      {
        elements: [
          textElement('Applicant on record is Asha', 1),
          textElement('Menon, resident of Bengaluru since 2019.', 2),
        ],
      },
      async (text) => {
        const at = text.indexOf('Asha\nMenon');
        return at === -1 ? [] : [{ start: at, end: at + 10, label: 'B-GIVENNAME', score: 0.9 }];
      },
    );

    expect(drafts).toHaveLength(1);
    // Boxed across both runs, so both lines get covered rather than just the first.
    expect(drafts[0]?.box.h).toBeGreaterThan(18);
  });
});

// ── L3 ────────────────────────────────────────────────────────────────────────

describe('choosing regions to OCR', () => {
  it('takes the elements the DOM cannot describe', () => {
    const regions = opaqueRegions([
      element({ tag: 'img', box: { x: 0, y: 0, w: 400, h: 300 } }),
      element({ tag: 'canvas', box: { x: 0, y: 0, w: 400, h: 300 } }),
      element({ tag: 'div', box: { x: 0, y: 0, w: 400, h: 300 } }),
    ]);
    expect(regions.map((r) => r.reason)).toEqual(['tag-img', 'tag-canvas']);
  });

  it('takes a closed shadow root, which is opaque in the same sense', () => {
    const regions = opaqueRegions([
      element({ tag: 'support-widget', opaque: true, box: { x: 0, y: 0, w: 300, h: 200 } }),
    ]);
    expect(regions[0]?.reason).toBe('closed-shadow-root');
  });

  it('skips anything too small to hold text', () => {
    const regions = opaqueRegions([element({ tag: 'img', box: { x: 0, y: 0, w: 16, h: 16 } })]);
    expect(regions).toEqual([]);
  });

  it('numbers regions so a batched run can be attributed back', () => {
    const regions = opaqueRegions([
      element({ tag: 'img', index: 3, box: { x: 0, y: 0, w: 400, h: 300 } }),
      element({ tag: 'img', index: 7, box: { x: 0, y: 400, w: 400, h: 300 } }),
    ]);
    expect(regions.map((r) => [r.region, r.elementIndex])).toEqual([
      [0, 3],
      [1, 7],
    ]);
  });

  it('never proposes the whole screenshot', () => {
    // The named mistake: 500 ms to re-derive text the DOM already handed over.
    const regions = opaqueRegions([textElement('lots of perfectly readable DOM text')]);
    expect(regions).toEqual([]);
  });
});

describe('the OCR cache', () => {
  const line = (text: string): OcrLine => ({
    text,
    box: { x: 0, y: 0, w: 10, h: 10 },
    score: 0.9,
    region: 0,
  });

  it('reads an unchanged region once across six steps', () => {
    const cache = createOcrCache();
    cache.set('hash-a', [line('Aadhaar 7237 2429 6561')], 1);

    for (let step = 2; step <= 6; step += 1) {
      expect(cache.get('hash-a', step)?.[0]?.text).toBe('Aadhaar 7237 2429 6561');
    }
    expect(cache.hits).toBe(5);
    expect(cache.misses).toBe(0);
  });

  it('keys on the pixels, not the position', () => {
    // The page scrolling does not change what the document says.
    const cache = createOcrCache();
    cache.set('same-pixels', [line('x')], 1);
    expect(cache.get('same-pixels', 2)).toBeDefined();
  });

  it('misses when the region actually changed', () => {
    const cache = createOcrCache();
    cache.set('hash-a', [line('x')], 1);
    expect(cache.get('hash-b', 2)).toBeUndefined();
    expect(cache.misses).toBe(1);
  });

  it('hands out copies, so re-boxing does not corrupt the cache', () => {
    const cache = createOcrCache();
    cache.set('h', [line('x')], 1);
    const first = cache.get('h', 2);
    if (first?.[0]) first[0].box.x = 999;
    expect(cache.get('h', 3)?.[0]?.box.x).toBe(0);
  });

  it('evicts the least recently used', () => {
    const cache = createOcrCache(2);
    cache.set('a', [line('a')], 1);
    cache.set('b', [line('b')], 2);
    cache.get('a', 3); // 'a' is now the newer of the two
    cache.set('c', [line('c')], 4);

    expect(cache.get('a', 5)).toBeDefined();
    expect(cache.get('b', 5)).toBeUndefined();
    expect(cache.size).toBe(2);
  });
});

describe('putting OCR lines back on the page', () => {
  it('translates crop coordinates into viewport coordinates', () => {
    const region = { region: 2, box: { x: 100, y: 200, w: 400, h: 300 }, reason: 'tag-img' };
    const [line] = linesToViewport(
      [{ text: 'x', box: { x: 20, y: 40, w: 80, h: 16 }, score: 0.9, region: 0 }],
      region,
      2,
    );

    // Crop scale is the crop's own, not the frame's: a region is usually resized before
    // it reaches the recogniser.
    expect(line?.box).toEqual({ x: 110, y: 220, w: 40, h: 8 });
    expect(line?.region).toBe(2);
  });
});

// ── The allocator's home ──────────────────────────────────────────────────────

describe('where the placeholder map lives', () => {
  beforeEach(() => resetAllocators());

  it('keeps numbering stable within a session', () => {
    const a = allocatorFor('s1');
    expect(a.allocate('PERSON', 'Asha Menon')).toBe('«PERSON_1»');
    expect(allocatorFor('s1').allocate('PERSON', 'Asha Menon')).toBe('«PERSON_1»');
    expect(allocatorFor('s1').allocate('PERSON', 'Ravi Kumar')).toBe('«PERSON_2»');
  });

  it('resolves what it issued', () => {
    allocatorFor('s1').allocate('PERSON', 'Asha Menon');
    expect(resolvePlaceholder('s1', '«PERSON_1»')).toEqual({ ok: true, value: 'Asha Menon' });
  });

  it('rejects a placeholder the planner invented', () => {
    allocatorFor('s1').allocate('PERSON', 'Asha Menon');
    expect(resolvePlaceholder('s1', '«PERSON_9»')).toEqual({
      ok: false,
      reason: 'unknown-placeholder',
    });
  });

  it('reports a lost map as its own failure, not as an unknown token', () => {
    // Firefox can suspend the background page and take the map with it. Silently
    // re-allocating would hand the planner PERSON_1 for a different human mid-task.
    allocatorFor('s1').allocate('PERSON', 'Asha Menon');
    disposeAllocator('s1');
    expect(resolvePlaceholder('s1', '«PERSON_1»')).toEqual({
      ok: false,
      reason: 'session-lost',
    });
  });

  it("drops the previous session's values when a new one starts", () => {
    allocatorFor('s1').allocate('PERSON', 'Asha Menon');
    allocatorFor('s2');
    expect(resolvePlaceholder('s1', '«PERSON_1»')).toEqual({
      ok: false,
      reason: 'session-lost',
    });
    // And a new session starts its numbering over, by definition.
    expect(allocatorFor('s2').allocate('PERSON', 'Someone Else')).toBe('«PERSON_1»');
  });

  it("never returns a secret's plaintext, only its vault key", () => {
    const a = allocatorFor('s1');
    const token = a.allocate('SECRET', 'vault:portal-pin');
    expect(resolvePlaceholder('s1', token)).toEqual({ ok: true, value: 'vault:portal-pin' });
  });
});
