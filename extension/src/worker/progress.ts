/**
 * What the task has actually achieved so far, across steps.
 *
 * ## The gap this closes
 *
 * Before this module the loop's only memory of progress was `stepIndex` -- a counter --
 * and `log`, which is prose. Verification existed but was per-step and thrown away:
 * `settle` produced `ctx.fulfilments`, `assessCompletion` read them once, at the moment
 * the plan said `finish`, and nothing carried a verdict from one step to the next.
 *
 * That is fine for a one-step task and wrong for every other kind. A run that fills the
 * first name on step 1 and the last name on step 3 reaches `finish` holding only step 3's
 * verdicts, so the completion check -- which correctly treats an intent with no verdict as
 * never attempted -- reports `"first name" was never acted on` about a field the agent had
 * filled two steps earlier, and the session ends `incomplete`. The check was not wrong; it
 * was being handed a list that had already forgotten most of the run.
 *
 * So: one ledger, keyed by what the user asked for, folded forward on every step and
 * persisted with the rest of the state. `assessCompletion` reads the ledger instead of one
 * step's leftovers, and a step that was verified stays verified across a service-worker
 * kill.
 *
 * ## Why `verified` is sticky
 *
 * An entry never goes back from `verified` to anything else. The alternative sounds more
 * honest and is not: the moment the agent navigates, every field it filled on the previous
 * page reads back as `missing`, and a ledger that downgrades on `missing` would erase the
 * whole run's work at the first page transition and then propose doing it all again. The
 * verdict is a statement about a moment -- "at step 3 the page held this value" -- and
 * `stepIndex` on the entry says which moment, so nothing is being hidden.
 *
 * ## What may live here
 *
 * `target` is the field name out of the user's own sentence, which `AgentState.intents`
 * already persists, or the abstract `field [7]` fallback. A verb and a `VerifyReason` are
 * enum members. No value, no element text, no page content -- this record goes to
 * `chrome.storage.session`, where the redaction gate cannot reach it.
 *
 * Node-pure: reducers over plain data, no I/O, no browser globals.
 */

import type { StepOutcome } from '../shared/agent';
import type { Subgoal, SubgoalFailure, SubgoalState } from '../shared/contract';
import type { VerifyReason } from '../shared/messages';
import type { Fulfilment } from './complete';
import type { IntentVerb } from './intent';

/**
 * Where one target stands.
 *
 *   pending      attempted, no verdict has arrived yet
 *   verified     the page agreed the work was done. Terminal.
 *   unverified   the work was attempted and the page did not confirm it
 *   failed       the executor could not carry the action out at all
 */
export type ProgressStatus = 'pending' | 'verified' | 'unverified' | 'failed';

/** One thing the task is trying to accomplish, and what the page said about it. */
export interface ProgressEntry {
  /** Stable across steps and across a resume: `${verb} ${normalised target}`. */
  key: string;
  /** The field name the user used, or `field [7]` when nobody could name it. */
  target: string;
  verb: IntentVerb;
  status: ProgressStatus;
  /** The latest verdict. Kept even once `status` is terminal, for the operator. */
  reason: VerifyReason;
  /** How many steps have acted on this target. The per-target retry budget. */
  attempts: number;
  /** The step whose verdict settled `status`. */
  stepIndex: number;
  /** When `status` last changed. */
  at: number;
}

