/**
 * The offset table, and the chunking that sits on top of it.
 *
 * This is the whole difficulty of L2. A token classifier works on one flat string and
 * returns character offsets into it; what the gate needs is a box on the screen. The
 * offset table is the only thing that connects the two, and every span the model returns
 * has to travel back through it.
 *
 * Two decisions worth stating, because both were tempting to get wrong:
 *
 *   One string, not one per run. Concatenating every text run into a single document
 *   and remembering where each run started is more work than classifying runs
 *   individually -- and it is the only version that works. An entity spanning two
 *   elements ("Asha" in one span, "Menon" in the next) is invisible to a per-run pass,
 *   and a per-run pass also strips the sentence context the model needs to tell a
 *   person from a place.
 *
 *   Chunks overlap, and the overlap is de-duplicated by span identity. A name landing
 *   on a chunk boundary would otherwise be cut in half and missed by both chunks. With
 *   a 50-token overlap it is whole in at least one of them -- and then reported twice,
 *   which is why the de-duplication is not optional.
 *
 * Node-pure: no model, no browser, no tokenizer. What counts as a "token" is injected,
 * because the real answer is the model's tokenizer and this module must not care which.
 */

import type { Box } from '../../shared/coords';
import type { TextRun } from '../../shared/observed';

/** The model's window, in tokens. A distil-class encoder is 512. */
export const DEFAULT_MAX_TOKENS = 512;

/** How much of the previous chunk to repeat. Enough for any name or address. */
export const DEFAULT_OVERLAP_TOKENS = 50;

/** Roughly a token per four characters. Only used when no tokenizer is supplied. */
const CHARS_PER_TOKEN = 4;

/** One text run's place in the concatenated document. */
export interface OffsetEntry {
  /** Character offset of this run's first character in the document. */
  start: number;
  /** One past its last character. */
  end: number;
  box: Box;
  /** Which element this run came from, so a finding can name it. */
  elementIndex?: number;
  /** Position among that element's own text nodes. */
  nodeIndex: number;
}

export interface OffsetTable {
  text: string;
  entries: OffsetEntry[];
}

export interface RunSource {
  elementIndex?: number;
  runs: TextRun[];
}

/** What goes between two runs in the concatenated document. */
const JOINER = '\n';

/**
 * Concatenate every run into one document, recording where each one landed.
 *
 * The joiner is a newline rather than a space: it reads as a sentence boundary to the
 * model, which is what a change of element usually is, and it keeps a heading from
 * running into the paragraph beneath it as though they were one phrase.
 */
export function buildOffsetTable(sources: RunSource[]): OffsetTable {
  const parts: string[] = [];
  const entries: OffsetEntry[] = [];
  let cursor = 0;

  for (const source of sources) {
    for (const run of source.runs) {
      const text = run.text;
      if (text.length === 0) continue;

      entries.push({
        start: cursor,
        end: cursor + text.length,
        box: run.box,
        elementIndex: source.elementIndex,
        nodeIndex: run.nodeIndex,
      });
      parts.push(text);
      cursor += text.length + JOINER.length;
    }
  }

  return { text: parts.join(JOINER), entries };
}

/**
 * Every run a character range touches. A span crossing a run boundary belongs to both,
 * which is exactly the case a per-run pass could not see in the first place.
 */
export function runsForSpan(table: OffsetTable, start: number, end: number): OffsetEntry[] {
  return table.entries.filter((e) => start < e.end && end > e.start);
}

/**
 * The box for a character range: the union of every run it touches.
 *
 * A union rather than an intersection or the first run's box, because a name wrapped
 * across two lines genuinely occupies both, and redacting only the first line leaves
 * the surname legible on screen.
 */
