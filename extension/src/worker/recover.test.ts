/**
 * The recovery ladder.
 *
 * Two properties matter more than any individual mapping. The first is that recovery is
 * bounded: no input produces an endless retry, and every leg reaches a terminal rung. The
 * second is that recovery never repeats a blind action -- `retry` is available exactly
 * once, and only for the one failure where "the page had not finished settling" is a real
 * explanation.
 */

import { describe, expect, it } from 'vitest';
import { MAX_STALLED_STEPS } from '../shared/agent';
import { SUBGOAL_FAILURES, type SubgoalFailure } from '../shared/contract';
import {
  endsTheLeg,
  escalates,
  recoverFrom,
  withStallPressure,
  type Recovery,
} from './recover';

function ladder(
  failure: SubgoalFailure,
  over: { attempts?: number; budget?: number; stalled?: number; stepsLeft?: number } = {},
): Recovery {
  return recoverFrom({
    failure,
    attempts: over.attempts ?? 1,
    budget: over.budget ?? 3,
    stalled: over.stalled ?? 0,
    stepsLeft: over.stepsLeft ?? 20,
  }).recovery;
}

describe('recoverFrom', () => {
  it('answers every failure at every point in a budget', () => {
    // A recovery policy with a hole in it is one that behaves differently depending on
    // which failure the page happened to produce.
    for (const failure of SUBGOAL_FAILURES) {
      for (let attempts = 1; attempts <= 4; attempts++) {
        expect(ladder(failure, { attempts, budget: 3 })).toBeTruthy();
      }
    }
  });

  it('never offers a retry more than once, and only where settling explains it', () => {
    // "The page had not finished settling" is a real explanation for a click that changed
    // nothing. It is not an explanation for anything else, and it is never an explanation
    // twice.
    for (const failure of SUBGOAL_FAILURES) {
      expect(ladder(failure, { attempts: 2 })).not.toBe('retry');
      expect(ladder(failure, { attempts: 3, budget: 3 })).not.toBe('retry');
    }
    expect(ladder('no-effect', { attempts: 1 })).toBe('retry');
    expect(ladder('target-missing', { attempts: 1 })).toBe('re-observe');
  });

  it('reaches a terminal rung by the time the budget is spent', () => {
    for (const failure of SUBGOAL_FAILURES) {
      const recovery = ladder(failure, { attempts: 3, budget: 3 });
      expect(endsTheLeg(recovery)).toBe(true);
    }
  });

  it('climbs rather than repeats as the attempts go by', () => {
    expect(ladder('no-effect', { attempts: 1, budget: 3 })).toBe('retry');
    expect(ladder('no-effect', { attempts: 2, budget: 3 })).toBe('re-resolve');
    expect(ladder('no-effect', { attempts: 3, budget: 3 })).toBe('replan');
  });

  it('never retries a target it has already been told was wrong', () => {
    expect(ladder('wrong-target', { attempts: 1 })).toBe('re-resolve');
    expect(ladder('wrong-target', { attempts: 3, budget: 3 })).toBe('replan');
  });

  it('asks something that can see the page when the device cannot separate candidates', () => {
    expect(ladder('ambiguous', { attempts: 1 })).toBe('escalate');
  });

  it('re-observes rather than acting when the page moved under the leg', () => {
    // Nothing about the leg is known to be wrong; what is wrong is everything it was
    // measured against.
    expect(ladder('page-changed', { attempts: 1 })).toBe('re-observe');
    expect(ladder('page-changed', { attempts: 2 })).toBe('re-observe');
  });

  it('gives up at once on something it may not do unaided', () => {
    // Two more attempts are two more of the same refusal.
    expect(ladder('blocked', { attempts: 1, budget: 10 })).toBe('abandon');
  });

  it('does not ask for a plan the run has no room to carry out', () => {
    expect(ladder('no-effect', { attempts: 3, budget: 3, stepsLeft: 1 })).toBe('abandon');
    expect(ladder('ambiguous', { attempts: 1, stepsLeft: 0 })).toBe('abandon');
  });

  it('says what it decided, in counts and enum names', () => {
    const choice = recoverFrom({
      failure: 'target-missing',
      attempts: 2,
      budget: 3,
      stalled: 0,
      stepsLeft: 10,
    });
    expect(choice.note).toBe('target-missing -> re-resolve (2/3)');
  });
});

describe('which rungs cost what', () => {
  it('marks the rungs that make the next step skip Tier 0', () => {
    const up: Recovery[] = ['re-resolve', 'escalate', 'replan'];
    const flat: Recovery[] = ['retry', 're-observe', 'abandon'];
    expect(up.every(escalates)).toBe(true);
    expect(flat.some(escalates)).toBe(false);
  });

  it('marks the rungs that end the leg', () => {
    const over: Recovery[] = ['replan', 'abandon'];
    const going: Recovery[] = ['retry', 're-observe', 're-resolve', 'escalate'];
    expect(over.every(endsTheLeg)).toBe(true);
    expect(going.some(endsTheLeg)).toBe(false);
  });
});

describe('withStallPressure', () => {
  const choice = (recovery: Recovery) => ({ recovery, note: 'x' });

  it('leaves a run that is still making progress alone', () => {
    expect(withStallPressure(choice('retry'), 0, MAX_STALLED_STEPS).recovery).toBe('retry');
  });

  it('forces a replan once the run has stopped verifying anything', () => {
    // A leg on its first attempt legitimately deserves a retry. A leg on its first attempt
    // in a run that has verified nothing for three steps does not: whatever is wrong is
    // not this leg's first attempt.
    const pressed = withStallPressure(choice('retry'), MAX_STALLED_STEPS - 1, MAX_STALLED_STEPS);
    expect(pressed.recovery).toBe('replan');
    expect(pressed.note).toContain('no progress');
  });

  it('does not promote a leg that was already being abandoned', () => {
    expect(
      withStallPressure(choice('abandon'), MAX_STALLED_STEPS, MAX_STALLED_STEPS).recovery,
    ).toBe('abandon');
  });
});
