/**
 * The progress ledger: the run's memory of what it has actually accomplished.
 *
 * These tests are about the transitions, not the plumbing. The router-level proof that a
 * multi-step run no longer forgets step 1 by the time it reaches step 3 lives in
 * router.test.ts, under "multi-step progress".
 */

import { describe, expect, it } from 'vitest';
import { MAX_TARGET_ATTEMPTS } from '../shared/agent';
import { memoryStore } from '../shared/store';
import type { Fulfilment } from './complete';
import { assessCompletion } from './complete';
import type { Intent } from './intent';
import { startTask } from './loop';
import type { Subgoal } from '../shared/contract';
import {
  activateSubgoal,
  activeSubgoal,
  adoptPlan,
  advanceProgress,
  attemptsFor,
  chargeSubgoal,
  completeSubgoal,
  describePlan,
  failSubgoal,
  nextSubgoal,
  planFinished,
  verifiedWork,
  describeProgress,
  emptyProgress,
  exhaustedTargets,
  isVerified,
  markComplete,
  progressFulfilments,
  progressKey,
  verifiedTargets,
  type TaskProgress,
} from './progress';
import { freshState, loadState, saveState, STATE_KEY } from './state';

function filled(target: string, reason: Fulfilment['reason'] = 'match'): Fulfilment {
  return { target, verb: 'fill', reason };
}

/** Run a sequence of steps through the ledger, the way `finish` does. */
function run(
  steps: Array<{ verdicts: Fulfilment[]; outcome?: 'ok' | 'failed' | 'incomplete' }>,
): TaskProgress {
  let progress = emptyProgress();
  steps.forEach((step, i) => {
    progress = advanceProgress(progress, {
      stepIndex: i,
      outcome: step.outcome ?? 'ok',
      verdicts: step.verdicts,
      now: 1000 + i,
    });
  });
  return progress;
}