export function boxForSpan(table: OffsetTable, start: number, end: number): Box | null {
  const touched = runsForSpan(table, start, end);
  if (touched.length === 0) return null;

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const run of touched) {
    x0 = Math.min(x0, run.box.x);
    y0 = Math.min(y0, run.box.y);
    x1 = Math.max(x1, run.box.x + run.box.w);
    y1 = Math.max(y1, run.box.y + run.box.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface Chunk {
  /** The slice handed to the model. */
  text: string;
  /** Where this slice starts in the whole document, for translating spans back. */
  offset: number;
  index: number;
}

export interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
  /** The model's own tokenizer. Falls back to a character estimate. */
  countTokens?: (text: string) => number;
}

/**
 * Split the document into overlapping windows.
 *
 * Boundaries prefer whitespace: cutting mid-word produces two fragments the model has
 * never seen, and a name split into "Ash" and "a Menon" is worse than no chunking at
 * all. The overlap then guarantees that anything shorter than it is whole somewhere.
 */
export function chunkDocument(text: string, options: ChunkOptions = {}): Chunk[] {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapTokens = Math.min(
    options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS,
    maxTokens - 1,
  );
  const countTokens =
    options.countTokens ?? ((s: string) => Math.ceil(s.length / CHARS_PER_TOKEN));

  if (text.length === 0) return [];
  if (countTokens(text) <= maxTokens) return [{ text, offset: 0, index: 0 }];

  // How many characters the window is worth, measured on this document rather than
  // assumed: Devanagari and Latin tokenize at very different rates.
  const charsPerToken = text.length / Math.max(1, countTokens(text));
  const windowChars = Math.max(1, Math.floor(maxTokens * charsPerToken));
  const overlapChars = Math.max(1, Math.floor(overlapTokens * charsPerToken));
  const stride = Math.max(1, windowChars - overlapChars);

  const chunks: Chunk[] = [];
  let offset = 0;
  let index = 0;

  while (offset < text.length) {
    let end = Math.min(text.length, offset + windowChars);
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(' ', end);
      // Only honour a space that is actually near the end; otherwise a long unbroken
      // string would collapse the window to nothing.
      if (lastSpace > offset + stride / 2) end = lastSpace;
    }

    chunks.push({ text: text.slice(offset, end), offset, index });
    index += 1;
    if (end >= text.length) break;
    offset += stride;
  }

  return chunks;
}

/** A span the model found, already translated into document coordinates. */
export interface DocSpan {
  start: number;
  end: number;
  label: string;
  score: number;
}

/** Move a span from chunk coordinates into document coordinates. */
export function toDocumentSpan(
  chunk: Chunk,
  span: Omit<DocSpan, 'start' | 'end'> & {
    start: number;
    end: number;
  },
): DocSpan {
  return { ...span, start: span.start + chunk.offset, end: span.end + chunk.offset };
}

/**
 * Collapse spans the overlap reported twice.
 *
 * Identity is (start, end, label) -- the same characters given the same label are the
 * same entity, whichever chunk saw it. When both chunks agree, keep the more confident
 * reading: a chunk that saw the whole sentence is usually surer than one that saw the
 * tail of it.
 *
 * Overlapping-but-not-identical spans are also collapsed, longest first, because a
 * boundary can leave one chunk with "Asha" and the other with "Asha Menon" and the
 * longer reading is the one that redacts the whole name.
 */
export function dedupeSpans(spans: DocSpan[]): DocSpan[] {
  const exact = new Map<string, DocSpan>();
  for (const span of spans) {
    const key = `${span.start}:${span.end}:${span.label}`;
    const seen = exact.get(key);
    if (!seen || span.score > seen.score) exact.set(key, span);
  }

  // Longest first, then most confident: a longer span absorbs the shorter one inside it.
  const ordered = [...exact.values()].sort(
    (a, b) => b.end - b.start - (a.end - a.start) || b.score - a.score || a.start - b.start,
  );

  const kept: DocSpan[] = [];
  for (const span of ordered) {
    const covered = kept.some(
      (k) => k.label === span.label && span.start >= k.start && span.end <= k.end,
    );
    if (!covered) kept.push(span);
  }

  return kept.sort((a, b) => a.start - b.start);
}