/** The whole task's progress. One of these lives on AgentState. */
export interface TaskProgress {
  /** In first-seen order, so the panel reads like the sentence the user typed. */
  entries: ProgressEntry[];
  /** Consecutive failed steps. Reset by any step that ends `ok`. */
  retries: number;
  /** Consecutive steps that verified nothing new. The no-progress detector. */
  stalled: number;
  /** Steps folded into this ledger. Distinct from AgentState.stepIndex, which counts
   *  only the steps that ended `ok`. */
  observed: number;
  /**
   * How the task has been broken up, and where each leg stands.
   *
   * The wire shape from contract.ts, not a device-only twin of it: the same record is
   * what the step request carries, so a planner asked to replan sees exactly the statuses
   * the loop is acting on. Empty until something decomposes the goal.
   */
  plan: SubgoalState[];
  /**
   * What the page looked like when the current leg was activated.
   *
   * A criterion like `url-changed` is a comparison, and a comparison needs the other
   * side of it. Kept here rather than on the subgoal because `SubgoalState` is the wire
   * shape and this is device-only -- it is not something a planner has any use for.
   */
  baseline: PageBaseline | null;
  /** The completion check has passed. Only `markComplete` sets it. */
  complete: boolean;
}

/**
 * The page a leg started against, in the two facts that are safe to persist.
 *
 * The random half of `snapshotId` is minted once per document (content/index.ts), so a
 * change in it is a navigation and nothing else. The URL and the title are deliberately
 * absent: state.ts is explicit that a query string carries identifiers and a title
 * carries names, and a criterion is not a good enough reason to put either into browser
 * storage.
 */
export interface PageBaseline {
  snapshotId: string;
  origin: string;
}

export function emptyProgress(): TaskProgress {
  return {
    entries: [],
    plan: [],
    baseline: null,
    retries: 0,
    stalled: 0,
    observed: 0,
    complete: false,
  };
}

/** Two clauses naming the same field in different words are the same work. */
export function progressKey(verb: IntentVerb, target: string): string {
  return `${verb} ${target.trim().toLowerCase()}`;
}

/** What a verdict means for the ledger. */
function statusFor(reason: VerifyReason): ProgressStatus {
  switch (reason) {
    // The page holds the value, or there was never a value to read back and the executor
    // carried the action out. `complete.ts` treats both as fulfilled; so does this.
    case 'match':
    case 'not-applicable':
      return 'verified';
    case 'not-done':
      return 'failed';
    case 'differs':
    case 'empty':
    case 'missing':
    case 'unresolved':
      return 'unverified';
  }
}

export interface StepAdvance {
  stepIndex: number;
  outcome: StepOutcome;
  /** What `settle` read back this step. Empty when the step verified nothing. */
  verdicts: readonly Fulfilment[];
  now: number;
}

/**
 * Fold one step's verdicts into the ledger. The single state transition.
 *
 * Deterministic and total: same ledger plus same step yields the same ledger, and every
 * outcome has a defined effect. Nothing here reads a clock or a store.
 */
export function advanceProgress(progress: TaskProgress, step: StepAdvance): TaskProgress {
  // A step the service worker killed produced nothing to fold and must not count against
  // either budget: MV3 terminates idle workers routinely and that is not the task failing.
  if (step.outcome === 'interrupted' || step.outcome === 'stopped') {
    return progress;
  }

  const entries = progress.entries.map((entry) => ({ ...entry }));
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const verifiedBefore = countVerified(entries);

  for (const verdict of step.verdicts) {
    const key = progressKey(verdict.verb, verdict.target);
    const status = statusFor(verdict.reason);
    const existing = byKey.get(key);

    if (!existing) {
      const fresh: ProgressEntry = {
        key,
        target: verdict.target,
        verb: verdict.verb,
        status,
        reason: verdict.reason,
        attempts: 1,
        stepIndex: step.stepIndex,
        at: step.now,
      };
      entries.push(fresh);
      byKey.set(key, fresh);
      continue;
    }

    existing.attempts += 1;
    // Sticky: see the note at the top of the file. The verdict is still recorded, so an
    // operator can see that a verified field later read back as missing.
    existing.reason = verdict.reason;
    if (existing.status !== 'verified') {
      existing.status = status;
      existing.stepIndex = step.stepIndex;
      existing.at = step.now;
    }
  }

  const gained = countVerified(entries) > verifiedBefore;

  return {
    entries,
    plan: progress.plan,
    baseline: progress.baseline,
    retries: step.outcome === 'ok' ? 0 : progress.retries + 1,
    stalled: gained ? 0 : progress.stalled + 1,
    observed: progress.observed + 1,
    complete: progress.complete,
  };
}

