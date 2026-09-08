import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLACEHOLDER_CLASSES } from '../../extension/src/shared/placeholders';

/**
 * The label tool is a plain HTML page with no build step, so it cannot import the frozen
 * vocabulary and keeps its own copy. A second copy of a list is a second list, and the
 * failure mode is quiet: a class gets added, the tool never offers it, and nobody labels
 * it -- so the corpus reports perfect recall on a class it contains no examples of.
 *
 * The same argument as scripts/demo-fixtures.test.ts. A comment saying "keep these in
 * sync" is not a mechanism.
 */
describe('the label tool offers the frozen vocabulary', () => {
  const source = readFileSync(join(process.cwd(), 'eval', 'label_tool', 'label.js'), 'utf8');

  it('lists exactly the classes the extension allocates', () => {
    const block = source.match(/const CLASSES = \[([\s\S]*?)\];/);
    expect(block, 'CLASSES has moved or been renamed in label.js').toBeTruthy();

    const listed = [...(block?.[1] ?? '').matchAll(/'([A-Z]+)'/g)].map((m) => m[1]);

    expect(
      [...listed].sort(),
      'the label tool and shared/placeholders.ts disagree about the vocabulary',
    ).toEqual([...PLACEHOLDER_CLASSES].sort());
  });
});
