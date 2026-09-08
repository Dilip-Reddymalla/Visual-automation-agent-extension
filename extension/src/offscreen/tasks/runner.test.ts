import { describe, it, expect } from 'vitest';
import { createNerRunner, type NerAssets } from './ner';
import type { ModelSession, TensorLike } from '../host';

/**
 * The span builder, against synthetic logits.
 *
 * Worth its own file because every failure here is silent: the model loads, runs, costs
 * its full second and a half, and returns nothing -- which is indistinguishable from a
 * page with no names on it.
 */

const LABELS = ['O', 'B-GIVENNAME', 'B-SURNAME', 'B-CITY'];

function assets(): NerAssets {
  // Two pieces per word is enough to exercise the grouping; the ids are arbitrary
  // because the fake session ignores them.
  return {
    vocab: [
      ['<s>', 0],
      ['<pad>', 0],
      ['</s>', 0],
      ['<unk>', 0],
      ['▁Asha', -1],
      ['▁Menon', -1],
      ['▁lives', -1],
      ['▁in', -1],
      ['▁Pune', -1],
    ],
    unkId: 3,
    labels: LABELS,
  };
}

/** A session that labels tokens from a script, one entry per *model* row. */
function sessionLabelling(rows: string[]): ModelSession {
  return {
    inputNames: ['input_ids', 'attention_mask'],
    outputNames: ['logits'],
    async run(): Promise<Record<string, TensorLike>> {
      const data = new Float32Array(rows.length * LABELS.length);
      rows.forEach((label, i) => {
        const at = LABELS.indexOf(label);
        // A wide margin, so argmax is unambiguous and the softmax score is near 1.
        data[i * LABELS.length + (at < 0 ? 0 : at)] = 8;
      });
      return {
        logits: { type: 'float32', dims: [1, rows.length, LABELS.length], data },
      };
    },
    async dispose() {},
  };
}

const tensor = (type: string, data: BigInt64Array, dims: number[]): TensorLike => ({
  type,
  dims,
  data,
});

describe('the NER runner', () => {
  it('turns labelled tokens into a span', async () => {
    // BOS, then one row per token, then EOS.
    const run = createNerRunner(
      sessionLabelling(['O', 'B-GIVENNAME', 'O', 'O', 'O', 'O']),
      assets(),
      tensor,
    );
    const spans = await run('Asha lives in Pune');

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ label: 'GIVENNAME' });
    expect('Asha lives in Pune'.slice(spans[0]?.start ?? 0, spans[0]?.end ?? 0)).toBe('Asha');
  });

  it('joins adjacent words of the same class into one span', async () => {
    const run = createNerRunner(
      sessionLabelling(['O', 'B-GIVENNAME', 'B-GIVENNAME', 'O']),
      assets(),
      tensor,
    );
    const spans = await run('Asha Menon');

    expect(spans).toHaveLength(1);
    expect('Asha Menon'.slice(spans[0]?.start ?? 0, spans[0]?.end ?? 0)).toBe('Asha Menon');
  });

  it('scores a span by its weakest token, not its average', async () => {
    // A confident token must not carry a doubtful one past the threshold: that is the
    // exact shape of the false positive over-redaction is measured on.
    const run = createNerRunner(
      {
        inputNames: [],
        outputNames: ['logits'],
        async run() {
          const data = new Float32Array(4 * LABELS.length);
          // BOS: O. token0: very confident GIVENNAME. token1: barely GIVENNAME.
          data[0 * LABELS.length + 0] = 9;
          data[1 * LABELS.length + 1] = 9;
          data[2 * LABELS.length + 1] = 0.2;
          data[3 * LABELS.length + 0] = 9;
          return { logits: { type: 'float32', dims: [1, 4, LABELS.length], data } };
        },
        async dispose() {},
      },
      assets(),
      tensor,
    );
    const spans = await run('Asha Menon');

    expect(spans).toHaveLength(1);
    expect(spans[0]?.score).toBeLessThan(0.5);
  });

  it('produces nothing for text the model calls O throughout', async () => {
    const run = createNerRunner(sessionLabelling(['O', 'O', 'O', 'O']), assets(), tensor);
    expect(await run('lives in')).toEqual([]);
  });
});