describe('progress ledger', () => {
  describe('keys', () => {
    it('treats the same field named differently-cased as one piece of work', () => {
      expect(progressKey('fill', 'First Name')).toBe(progressKey('fill', ' first name '));
    });

    it('keeps different verbs on the same target apart', () => {
      expect(progressKey('fill', 'search')).not.toBe(progressKey('click', 'search'));
    });
  });

  describe('accumulating across steps', () => {
    it('remembers a step verified three steps ago', () => {
      const progress = run([
        { verdicts: [filled('first name')] },
        { verdicts: [] },
        { verdicts: [filled('last name')] },
      ]);

      expect(verifiedTargets(progress)).toEqual(
        new Set([progressKey('fill', 'first name'), progressKey('fill', 'last name')]),
      );
      expect(describeProgress(progress)).toBe('progress 2/2');
    });

    it('records the step that settled each entry', () => {
      const progress = run([
        { verdicts: [filled('first name')] },
        { verdicts: [filled('last name')] },
      ]);

      const first = progress.entries.find((e) => e.target === 'first name');
      const last = progress.entries.find((e) => e.target === 'last name');
      expect(first?.stepIndex).toBe(0);
      expect(last?.stepIndex).toBe(1);
    });

    it('keeps a verified entry verified when a later step cannot find the field', () => {
      // Navigation makes every field of the previous page read back as `missing`. A ledger
      // that downgraded on that would erase the run's work at the first page transition.
      const progress = run([
        { verdicts: [filled('first name')] },
        { verdicts: [filled('first name', 'missing')] },
      ]);

      expect(isVerified(progress, 'fill', 'first name')).toBe(true);
      // The latest verdict is still on the record, so nothing is being hidden.
      expect(progress.entries[0]?.reason).toBe('missing');
      expect(progress.entries[0]?.stepIndex).toBe(0);
    });

    it('counts a click the executor carried out as done', () => {
      // `not-applicable` is what a click gets: there is no value to read back and the
      // executor did not fail. complete.ts treats it as fulfilled; so must the ledger.
      const progress = run([
        { verdicts: [{ target: 'submit', verb: 'click', reason: 'not-applicable' }] },
      ]);

      expect(isVerified(progress, 'click', 'submit')).toBe(true);
      expect(progressFulfilments(progress)[0]?.reason).toBe('not-applicable');
    });
  });

  describe('a failed step is not progress', () => {
    it('does not mark an unverified target complete', () => {
      const progress = run([{ verdicts: [filled('first name', 'empty')] }]);

      expect(isVerified(progress, 'fill', 'first name')).toBe(false);
      expect(progress.entries[0]?.status).toBe('unverified');
      expect(describeProgress(progress)).toBe('progress 0/1');
    });

    it('reports an action the executor could not carry out as failed', () => {
      const progress = run([
        { verdicts: [{ target: 'submit', verb: 'click', reason: 'not-done' }] },
      ]);

      expect(progress.entries[0]?.status).toBe('failed');
    });

    it('never lets a failed step be reported as fulfilled to the completion check', () => {
      const progress = run([{ verdicts: [filled('email', 'differs')] }]);
      const completion = assessCompletion({
        intents: [{ verb: 'fill', target: 'email' }],
        residue: [],
        fulfilments: progressFulfilments(progress),
        sent: false,
      });

      expect(completion.complete).toBe(false);
      expect(completion.outstanding[0]).toContain('holds something else');
    });
  });

  describe('bounded retry', () => {
    it('counts consecutive failed steps and resets on a good one', () => {
      let progress = run([
        { verdicts: [], outcome: 'failed' },
        { verdicts: [], outcome: 'failed' },
      ]);
      expect(progress.retries).toBe(2);

      progress = advanceProgress(progress, {
        stepIndex: 2,
        outcome: 'ok',
        verdicts: [filled('first name')],
        now: 3000,
      });
      expect(progress.retries).toBe(0);
    });

    it('counts attempts per target and reports the exhausted ones', () => {
      const attempt = { verdicts: [filled('first name', 'empty')] };
      const progress = run(Array.from({ length: MAX_TARGET_ATTEMPTS }, () => attempt));

      expect(attemptsFor(progress, 'fill', 'first name')).toBe(MAX_TARGET_ATTEMPTS);
      expect(exhaustedTargets(progress, MAX_TARGET_ATTEMPTS)).toHaveLength(1);
    });

    it('does not report a target that eventually succeeded as exhausted', () => {
      const progress = run([
        { verdicts: [filled('first name', 'empty')] },
        { verdicts: [filled('first name', 'empty')] },
        { verdicts: [filled('first name')] },
      ]);

      expect(exhaustedTargets(progress, MAX_TARGET_ATTEMPTS)).toHaveLength(0);
      expect(attemptsFor(progress, 'fill', 'first name')).toBe(3);
    });

    it('counts steps that verify nothing new as stalled', () => {
      const progress = run([
        { verdicts: [filled('first name')] },
        { verdicts: [] },
        { verdicts: [] },
      ]);

      expect(progress.stalled).toBe(2);
    });

    it('clears the stall the moment something new is verified', () => {
      const progress = run([
        { verdicts: [] },
        { verdicts: [] },
        { verdicts: [filled('first name')] },
      ]);

      expect(progress.stalled).toBe(0);
    });

    it('re-verifying the same target does not clear the stall', () => {
      // Otherwise a loop that re-confirms the one field it has already filled looks like
      // forward motion for as long as the step budget lasts.
      const progress = run([
        { verdicts: [filled('first name')] },
        { verdicts: [filled('first name')] },
        { verdicts: [filled('first name')] },
      ]);

      expect(progress.stalled).toBe(2);
    });
  });

  describe('an interrupted step is not a failure', () => {
    it('leaves every counter alone when the service worker was killed mid-step', () => {
      const before = run([{ verdicts: [filled('first name')] }, { verdicts: [], outcome: 'failed' }]);
      const after = advanceProgress(before, {
        stepIndex: 2,
        outcome: 'interrupted',
        verdicts: [],
        now: 5000,
      });

      expect(after).toEqual(before);
    });

    it('leaves the ledger alone when the operator stopped the run', () => {
      const before = run([{ verdicts: [filled('first name')] }]);
      const after = advanceProgress(before, {
        stepIndex: 1,
        outcome: 'stopped',
        verdicts: [],
        now: 5000,
      });

      expect(after).toEqual(before);
    });
  });

  describe('completion', () => {
    it('is not complete until every intent has a verdict', () => {
      const intents: Intent[] = [
        { verb: 'fill', target: 'first name' },
        { verb: 'fill', target: 'last name' },
      ];
      const partial = run([{ verdicts: [filled('first name')] }]);

      expect(
        assessCompletion({
          intents,
          residue: [],
          fulfilments: progressFulfilments(partial),
          sent: false,
        }).complete,
      ).toBe(false);

      const whole = advanceProgress(partial, {
        stepIndex: 1,
        outcome: 'ok',
        verdicts: [filled('last name')],
        now: 2000,
      });

      expect(
        assessCompletion({
          intents,
          residue: [],
          fulfilments: progressFulfilments(whole),
          sent: false,
        }).complete,
      ).toBe(true);
    });

    it('only seals the ledger through markComplete', () => {
      const progress = run([{ verdicts: [filled('first name')] }]);
      expect(progress.complete).toBe(false);
      expect(markComplete(progress).complete).toBe(true);
      // Advancing a sealed ledger does not unseal it.
      const later = advanceProgress(markComplete(progress), {
        stepIndex: 1,
        outcome: 'ok',
        verdicts: [],
        now: 3000,
      });
      expect(later.complete).toBe(true);
    });
  });

  describe('surviving a service-worker kill', () => {
    it('round-trips through storage with the verdicts intact', async () => {
      const store = memoryStore();
      const state = {
        ...startTask(freshState(), {
          sessionId: 's1',
          goal: 'fill first name and last name',
          tabId: 4,
          intents: [
            { verb: 'fill' as const, target: 'first name' },
            { verb: 'fill' as const, target: 'last name' },
          ],
          now: 1000,
        }),
        progress: run([{ verdicts: [filled('first name')] }]),
      };
      await saveState(store, state);

      // MV3 kills the worker. The next wake reads the record back from scratch.
      const resumed = await loadState(store);

      expect(isVerified(resumed.progress, 'fill', 'first name')).toBe(true);
      expect(isVerified(resumed.progress, 'fill', 'last name')).toBe(false);
      expect(resumed.progress.entries[0]?.attempts).toBe(1);
    });

    it('does not repeat work the page already confirmed', async () => {
      const store = memoryStore();
      await saveState(store, {
        ...freshState(),
        sessionId: 's1',
        status: 'running',
        progress: run([
          { verdicts: [filled('first name')] },
          { verdicts: [{ target: 'submit', verb: 'click', reason: 'not-applicable' }] },
        ]),
      });

      const resumed = await loadState(store);
      const done = verifiedTargets(resumed.progress);

      // What a resumed run must not plan again.
      expect(done.has(progressKey('fill', 'first name'))).toBe(true);
      expect(done.has(progressKey('click', 'submit'))).toBe(true);
      expect(done.has(progressKey('fill', 'last name'))).toBe(false);
    });

    it('tolerates a record written before the ledger existed', async () => {
      const store = memoryStore();
      // Exactly what an older build left behind: no `progress` key at all.
      const legacy = { ...freshState(), sessionId: 's1', status: 'running' as const };
      delete (legacy as Partial<typeof legacy>).progress;
      await store.set(STATE_KEY, legacy);

      const resumed = await loadState(store);
      expect(resumed.progress).toEqual(emptyProgress());
      expect(resumed.sessionId).toBe('s1');
    });

    it('starts a new task with an empty ledger', () => {
      const carried = {
        ...freshState(),
        progress: run([{ verdicts: [filled('first name')] }]),
      };
      const next = startTask(carried, {
        sessionId: 's2',
        goal: 'something else entirely',
        tabId: 9,
        now: 2000,
      });

      // A new goal inheriting the old goal's verified work would inherit a completion it
      // never earned.
      expect(next.progress).toEqual(emptyProgress());
    });
  });

  describe('what the ledger is allowed to hold', () => {
    it('carries no value, only the field name the user typed', () => {
      const progress = advanceProgress(emptyProgress(), {
        stepIndex: 0,
        outcome: 'ok',
        verdicts: [{ target: 'aadhaar number', verb: 'fill', reason: 'match' }],
        now: 1000,
      });

      const serialised = JSON.stringify(progress);
      expect(serialised).toContain('aadhaar number');
      // The ledger is handed verdicts, never values, and has nowhere to put one.
      expect(Object.keys(progress.entries[0] ?? {}).sort()).toEqual([
        'at',
        'attempts',
        'key',
        'reason',
        'status',
        'stepIndex',
        'target',
        'verb',
      ]);
    });

    it('survives a whole run without growing an entry per attempt', () => {
      const progress = run(
        Array.from({ length: 12 }, () => ({ verdicts: [filled('first name', 'empty')] })),
      );

      expect(progress.entries).toHaveLength(1);
      expect(progress.entries[0]?.attempts).toBe(12);
    });
  });
});