function countVerified(entries: readonly ProgressEntry[]): number {
  let n = 0;
  for (const entry of entries) if (entry.status === 'verified') n++;
  return n;
}

/** Seal the ledger. Only the completion check may call this, and only once it passes. */
export function markComplete(progress: TaskProgress): TaskProgress {
  return progress.complete ? progress : { ...progress, complete: true };
}

/**
 * The ledger as verdicts, for `assessCompletion`.
 *
 * One per target rather than one per attempt: the completion check asks "is this done",
 * and three attempts at the same field is one answer, not three.
 */
export function progressFulfilments(progress: TaskProgress): Fulfilment[] {
  return progress.entries.map((entry) => ({
    target: entry.target,
    verb: entry.verb,
    // A sticky `verified` reports as fulfilled even when the latest read-back was
    // `missing`, which is the whole point of it being sticky.
    reason: entry.status === 'verified' ? verifiedReason(entry) : entry.reason,
  }));
}

/** What a verified entry reports as. Preserved so `not-applicable` stays distinguishable. */
function verifiedReason(entry: ProgressEntry): VerifyReason {
  return entry.reason === 'not-applicable' ? 'not-applicable' : 'match';
}

/** Targets the page has confirmed. What must not be attempted again after a resume. */
export function verifiedTargets(progress: TaskProgress): ReadonlySet<string> {
  const done = new Set<string>();
  for (const entry of progress.entries) {
    if (entry.status === 'verified') done.add(entry.key);
  }
  return done;
}

/** Has this exact piece of work already been confirmed? */
export function isVerified(
  progress: TaskProgress,
  verb: IntentVerb,
  target: string,
): boolean {
  const key = progressKey(verb, target);
  return progress.entries.some((e) => e.key === key && e.status === 'verified');
}

/** How many steps have acted on this target. */
export function attemptsFor(
  progress: TaskProgress,
  verb: IntentVerb,
  target: string,
): number {
  const key = progressKey(verb, target);
  return progress.entries.find((e) => e.key === key)?.attempts ?? 0;
}

/** Unverified targets that have used up their per-target budget. */
export function exhaustedTargets(
  progress: TaskProgress,
  limit: number,
): readonly ProgressEntry[] {
  return progress.entries.filter((e) => e.status !== 'verified' && e.attempts >= limit);
}


// -- The decomposition, and where each leg stands ------------------------------

/**
 * Adopt a decomposition, keeping what the run has already observed.
 *
 * A replan is not a reset. A planner that re-proposes `search` after `navigate` succeeded
 * is describing the same task from where it now stands, and re-running the navigate
 * because the proposal mentioned it again would undo the step that made the proposal
 * possible. So a subgoal that keeps its id keeps its status, its attempts and its failure;
 * one that has gone from the proposal is `skipped`, not deleted, because a run that
 * abandoned a leg should be able to say so afterwards.
 *
 * Ids are the whole mechanism, which is why `Subgoal.id` is documented as stable for the
 * life of the task.
 */
export function adoptPlan(
  progress: TaskProgress,
  proposed: readonly Subgoal[],
  stepIndex: number,
): TaskProgress {
  const existing = new Map(progress.plan.map((s) => [s.id, s]));
  const kept = new Set<string>();

  const plan: SubgoalState[] = proposed.map((subgoal) => {
    kept.add(subgoal.id);
    const before = existing.get(subgoal.id);
    if (!before) {
      return { ...subgoal, status: 'blocked' as const, attempts: 0 };
    }
    // The proposal may reword the intent or tighten the criteria; what it may not do is
    // un-finish a leg the page confirmed.
    return {
      ...subgoal,
      status: before.status,
      attempts: before.attempts,
      ...(before.failure ? { failure: before.failure } : {}),
      ...(before.stepIndex !== undefined ? { stepIndex: before.stepIndex } : {}),
    };
  });

  for (const before of progress.plan) {
    if (kept.has(before.id)) continue;
    // Dropped by the replan. Kept as a record; `skipped` is terminal and unblocks nothing.
    plan.push({ ...before, status: 'skipped', stepIndex });
  }

  return resolveReadiness({ ...progress, plan });
}

