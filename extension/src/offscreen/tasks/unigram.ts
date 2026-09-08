/**
 * The SentencePiece Unigram tokenizer XLM-R needs, in enough detail and no more.
 *
 * There is no tokenizer dependency in this project and there is not going to be one: the
 * options are a megabyte of general-purpose library for one model, or the eighty lines
 * below. What those eighty lines have to get right is the Viterbi segmentation, and that
 * is checked against HuggingFace's own tokenizer on the real vocabulary -- see
 * unigram.test.ts, which asserts identical token ids for corpus-shaped strings.
 *
 * ## Offsets are per word, deliberately
 *
 * XLM-R's `Precompiled` normalizer is a compiled charsmap blob. Reimplementing it
 * faithfully is a research project, and approximating it with NFKC shifts character
 * offsets wherever the approximation differs -- which would move redaction boxes, and
 * boxes landing near a value rather than on it is the one failure mode worse than
 * missing it.
 *
 * So this does not track character offsets through normalization at all. It splits on
 * whitespace first, records each word's span in the *original* string, and tokenizes
 * each word independently. Every subword piece inherits its word's span. Downstream that
 * is exactly enough: `spanBox` maps a character range onto the text run that contains it,
 * and a run is a whole text node, so word granularity and character granularity select
 * the same box.
 *
 * The cost is that an entity covering part of a word cannot be tightened to that part.
 * For names, addresses and dates -- what this model detects -- entities are whole words.
 */

/** A token with the span of the word it came from, in the original string. */
export interface EncodedToken {
  id: number;
  start: number;
  end: number;
}

export interface UnigramVocabEntry {
  0: string;
  1: number;
}

export interface UnigramTokenizer {
  encode(text: string): EncodedToken[];
  readonly size: number;
}

/** The metaspace marker SentencePiece puts at the start of every word. */
const SPACE = '▁';

/**
 * Longest piece the lattice will consider.
 *
 * The vocabulary's longest entry is shorter than this, and the bound turns the inner
 * loop from "every suffix" into a constant, which is what keeps a page of prose inside
 * the latency budget.
 */
const MAX_PIECE = 24;

/**
 * Cost charged for falling back to `<unk>` on one character.
 *
 * SentencePiece's own default. Large enough that any real segmentation wins, small
 * enough that an unknown character does not poison the whole word's path.
 */
const UNK_PENALTY = 10;

export function createUnigramTokenizer(
  vocab: ReadonlyArray<readonly [string, number]>,
  unkId: number,
): UnigramTokenizer {
  const pieces = new Map<string, { id: number; score: number }>();
  for (let id = 0; id < vocab.length; id += 1) {
    const entry = vocab[id];
    if (entry) pieces.set(entry[0], { id, score: entry[1] });
  }

  /**
   * Best segmentation of one word, by total unigram score.
   *
   * Straight Viterbi over a lattice whose nodes are character boundaries: `best[i]` is
   * the score of the best path reaching boundary `i`, and `from[i]` is the piece that
   * got there. Ties go to the earlier boundary, which is what SentencePiece does.
   */
  function encodeWord(word: string): number[] {
    const text = SPACE + word;
    const n = text.length;

    const best = new Float64Array(n + 1).fill(-Infinity);
    const fromId = new Int32Array(n + 1).fill(-1);
    const fromAt = new Int32Array(n + 1).fill(-1);
    best[0] = 0;

    for (let i = 0; i < n; i += 1) {
      if (best[i] === -Infinity) continue;
      const limit = Math.min(n, i + MAX_PIECE);

      for (let j = i + 1; j <= limit; j += 1) {
        const hit = pieces.get(text.slice(i, j));
        if (hit) {
          const score = (best[i] as number) + hit.score;
          if (score > (best[j] as number)) {
            best[j] = score;
            fromId[j] = hit.id;
            fromAt[j] = i;
          }
        } else if (j === i + 1) {
          // One character, unknown. Always available, so the lattice cannot dead-end on
          // a character the pruned vocabulary no longer covers.
          const score = (best[i] as number) - UNK_PENALTY;
          if (score > (best[j] as number)) {
            best[j] = score;
            fromId[j] = unkId;
            fromAt[j] = i;
          }
        }
      }
    }

    const ids: number[] = [];
    for (let at = n; at > 0;) {
      const id = fromId[at];
      const previous = fromAt[at];
      if (id === undefined || previous === undefined || previous < 0) break;
      ids.push(id);
      at = previous;
    }
    return ids.reverse();
  }

  return {
    size: vocab.length,
    encode(text: string): EncodedToken[] {
      const out: EncodedToken[] = [];
      // Whitespace, not the pre-tokenizer's full rule set. Anchoring on the original
      // string is the whole point, and any split that agrees on word boundaries agrees
      // on the spans.
      const words = /\S+/g;
      let match: RegExpExecArray | null;

      while ((match = words.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        for (const id of encodeWord(match[0])) out.push({ id, start, end });
      }
      return out;
    },
  };
}