/**
 * The decomposition side of the ledger: which leg is current, what unblocks what, and
 * what a replan is allowed to undo.
 */
describe('plan ledger', () => {
  const leg = (id: string, over: Partial<Subgoal> = {}): Subgoal => ({
    id,
    kind: 'interact',
    intent: `do ${id}`,
    after: [],
    criteria: [],
    budget: 3,
    ...over,
  });

  function planned(...subgoals: Subgoal[]): TaskProgress {
    return adoptPlan(emptyProgress(), subgoals, 0);
  }

  describe('readiness', () => {
    it('makes a leg with no dependencies eligible at once', () => {
      const progress = planned(leg('a'));
      expect(progress.plan[0]?.status).toBe('ready');
      expect(nextSubgoal(progress)?.id).toBe('a');
    });

    it('holds a leg back until what it waits on is done', () => {
      let progress = planned(leg('a'), leg('b', { after: ['a'] }));
      expect(progress.plan[1]?.status).toBe('blocked');
      expect(nextSubgoal(progress)?.id).toBe('a');

      progress = completeSubgoal(progress, 'a', 1);
      expect(progress.plan[1]?.status).toBe('ready');
      expect(nextSubgoal(progress)?.id).toBe('b');
    });

    it('treats a dependency on a leg that no longer exists as satisfied', () => {
      // A replan that renames a leg must not strand everything waiting on the old name.
      const progress = planned(leg('b', { after: ['gone'] }));
      expect(progress.plan[0]?.status).toBe('ready');
    });

    it('lets a skipped leg unblock what was waiting on it', () => {
      let progress = planned(leg('a'), leg('b', { after: ['a'] }));
      progress = adoptPlan(progress, [leg('b', { after: ['a'] })], 1);

      expect(progress.plan.find((s) => s.id === 'a')?.status).toBe('skipped');
      expect(progress.plan.find((s) => s.id === 'b')?.status).toBe('ready');
    });
  });

  describe('one leg at a time', () => {
    it('stands the previous leg down when another is activated', () => {
      let progress = planned(leg('a'), leg('b'));
      progress = activateSubgoal(progress, 'a', 0);
      expect(activeSubgoal(progress)?.id).toBe('a');

      progress = activateSubgoal(progress, 'b', 1);
      expect(activeSubgoal(progress)?.id).toBe('b');
      expect(progress.plan.filter((s) => s.status === 'active')).toHaveLength(1);
      expect(progress.plan[0]?.status).toBe('ready');
    });

    it('prefers the active leg over the first ready one', () => {
      let progress = planned(leg('a'), leg('b'));
      progress = activateSubgoal(progress, 'b', 0);
      expect(nextSubgoal(progress)?.id).toBe('b');
    });
  });

  describe('bounded attempts', () => {
    it('sends a leg back to ready while it still has budget', () => {
      let progress = planned(leg('a', { budget: 3 }));
      progress = chargeSubgoal(activateSubgoal(progress, 'a', 0), 'a');
      progress = failSubgoal(progress, 'a', 'no-effect', 0);

      expect(progress.plan[0]?.status).toBe('ready');
      expect(progress.plan[0]?.failure).toBe('no-effect');
      expect(progress.plan[0]?.attempts).toBe(1);
    });

    it('fails a leg for good once its budget is spent', () => {
      let progress = planned(leg('a', { budget: 2 }));
      for (let step = 0; step < 2; step++) {
        progress = chargeSubgoal(activateSubgoal(progress, 'a', step), 'a');
        progress = failSubgoal(progress, 'a', 'no-effect', step);
      }

      expect(progress.plan[0]?.status).toBe('failed');
      // The reason the caller gave survives becoming terminal: "we tried twice" is
      // already visible from `attempts`, and "nothing happened" is not visible anywhere
      // else.
      expect(progress.plan[0]?.failure).toBe('no-effect');
    });

    it('fails a blocked leg immediately, whatever its budget says', () => {
      // `blocked` means the agent may not do this unaided. Trying twice more is not
      // recovery, it is two more of the same refusal.
      let progress = planned(leg('a', { budget: 10 }));
      progress = failSubgoal(progress, 'a', 'blocked', 0);

      expect(progress.plan[0]?.status).toBe('failed');
      expect(progress.plan[0]?.failure).toBe('blocked');
    });

    it('does not repeat a leg the page confirmed', () => {
      let progress = planned(leg('a'), leg('b'));
      progress = completeSubgoal(progress, 'a', 0);

      expect(nextSubgoal(progress)?.id).toBe('b');
      expect(progress.plan[0]?.status).toBe('done');
    });
  });

  describe('replanning', () => {
    it('keeps the progress of a leg the new plan reuses by id', () => {
      let progress = planned(leg('a'), leg('b', { after: ['a'] }));
      progress = completeSubgoal(progress, 'a', 1);
      progress = chargeSubgoal(progress, 'b');

      progress = adoptPlan(
        progress,
        [leg('a'), leg('b', { after: ['a'], intent: 'do b, differently' }), leg('c')],
        2,
      );

      // The replan reworded `b` and must not have un-finished `a` or forgotten the
      // attempt already spent on `b`.
      expect(progress.plan.find((s) => s.id === 'a')?.status).toBe('done');
      expect(progress.plan.find((s) => s.id === 'b')?.attempts).toBe(1);
      expect(progress.plan.find((s) => s.id === 'b')?.intent).toBe('do b, differently');
      expect(progress.plan.find((s) => s.id === 'c')?.status).toBe('ready');
    });

    it('keeps a dropped leg on the record rather than deleting it', () => {
      let progress = planned(leg('a'), leg('b'));
      progress = completeSubgoal(progress, 'a', 0);
      progress = adoptPlan(progress, [leg('a')], 1);

      const dropped = progress.plan.find((s) => s.id === 'b');
      expect(dropped?.status).toBe('skipped');
    });

    it('does not let a replan revive a leg the page already confirmed', () => {
      let progress = planned(leg('a'));
      progress = completeSubgoal(progress, 'a', 0);
      progress = adoptPlan(progress, [leg('a')], 1);

      expect(progress.plan[0]?.status).toBe('done');
    });
  });

  describe('finishing', () => {
    it('is not finished while a leg is still ready', () => {
      let progress = planned(leg('a'), leg('b'));
      progress = completeSubgoal(progress, 'a', 0);
      expect(planFinished(progress)).toBe(false);
    });

    it('is finished when every leg is terminal and one of them succeeded', () => {
      let progress = planned(leg('a'), leg('b', { budget: 1 }));
      progress = completeSubgoal(progress, 'a', 0);
      progress = chargeSubgoal(progress, 'b');
      progress = failSubgoal(progress, 'b', 'no-effect', 1);

      expect(planFinished(progress)).toBe(true);
      expect(describePlan(progress)).toBe('plan 1/2');
    });

    it('is not finished when nothing succeeded', () => {
      let progress = planned(leg('a', { budget: 1 }));
      progress = chargeSubgoal(progress, 'a');
      progress = failSubgoal(progress, 'a', 'target-missing', 0);

      expect(planFinished(progress)).toBe(false);
    });

    it('is not finished when there is no plan at all', () => {
      expect(planFinished(emptyProgress())).toBe(false);
      expect(describePlan(emptyProgress())).toBe('');
    });
  });

  it('survives a service-worker kill with its statuses intact', async () => {
    const store = memoryStore();
    let progress = planned(leg('a'), leg('b', { after: ['a'] }));
    progress = completeSubgoal(progress, 'a', 0);
    progress = activateSubgoal(progress, 'b', 1);
    await saveState(store, { ...freshState(), sessionId: 's1', progress });

    const resumed = await loadState(store);
    expect(activeSubgoal(resumed.progress)?.id).toBe('b');
    expect(resumed.progress.plan.find((s) => s.id === 'a')?.status).toBe('done');
  });
});