/**
 * Recompute which legs may run, from the dependency graph.
 *
 * `blocked` and `ready` are derived, never asserted: a status that says "ready" while a
 * dependency is outstanding is a bug waiting for a step to act on it. `active`, `done`,
 * `failed` and `skipped` are decided by observation and are left alone.
 *
 * A dependency on an id that is not in the plan is treated as satisfied. The alternative
 * is a leg that can never run because a replan renamed the thing it was waiting for, and a
 * plan that silently cannot finish is worse than one that tries.
 */
export function resolveReadiness(progress: TaskProgress): TaskProgress {
  const settled = new Set<string>();
  const present = new Set(progress.plan.map((s) => s.id));
  for (const subgoal of progress.plan) {
    // `failed` settles a dependency as much as `done` does, and that is a choice worth
    // stating. `after` expresses the order the user wrote their sentence in, not a hard
    // precondition -- and treating a failed leg as permanently blocking would let one
    // dead leg deadlock every leg behind it, leaving the plan with nothing active and the
    // run grinding to a halt on the stall counter rather than on anything it learned.
    //
    // Continuing is safe because nothing is inherited from the failed leg: every step
    // re-observes and every action is resolved against that fresh walk. What is *not*
    // inherited is a claim of success -- `planFinished` still requires at least one leg
    // to have finished, and `complete.ts` still re-reads the fields the user named.
    if (
      subgoal.status === 'done' ||
      subgoal.status === 'skipped' ||
      subgoal.status === 'failed'
    ) {
      settled.add(subgoal.id);
    }
  }

  const plan = progress.plan.map((subgoal) => {
    if (subgoal.status !== 'blocked' && subgoal.status !== 'ready') return subgoal;
    const waiting = subgoal.after.some((id) => present.has(id) && !settled.has(id));
    const status = waiting ? ('blocked' as const) : ('ready' as const);
    return status === subgoal.status ? subgoal : { ...subgoal, status };
  });

  return { ...progress, plan };
}

/** The leg in flight, if there is one. */
export function activeSubgoal(progress: TaskProgress): SubgoalState | undefined {
  return progress.plan.find((s) => s.status === 'active');
}

/**
 * Which leg the next step should work on.
 *
 * The active one if there is one, otherwise the first `ready` one in plan order. Plan
 * order rather than any scoring: `after` already expresses everything the decomposition
 * knows about sequence, and inventing a second ordering on top of it would mean two
 * answers to "what is next".
 */
export function nextSubgoal(progress: TaskProgress): SubgoalState | undefined {
  return activeSubgoal(progress) ?? progress.plan.find((s) => s.status === 'ready');
}

/**
 * Make one leg the current one, and record the page it starts from.
 *
 * At most one leg is `active` at a time. The baseline is replaced along with it: a
 * criterion asking whether the page changed is asking about *this* leg, and comparing it
 * against the page some earlier leg started on would report a navigation that had already
 * been accounted for.
 */
export function activateSubgoal(
  progress: TaskProgress,
  id: string,
  stepIndex: number,
  baseline?: PageBaseline,
): TaskProgress {
  const plan = progress.plan.map((subgoal) => {
    if (subgoal.id === id) return { ...subgoal, status: 'active' as const, stepIndex };
    // Standing down whatever was active: it goes back to being merely eligible.
    if (subgoal.status === 'active') return { ...subgoal, status: 'ready' as const };
    return subgoal;
  });
  return { ...progress, plan, baseline: baseline ?? progress.baseline };
}

