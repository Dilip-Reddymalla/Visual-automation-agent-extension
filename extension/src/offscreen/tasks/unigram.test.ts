import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUnigramTokenizer } from './unigram';

/**
 * The tokenizer has to agree with HuggingFace exactly.
 *
 * Not approximately: a different segmentation gives the model different input ids, and
 * the model then labels different tokens -- which shows up as a detector that is
 * mysteriously worse than the same model was in Python, with nothing in the code looking
 * wrong. So the golden file holds ids produced by `tokenizers` on the *shipped*
 * vocabulary, and this asserts identity.
 *
 * Regenerate with the snippet in extension/models/README.md if the vocabulary changes.
 */

interface Golden {
  text: string;
  ids: number[];
}

const MODELS = join(process.cwd(), 'extension', 'models');

function tokenizer() {
  const raw = JSON.parse(readFileSync(join(MODELS, 'ner-tokenizer.json'), 'utf8')) as {
    model: { vocab: Array<[string, number]>; unk_id: number };
  };
  return createUnigramTokenizer(raw.model.vocab, raw.model.unk_id);
}

describe('the unigram tokenizer', () => {
  const golden = JSON.parse(
    readFileSync(
      join(process.cwd(), 'extension', 'src', 'offscreen', 'tasks', 'unigram.golden.json'),
      'utf8',
    ),
  ) as Golden[];

  it('has the pruned vocabulary, not the shipped-with-XLM-R one', () => {
    // 250,002 would mean the pruning step did not run and the bundle is 265 MB.
    expect(tokenizer().size).toBe(32_000);
  });

  for (const cas of golden) {
    it(`segments exactly as HuggingFace does: ${cas.text.slice(0, 34)}`, () => {
      const ids = tokenizer()
        .encode(cas.text)
        .map((t) => t.id);
      expect(ids).toEqual(cas.ids);
    });
  }

  it('anchors every piece to the word it came from', () => {
    // The offsets are how a label becomes a box. A piece pointing at the wrong word puts
    // the redaction beside the value rather than on it.
    const text = 'Name Asha Menon';
    const tokens = tokenizer().encode(text);

    for (const token of tokens) {
      expect(text.slice(token.start, token.end)).not.toContain(' ');
      expect(token.end).toBeGreaterThan(token.start);
    }
    expect(tokens.map((t) => text.slice(t.start, t.end))).toContain('Asha');
  });

  it('falls back to unk rather than dead-ending on a pruned character', () => {
    // Korean was pruned out. It must tokenise badly, not throw.
    const tokens = tokenizer().encode('이름 홍길동');
    expect(tokens.length).toBeGreaterThan(0);
  });
});
