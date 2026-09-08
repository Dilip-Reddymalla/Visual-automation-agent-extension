import { describe, it, expect } from 'vitest';
import {
  boxForSpan,
  buildOffsetTable,
  chunkDocument,
  dedupeSpans,
  DEFAULT_OVERLAP_TOKENS,
  runsForSpan,
  type DocSpan,
} from './chunks';
import type { TextRun } from '../../shared/observed';

function run(text: string, y: number, x = 10, w = 200, h = 18): TextRun {
  return { text, box: { x, y, w, h }, nodeIndex: 0 };
}

describe('the offset table', () => {
  it('concatenates runs and remembers where each one landed', () => {
    const table = buildOffsetTable([
      { elementIndex: 1, runs: [run('Asha Menon', 10)] },
      { elementIndex: 2, runs: [run('14 Rose Villa', 40)] },
    ]);

    expect(table.text).toBe('Asha Menon\n14 Rose Villa');
    expect(table.entries[0]).toMatchObject({ start: 0, end: 10, elementIndex: 1 });
    expect(table.entries[1]).toMatchObject({ start: 11, end: 24, elementIndex: 2 });
    expect(table.text.slice(11, 24)).toBe('14 Rose Villa');
  });

  it('skips empty runs without disturbing the offsets', () => {
    const table = buildOffsetTable([{ runs: [run('a', 0), run('', 10), run('b', 20)] }]);
    expect(table.text).toBe('a\nb');
    expect(table.entries).toHaveLength(2);
    expect(table.text.slice(table.entries[1]?.start, table.entries[1]?.end)).toBe('b');
  });

  it('round-trips every entry back to its own text', () => {
    const table = buildOffsetTable([
      { elementIndex: 1, runs: [run('one', 0), run('two', 20)] },
      { elementIndex: 2, runs: [run('three', 40)] },
    ]);
    const recovered = table.entries.map((e) => table.text.slice(e.start, e.end));
    expect(recovered).toEqual(['one', 'two', 'three']);
  });
});

describe('spans back to boxes', () => {
  const table = buildOffsetTable([
    { elementIndex: 1, runs: [run('Asha', 10, 10, 40, 18)] },
    { elementIndex: 1, runs: [run('Menon', 30, 10, 50, 18)] },
  ]);

  it('finds the run a span sits in', () => {
    expect(runsForSpan(table, 0, 4).map((r) => r.box.y)).toEqual([10]);
    expect(runsForSpan(table, 5, 10).map((r) => r.box.y)).toEqual([30]);
  });

  it('unions the boxes of a span that crosses two runs', () => {
    // A name wrapped across two lines occupies both. Redacting only the first leaves
    // the surname on screen.
    const box = boxForSpan(table, 0, 10);
    expect(box).toEqual({ x: 10, y: 10, w: 50, h: 38 });
  });

  it('returns nothing for a span past the end', () => {
    expect(boxForSpan(table, 500, 510)).toBeNull();
  });
});

describe('chunking', () => {
  it('leaves a short document alone', () => {
    const chunks = chunkDocument('short enough', { maxTokens: 512 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ offset: 0, index: 0 });
  });

  it('splits a long document into overlapping windows', () => {
    const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkDocument(text, { maxTokens: 128, overlapTokens: 32 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(text.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(chunk.text);
    }
  });

  it('overlaps, so nothing shorter than the overlap can fall between two chunks', () => {
    const text = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
    const chunks = chunkDocument(text, { maxTokens: 100, overlapTokens: 25 });

    for (let i = 1; i < chunks.length; i += 1) {
      const previous = chunks[i - 1];
      const current = chunks[i];
      if (!previous || !current) continue;
      const previousEnd = previous.offset + previous.text.length;
      expect(current.offset).toBeLessThan(previousEnd);
    }
  });

  it('covers the whole document', () => {
    const text = Array.from({ length: 200 }, (_, i) => `token${i}`).join(' ');
    const chunks = chunkDocument(text, { maxTokens: 64, overlapTokens: 16 });
    const last = chunks[chunks.length - 1];
    expect((last?.offset ?? 0) + (last?.text.length ?? 0)).toBe(text.length);
  });

  it('prefers to break on whitespace', () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkDocument(text, { maxTokens: 64, overlapTokens: 16 });
    // A chunk that ends mid-word hands the model a fragment it has never seen.
    for (const chunk of chunks.slice(0, -1)) {
      expect(
        chunk.text.endsWith(' ') || !text[chunk.offset + chunk.text.length]?.match(/\S/),
      ).toBe(true);
    }
  });

  it('uses the real tokenizer when it is given one', () => {
    const text = 'क'.repeat(2000);
    // Devanagari tokenizes far worse than Latin; a character estimate would produce
    // chunks the model cannot fit.
    const chunks = chunkDocument(text, { maxTokens: 100, countTokens: (s) => s.length });
    expect(chunks.length).toBeGreaterThanOrEqual(20);
  });

  it('does not collapse on a long unbroken string', () => {
    const chunks = chunkDocument('x'.repeat(5000), { maxTokens: 64, overlapTokens: 16 });
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
    expect(chunks.length).toBeLessThan(200);
  });

  it('defaults to a 50-token overlap', () => {
    expect(DEFAULT_OVERLAP_TOKENS).toBe(50);
  });
});

describe('de-duplicating across the overlap', () => {
  const span = (start: number, end: number, label: string, score: number): DocSpan => ({
    start,
    end,
    label,
    score,
  });

  it('reports an entity seen by two chunks exactly once', () => {
    const deduped = dedupeSpans([span(10, 20, 'PER', 0.9), span(10, 20, 'PER', 0.95)]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.score).toBe(0.95);
  });

  it('keeps the longer reading when the boundary cut one short', () => {
    // One chunk saw "Asha", the other saw "Asha Menon". Redact the whole name.
    const deduped = dedupeSpans([span(0, 4, 'PER', 0.9), span(0, 10, 'PER', 0.88)]);
    expect(deduped).toEqual([span(0, 10, 'PER', 0.88)]);
  });

  it('keeps two genuinely different entities', () => {
    const deduped = dedupeSpans([span(0, 4, 'PER', 0.9), span(20, 30, 'LOC', 0.8)]);
    expect(deduped).toHaveLength(2);
  });

  it('does not merge the same span under different labels', () => {
    // "Victoria" as a person and as a place are two readings, not one duplicate.
    const deduped = dedupeSpans([span(0, 8, 'PER', 0.6), span(0, 8, 'LOC', 0.7)]);
    expect(deduped).toHaveLength(2);
  });

  it('returns them in document order', () => {
    const deduped = dedupeSpans([span(40, 50, 'PER', 0.9), span(0, 10, 'ORG', 0.9)]);
    expect(deduped.map((s) => s.start)).toEqual([0, 40]);
  });
});