/** Note that a step ran against the current leg, whatever became of it. */
export function chargeSubgoal(progress: TaskProgress, id: string): TaskProgress {
  const plan = progress.plan.map((subgoal) =>
    subgoal.id === id ? { ...subgoal, attempts: subgoal.attempts + 1 } : subgoal,
  );
  return { ...progress, plan };
}

/** The page confirmed this leg. Terminal, and it may unblock others. */
export function completeSubgoal(
  progress: TaskProgress,
  id: string,
  stepIndex: number,
): TaskProgress {
  const plan = progress.plan.map((subgoal) =>
    subgoal.id === id
      ? ({ ...subgoal, status: 'done' as const, stepIndex, failure: undefined } as SubgoalState)
      : subgoal,
  );
  return resolveReadiness({ ...progress, plan });
}

/**
 * This leg failed, and why -- abstractly.
 *
 * Terminal only when the budget is spent. A leg that failed with attempts left goes back
 * to `ready` carrying its reason, which is what the recovery ladder reads to decide
 * between retrying, re-observing and replanning.
 *
 * The caller's reason survives becoming terminal. Overwriting it with `budget-spent`
 * looked tidier and threw away the only useful half of the record: "we tried three times"
 * is visible from `attempts`, and "the element it wanted was never there" is not visible
 * from anywhere else. `budget-spent` is what `criteria.ts` passes when it genuinely cannot
 * say why, and it should mean that rather than being the answer to everything.
 *
 * `blocked` is the one reason that is terminal on its own. It means the agent may not do
 * this unaided, and two more attempts are two more of the same refusal.
 */
export function failSubgoal(
  progress: TaskProgress,
  id: string,
  failure: SubgoalFailure,
  stepIndex: number,
): TaskProgress {
  const plan = progress.plan.map((subgoal) => {
    if (subgoal.id !== id) return subgoal;
    const spent = subgoal.attempts >= subgoal.budget || failure === 'blocked';
    return {
      ...subgoal,
      status: spent ? ('failed' as const) : ('ready' as const),
      failure,
      stepIndex,
    };
  });
  return resolveReadiness({ ...progress, plan });
}

/** Every leg has reached a terminal status, and at least one of them is `done`. */
export function planFinished(progress: TaskProgress): boolean {
  if (progress.plan.length === 0) return false;
  const terminal = progress.plan.every(
    (s) => s.status === 'done' || s.status === 'skipped' || s.status === 'failed',
  );
  return terminal && progress.plan.some((s) => s.status === 'done');
}

/** The plan in one line for a step note. Ids and statuses, never page content. */
export function describePlan(progress: TaskProgress): string {
  if (progress.plan.length === 0) return '';
  const done = progress.plan.filter((s) => s.status === 'done').length;
  const active = activeSubgoal(progress);
  const where = active ? ` at ${active.id}` : '';
  return `plan ${done}/${progress.plan.length}${where}`;
}

/** The ledger in one line for a step note. Counts and field names, never a value. */
export function describeProgress(progress: TaskProgress): string {
  if (progress.entries.length === 0) return '';
  const verified = countVerified(progress.entries);
  return `progress ${verified}/${progress.entries.length}`;
}

/**
 * The work this run has already had confirmed, in words a model can read.
 *
 * Field names out of the user's own sentence and a verb, which is exactly what the ledger
 * holds and exactly what `worker/state.ts` allows to be persisted: no values, no page
 * text. It exists for the tier 1 prompt, which otherwise re-derives the same actions from
 * the same sentence on every step of a multi-step run -- see buildPlanPrompt in local.ts.
 */
export function verifiedWork(progress: TaskProgress): string[] {
  const said: Record<IntentVerb, string> = {
    fill: 'filled',
    click: 'clicked',
    select: 'chose an option in',
    submit: 'submitted',
    navigate: 'navigated to',
  };

  return progress.entries
    .filter((entry) => entry.status === 'verified')
    .map((entry) => `${said[entry.verb]} "${entry.target}"`);
}
