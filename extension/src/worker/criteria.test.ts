/**
 * Judging a leg against the page, and moving the plan on.
 *
 * The loop's own wiring is exercised in router.test.ts; what is settled here is the
 * arithmetic -- which criteria hold against which observation, what a leg's budget means,
 * and what happens to the one that was current when the page turns out differently.
 */

import { describe, expect, it } from 'vitest';
import type { Criterion, Subgoal, SubgoalState } from '../shared/contract';
import type { ObservedElement } from '../shared/observed';
import {
  advancePlan,
  criterionMet,
  documentOf,
  judge,
  matching,
  tokens,
  type Observation,
} from './criteria';
import {
  activeSubgoal,
  adoptPlan,
  advanceProgress,
  emptyProgress,
  type PageBaseline,
  type TaskProgress,
} from './progress';

function element(over: Partial<ObservedElement> = {}): ObservedElement {
  return {
    index: 1,
    role: 'textbox',
    box: { x: 0, y: 0, w: 100, h: 20 },
    state: { visible: true, enabled: true, focused: false, filled: false },
    occluded: 0,
    isNew: false,
    tag: 'input',
    textRuns: [],
    key: 'k1',
    name: '',
    ...over,
  };
}

function observation(over: Partial<Observation> = {}): Observation {
  return { snapshotId: 'doc1.3', origin: 'https://a.test', elements: [], ...over };
}

const BASELINE: PageBaseline = { snapshotId: 'doc1.1', origin: 'https://a.test' };

function leg(over: Partial<SubgoalState> = {}): SubgoalState {
  return {
    id: 'leg-1',
    // Deliberately not `search`: that kind carries a rule of its own (see the block on
    // typing below), and a fixture every other test shares should not carry it too.
    kind: 'interact',
    intent: 'reach the permits page',
    after: [],
    criteria: [],
    budget: 3,
    status: 'active',
    attempts: 1,
    ...over,
  };
}

describe('tokens', () => {
  it('drops words too common to be evidence of anything', () => {
    expect(tokens('the best one for me')).toEqual([]);
  });

  it('drops words shorter than three characters', () => {
    // "id" and "no" appear on every page ever written.
    expect(tokens('an id no 42 permits')).toEqual(['permits']);
  });
});

describe('matching', () => {
  it('finds an element by any word of the hint', () => {
    // The hint came out of a person's sentence and the name out of somebody's page.
    // Requiring every word to line up means "parking permits" never matches "Permits".
    const found = matching([element({ name: 'Permits' })], 'parking permits');
    expect(found).toHaveLength(1);
  });

  it('reads the caption, the placeholder and the text runs, not just the name', () => {
    const hint = 'hydrology';
    expect(matching([element({ placeholder: 'Search hydrology' })], hint)).toHaveLength(1);
    expect(matching([element({ nearbyText: 'Hydrology reports' })], hint)).toHaveLength(1);
    expect(
      matching(
        [element({ textRuns: [{ text: 'Hydrology', box: BOX, nodeIndex: 0 }] })],
        hint,
      ),
    ).toHaveLength(1);
  });

  it('matches nothing on a hint made entirely of common words', () => {
    expect(matching([element({ name: 'anything' })], 'the best one')).toEqual([]);
  });
});

const BOX = { x: 0, y: 0, w: 1, h: 1 };

describe('criterionMet', () => {
  const check = (criterion: Criterion, obs: Observation, progress = emptyProgress()) =>
    criterionMet(criterion, obs, BASELINE, progress);

  it('sees a navigation as a new document nonce, not a new walk count', () => {
    // Two walks of the same document differ only by the counter. That is a repaint.
    expect(check({ check: 'url-changed', hint: '' }, observation({ snapshotId: 'doc1.9' }))).toBe(
      false,
    );
    expect(check({ check: 'url-changed', hint: '' }, observation({ snapshotId: 'doc2.0' }))).toBe(
      true,
    );
  });

  it('sees a change of origin as a navigation too', () => {
    expect(
      check({ check: 'url-changed', hint: '' }, observation({ origin: 'https://b.test' })),
    ).toBe(true);
  });

  it('splits a snapshot id at its last dot', () => {
    expect(documentOf('abc12def.7')).toBe('abc12def');
    expect(documentOf('nodot')).toBe('nodot');
  });

  it('answers element-present and element-gone as opposites', () => {
    const obs = observation({ elements: [element({ name: 'Permits' })] });
    expect(check({ check: 'element-present', hint: 'permits' }, obs)).toBe(true);
    expect(check({ check: 'element-gone', hint: 'permits' }, obs)).toBe(false);
    expect(check({ check: 'element-gone', hint: 'basket' }, obs)).toBe(true);
  });

  it('requires the field it names to actually hold something', () => {
    const empty = observation({ elements: [element({ name: 'Email' })] });
    const full = observation({
      elements: [element({ name: 'Email', state: { ...element().state, filled: true } })],
    });
    expect(check({ check: 'field-filled', hint: 'email' }, empty)).toBe(false);
    expect(check({ check: 'field-filled', hint: 'email' }, full)).toBe(true);
  });

  it('reads action-verified off the ledger, not off the page', () => {
    const progress = advanceProgress(emptyProgress(), {
      stepIndex: 0,
      outcome: 'ok',
      verdicts: [{ target: 'basket', verb: 'click', reason: 'not-applicable' }],
      now: 1,
    });
    expect(check({ check: 'action-verified', hint: 'basket' }, observation(), progress)).toBe(true);
    expect(check({ check: 'action-verified', hint: 'checkout' }, observation(), progress)).toBe(
      false,
    );
  });

  it('does not count an unverified entry as an action verified', () => {
    const progress = advanceProgress(emptyProgress(), {
      stepIndex: 0,
      outcome: 'ok',
      verdicts: [{ target: 'basket', verb: 'click', reason: 'not-done' }],
      now: 1,
    });
    expect(check({ check: 'action-verified', hint: 'basket' }, observation(), progress)).toBe(
      false,
    );
  });
});