describe('a failed leg does not deadlock the plan', () => {
  it('lets the leg behind it run', () => {
    // `after` is the order the sentence was written in, not a hard precondition. A dead
    // leg that blocked everything behind it would leave the plan with nothing active and
    // the run ending on the stall counter rather than on anything it learned.
    let progress = adoptPlan(
      emptyProgress(),
      [
        {
          id: 'navigate-1',
          kind: 'navigate',
          intent: 'reach the site',
          after: [],
          criteria: [],
          budget: 1,
        },
        {
          id: 'search-1',
          kind: 'search',
          intent: 'search for the thing',
          after: ['navigate-1'],
          criteria: [],
          budget: 2,
        },
      ],
      0,
    );
    progress = chargeSubgoal(progress, 'navigate-1');
    progress = failSubgoal(progress, 'navigate-1', 'no-effect', 0);

    expect(progress.plan[0]?.status).toBe('failed');
    expect(nextSubgoal(progress)?.id).toBe('search-1');
  });

  it('still refuses to call the plan finished when nothing succeeded', () => {
    let progress = adoptPlan(
      emptyProgress(),
      [{ id: 'a', kind: 'navigate', intent: 'go', after: [], criteria: [], budget: 1 }],
      0,
    );
    progress = chargeSubgoal(progress, 'a');
    progress = failSubgoal(progress, 'a', 'no-effect', 0);
    expect(planFinished(progress)).toBe(false);
  });
});

describe('verifiedWork', () => {
  it('says what was done, in the words the user used', () => {
    let progress = advanceProgress(emptyProgress(), {
      stepIndex: 0,
      outcome: 'ok',
      verdicts: [
        { target: 'from', verb: 'fill', reason: 'match' },
        { target: 'flexible with date', verb: 'click', reason: 'not-applicable' },
        { target: 'to', verb: 'fill', reason: 'empty' },
      ],
      now: 1,
    });

    // The unverified one is absent: this list is what the page *confirmed*, and telling a
    // model that an empty field is done is how a field stays empty.
    expect(verifiedWork(progress)).toEqual([
      'filled "from"',
      'clicked "flexible with date"',
    ]);

    progress = emptyProgress();
    expect(verifiedWork(progress)).toEqual([]);
  });
});
