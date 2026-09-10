/**
 * The evaluation harness's goal has to reach the gate.
 *
 * `eval/harness.py` scores perception and redaction from the sealed payload, so a step the
 * device answers by itself produces nothing to score. That is correct behaviour -- nothing
 * was sent, so there was nothing to redact -- and it is also the harness measuring nothing
 * while reporting a failure.
 *
 * The previous goal, "Review this page and fill in whatever the form needs", parses to no
 * intents and reaches Tier 2 as `open-ended`. Tier 2 asks the local reader before paying
 * for a screenshot (router.ts), so on a machine where that reader answers, every page ends
 * device-only. Measured: one run scored 48 of 50 pages and the next scored 4 of 25, with
 * no source change in between. Nothing in either repository asserted the connection
 * between the sentence in a Python constant and a carve-out in a TypeScript function, so
 * nothing went red -- it just stopped measuring.
 *
 * This is that assertion. It reads the constant out of the harness rather than restating
 * it, because a copy would drift in exactly the way this exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isReadingTask, parseGoal } from './intent';
import { chooseTier } from './tiers';

const HARNESS = resolve(import.meta.dirname, '../../../eval/harness.py');

/** The `GOAL = "..."` line in eval/harness.py. */
function harnessGoal(): string {
  const source = readFileSync(HARNESS, 'utf8');
  const match = /^GOAL = "([^"]+)"$/m.exec(source);
  if (!match?.[1]) {
    throw new Error('eval/harness.py no longer declares GOAL as a single double-quoted string');
  }
  return match[1];
}

describe('the corpus harness goal', () => {
  it('is a reading task, so the local reader is skipped', () => {
    // This is the whole mechanism. `isReadingTask` is the one condition under which Tier 2
    // does not consult the on-device reader first, and consulting it is what ends the step
    // before anything is sealed.
    expect(isReadingTask(harnessGoal())).toBe(true);
  });

  it('reaches Tier 2, so a frame is sealed and posted', () => {
    const goal = harnessGoal();
    const parsed = parseGoal(goal);
    const choice = chooseTier(
      { intents: parsed.intents, ...(parsed.block ? { block: parsed.block } : {}) },
      [],
    );

    expect(choice.tier).toBe(2);
  });

  it('names no field, so Tier 0 has nothing to resolve', () => {
    // A goal that parsed into intents would be answered on the device on a page that has
    // those fields, which is the same failure by a shorter route.
    expect(parseGoal(harnessGoal()).intents).toEqual([]);
  });

  it('would have caught the goal this replaced', () => {
    // The regression, stated as a test rather than as a comment.
    expect(isReadingTask('Review this page and fill in whatever the form needs')).toBe(false);
  });
});