describe('judge', () => {
  const verdict = (
    subgoal: SubgoalState,
    obs: Observation,
    lastStepOk = true,
    progress: TaskProgress = emptyProgress(),
  ) => judge({ subgoal, observation: obs, baseline: BASELINE, progress, lastStepOk });

  it('finishes a leg only when every criterion holds', () => {
    const subgoal = leg({
      criteria: [
        { check: 'url-changed', hint: '' },
        { check: 'element-present', hint: 'permits' },
      ],
    });

    // Navigated, but the thing it was looking for is not there yet.
    expect(verdict(subgoal, observation({ snapshotId: 'doc2.0' })).verdict).toBe('continue');

    const both = observation({
      snapshotId: 'doc2.0',
      elements: [element({ name: 'Permits' })],
    });
    expect(verdict(subgoal, both).verdict).toBe('done');
    expect(verdict(subgoal, both).met).toEqual(['url-changed', 'element-present']);
  });

  /**
   * The live amazon.in false success. See `typedDuringLeg` in criteria.ts: the leg's only
   * criterion was satisfied by a nav link that says "Mobiles" on every page of the site,
   * so clicking that link finished the leg and the run reported success with the search
   * box empty.
   */
  describe('a search leg', () => {
    const searching = (over: Partial<SubgoalState> = {}) =>
      leg({
        id: 'search-1',
        kind: 'search',
        intent: 'search for mobiles',
        criteria: [{ check: 'element-present', hint: 'mobiles' }],
        stepIndex: 1,
        ...over,
      });

    const seen = observation({ elements: [element({ name: 'Mobiles' })] });

    function typed(stepIndex: number, verb: 'fill' | 'click' = 'fill'): TaskProgress {
      return advanceProgress(emptyProgress(), {
        stepIndex,
        outcome: 'ok',
        verdicts: [{ target: 'search', verb, reason: 'match' }],
        now: 1,
      });
    }

    it('does not finish on a word that was on the page all along', () => {
      const j = verdict(searching(), seen);
      expect(j.verdict).toBe('continue');
      expect(j.met).toEqual(['element-present']);
      expect(j.unmet).toEqual(['text-entered']);
    });

    it('finishes once the agent has typed and the results are there', () => {
      expect(verdict(searching(), seen, true, typed(1)).verdict).toBe('done');
    });

    it('does not count a click as having searched', () => {
      expect(verdict(searching(), seen, true, typed(1, 'click')).verdict).toBe('continue');
    });

    it('does not count a fill from an earlier leg that it cannot claim', () => {
      const other = advanceProgress(emptyProgress(), {
        stepIndex: 1,
        outcome: 'ok',
        verdicts: [{ target: 'pin code', verb: 'fill', reason: 'match' }],
        now: 1,
      });
      expect(verdict(searching({ stepIndex: 4 }), seen, true, other).verdict).toBe(
        'continue',
      );
    });

    /**
     * Tier 0 reads the whole sentence, not one leg of it. On the live amazon.in run it
     * typed "mobiles" into the search box at step 1, while `navigate-1` was still active
     * and `search-1` had not been started. That fill is the leg's work, done early.
     */
    it('counts a fill from before the leg when the leg names it', () => {
      expect(verdict(searching({ stepIndex: 4 }), seen, true, typed(1)).verdict).toBe('done');
    });

    it('still needs its criteria: typing alone is not a search', () => {
      expect(verdict(searching(), observation(), true, typed(1)).verdict).toBe('continue');
    });
  });

  it('finishes a leg with no criteria when the step that ran it went through', () => {
    // `filter`, `inspect` and `confirm` have no signature that holds on every site.
    // Inventing one would fail legs that succeeded.
    expect(verdict(leg({ kind: 'filter' }), observation(), true).verdict).toBe('done');
    expect(verdict(leg({ kind: 'filter' }), observation(), false).verdict).toBe('continue');
  });

  it('fails a leg only once its budget is spent', () => {
    const criteria: Criterion[] = [{ check: 'element-present', hint: 'permits' }];
    expect(verdict(leg({ criteria, attempts: 2, budget: 3 }), observation()).verdict).toBe(
      'continue',
    );
    expect(verdict(leg({ criteria, attempts: 3, budget: 3 }), observation()).verdict).toBe(
      'failed',
    );
  });

  describe('naming the failure', () => {
    const spent = (over: Partial<SubgoalState>) => leg({ attempts: 3, budget: 3, ...over });

    it('calls a leg whose target never appeared target-missing', () => {
      const j = verdict(
        spent({ criteria: [{ check: 'element-present', hint: 'permits' }] }),
        observation(),
      );
      expect(j.failure).toBe('target-missing');
    });

    it('calls a leg the page navigated out from under page-changed', () => {
      const j = verdict(
        spent({ criteria: [{ check: 'element-present', hint: 'permits' }] }),
        observation({ snapshotId: 'doc2.0' }),
      );
      expect(j.failure).toBe('page-changed');
    });

    it('does not call an expected navigation page-changed', () => {
      // A `navigate` leg that navigated and still did not satisfy its other criteria has
      // not been ambushed by the page; it did what it was for.
      const j = verdict(
        spent({
          criteria: [
            { check: 'url-changed', hint: '' },
            { check: 'element-present', hint: 'permits' },
          ],
        }),
        observation({ snapshotId: 'doc2.0' }),
      );
      expect(j.failure).toBe('target-missing');
    });

    it('calls a leg that asked for a navigation and got none no-effect', () => {
      const j = verdict(spent({ criteria: [{ check: 'url-changed', hint: '' }] }), observation());
      expect(j.failure).toBe('no-effect');
    });

    it('falls back to budget-spent rather than guessing', () => {
      const j = verdict(spent({ criteria: [{ check: 'action-verified', hint: 'basket' }] }), observation());
      expect(j.failure).toBe('budget-spent');
    });
  });
});

describe('advancePlan', () => {
  const legs: Subgoal[] = [
    {
      id: 'navigate-1',
      kind: 'navigate',
      intent: 'reach the portal',
      after: [],
      criteria: [{ check: 'url-changed', hint: '' }],
      budget: 2,
    },
    {
      id: 'search-1',
      kind: 'search',
      intent: 'search for permits',
      after: ['navigate-1'],
      criteria: [{ check: 'element-present', hint: 'permits' }],
      budget: 2,
    },
  ];

  function started(): TaskProgress {
    // The first step: nothing is active yet, so the first ready leg is picked up.
    return advancePlan(adoptPlan(emptyProgress(), legs, 0), {
      observation: observation(),
      stepIndex: 0,
      lastStepOk: false,
      stepsLeft: 10,
    }).progress;
  }

  it('does nothing at all when there is no plan', () => {
    const before = emptyProgress();
    const after = advancePlan(before, {
      observation: observation(),
      stepIndex: 0,
      lastStepOk: true,
      stepsLeft: 10,
    });
    expect(after.progress).toBe(before);
    expect(after.note).toBe('');
  });

  it('picks up the first leg and records the page it starts from', () => {
    const progress = started();
    expect(activeSubgoal(progress)?.id).toBe('navigate-1');
    expect(progress.baseline).toEqual({ snapshotId: 'doc1.3', origin: 'https://a.test' });
    // Charged as soon as it is chosen: an attempt is a step spent on it, whatever the
    // step turns out to produce.
    expect(activeSubgoal(progress)?.attempts).toBe(1);
  });

  it('moves on once the leg is satisfied, and rebaselines the next one', () => {
    const after = advancePlan(started(), {
      observation: observation({ snapshotId: 'doc2.0' }),
      stepIndex: 1,
      lastStepOk: true,
      stepsLeft: 10,
    });

    expect(after.progress.plan[0]?.status).toBe('done');
    expect(activeSubgoal(after.progress)?.id).toBe('search-1');
    expect(after.progress.baseline?.snapshotId).toBe('doc2.0');
    expect(after.note).toContain('navigate-1 done');
    expect(after.note).toContain('search-1 started');
  });

  it('keeps the same leg and charges it again when it is not there yet', () => {
    const after = advancePlan(started(), {
      observation: observation({ snapshotId: 'doc1.4' }),
      stepIndex: 1,
      lastStepOk: true,
      stepsLeft: 10,
    });

    expect(activeSubgoal(after.progress)?.id).toBe('navigate-1');
    expect(activeSubgoal(after.progress)?.attempts).toBe(2);
    // The baseline belongs to the leg, not to the step: re-baselining here would mean a
    // leg could never observe the navigation it was waiting for.
    expect(after.progress.baseline?.snapshotId).toBe('doc1.3');
  });

  it('gives up on a leg once its budget is gone and starts the next', () => {
    let progress = started();
    // Budget 2: one attempt at activation, a second here, and the third judging finds it
    // spent.
    progress = advancePlan(progress, {
      observation: observation({ snapshotId: 'doc1.4' }),
      stepIndex: 1,
      lastStepOk: true,
      stepsLeft: 10,
    }).progress;
    const after = advancePlan(progress, {
      observation: observation({ snapshotId: 'doc1.5' }),
      stepIndex: 2,
      lastStepOk: true,
      stepsLeft: 10,
    });

    expect(after.progress.plan[0]?.status).toBe('failed');
    expect(after.progress.plan[0]?.failure).toBe('no-effect');
    expect(activeSubgoal(after.progress)?.id).toBe('search-1');
    expect(after.note).toContain('navigate-1 no-effect');
  });

  /**
   * A leg that was already done when it was reached. See `alreadyDone` in criteria.ts:
   * tier 0 reads the whole sentence, so the search can be typed and answered a step or
   * two before the plan gets round to the leg that describes it.
   */
  describe('a leg that arrives finished', () => {
    function withFill(progress: TaskProgress, stepIndex: number): TaskProgress {
      return advanceProgress(progress, {
        stepIndex,
        outcome: 'ok',
        verdicts: [{ target: 'search', verb: 'fill', reason: 'match' }],
        now: 1,
      });
    }

    it('is completed without being charged a step', () => {
      const progress = withFill(started(), 0);
      const after = advancePlan(progress, {
        observation: observation({
          snapshotId: 'doc2.0',
          elements: [element({ name: 'Permits' })],
        }),
        stepIndex: 1,
        lastStepOk: true,
        stepsLeft: 10,
      });

      expect(after.progress.plan.map((s) => s.status)).toEqual(['done', 'done']);
      expect(activeSubgoal(after.progress)).toBeUndefined();
      expect(after.note).toContain('search-1 done on arrival');
    });

    it('is not completed on what the page was already showing', () => {
      // Same page, same word, no fill anywhere in the ledger.
      const after = advancePlan(started(), {
        observation: observation({
          snapshotId: 'doc2.0',
          elements: [element({ name: 'Permits' })],
        }),
        stepIndex: 1,
        lastStepOk: true,
        stepsLeft: 10,
      });

      expect(activeSubgoal(after.progress)?.id).toBe('search-1');
      expect(activeSubgoal(after.progress)?.attempts).toBe(1);
    });
  });

  it('stops charging anything once every leg is terminal', () => {
    let progress = started();
    progress = advancePlan(progress, {
      observation: observation({ snapshotId: 'doc2.0' }),
      stepIndex: 1,
      lastStepOk: true,
      stepsLeft: 10,
    }).progress;
    // search-1 is a search: finding the word on the page is not enough, the agent has to
    // have typed it. See `typedDuringLeg`.
    progress = advanceProgress(progress, {
      stepIndex: 1,
      outcome: 'ok',
      verdicts: [{ target: 'permits', verb: 'fill', reason: 'match' }],
      now: 1,
    });
    const done = advancePlan(progress, {
      observation: observation({ snapshotId: 'doc2.1', elements: [element({ name: 'Permits' })] }),
      stepIndex: 2,
      lastStepOk: true,
      stepsLeft: 10,
    });

    expect(done.progress.plan.every((s) => s.status === 'done')).toBe(true);
    expect(activeSubgoal(done.progress)).toBeUndefined();

    const idle = advancePlan(done.progress, {
      observation: observation({ snapshotId: 'doc2.2' }),
      stepIndex: 3,
      lastStepOk: true,
      stepsLeft: 10,
    });
    expect(idle.progress.plan).toEqual(done.progress.plan);
  });

  it('keeps page content out of the note', () => {
    const after = advancePlan(started(), {
      observation: observation({
        snapshotId: 'doc2.0',
        elements: [element({ name: 'Asha Menon' })],
      }),
      stepIndex: 1,
      lastStepOk: true,
      stepsLeft: 10,
    });
    expect(after.note).not.toContain('Asha');
    expect(after.note).toMatch(/^plan \d+\/\d+/);
  });
});
