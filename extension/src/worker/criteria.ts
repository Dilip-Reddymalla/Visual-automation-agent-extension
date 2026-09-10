/**
 * Judging a subgoal against the page, rather than against the planner's opinion of it.
 *
 * ## Where this runs, and why it is not at the end of the step
 *
 * A leg is judged at the *start of the following step*, against the fresh walk that step
 * takes anyway. The obvious alternative -- verify at the end of the step that acted -- was
 * rejected twice over. It needs a second full DOM walk, which is the most expensive
 * non-model thing in the loop; and it asks the question at the worst possible moment,
 * while the page is still settling from the click that was just delivered. By the time the
 * next step's `perceive` runs, the DOM has been quiet for 250 ms and the answer is stable.
 *
 * The cost is that the very last leg of a run is never judged this way. That is what
 * `complete.ts` is for: it re-reads the fields the user named and refuses to let the
 * session say "done" on the planner's say-so.
 *
 * ## What counts as evidence
 *
 * Only things already on the device and already allowed to be persisted. `url-changed`
 * compares the *document nonce* inside `snapshotId` -- a random value minted per document
 * (content/index.ts) -- and the origin. Not the URL and not the title: `state.ts` is
 * explicit that a query string carries identifiers and a page title carries names, and a
 * criterion is not a good enough reason to put either into browser storage.
 *
 * The consequence, stated rather than hidden: a route change inside a single-page app does
 * not satisfy `url-changed`, because nothing observable and safe distinguishes it from a
 * repaint. Such a leg completes through its other criteria, or through its budget and a
 * replan.
 *
 * Node-pure.
 */

import { MAX_STALLED_STEPS } from '../shared/agent';
import type { Criterion, SubgoalFailure, SubgoalState } from '../shared/contract';
import type { ObservedElement } from '../shared/observed';
import {
  endsTheLeg,
  escalates,
  recoverFrom,
  withStallPressure,
  type Recovery,
} from './recover';
import {
  activateSubgoal,
  activeSubgoal,
  chargeSubgoal,
  completeSubgoal,
  describePlan,
  failSubgoal,
  nextSubgoal,
  type PageBaseline,
  type TaskProgress,
} from './progress';

// Declared with the rest of the persisted progress, re-exported here because everything
// that judges against a baseline imports it from this module.
export type { PageBaseline };

/** The fresh walk a criterion is judged against. */
export interface Observation {
  snapshotId: string;
  origin: string;
  elements: readonly ObservedElement[];
}

/** The random half of a snapshot id: constant within a document, new after a load. */
export function documentOf(snapshotId: string): string {
  const at = snapshotId.lastIndexOf('.');
  return at === -1 ? snapshotId : snapshotId.slice(0, at);
}

/**
 * Words too common to be evidence of anything.
 *
 * Short, and short on purpose: a stop list that grows starts deciding which of the user's
 * own words matter, and the hint came out of their sentence.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'with',
  'it', 'its', 'this', 'that', 'them', 'one', 'ones', 'my', 'me', 'your', 'is', 'are',
  'was', 'be', 'best', 'first', 'next', 'all', 'any', 'from', 'into', 'up', 'out',
]);

/** Words worth matching on. Three characters, because "id" and "no" match everything. */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

/** Everything about an element a human could read off the page. Device-side only. */
function readable(el: ObservedElement): string {
  return [
    el.name,
    el.ariaLabel,
    el.labelText,
    el.placeholder,
    el.nearbyText,
    el.selectedText,
    el.alt,
    ...el.textRuns.map((run) => run.text),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Elements the hint plausibly names.
 *
 * One shared token is enough. The hint came out of a sentence a person typed and the
 * element name came out of a page somebody else wrote, and demanding that every word line
 * up means "search for parking permits" never matches a heading that says "Permits". The
 * looseness is bounded by what the criterion is used for: this decides whether a leg has
 * finished, not what to click.
 */
export function matching(
  elements: readonly ObservedElement[],
  hint: string,
): ObservedElement[] {
  const wanted = tokens(hint);
  if (wanted.length === 0) return [];
  return elements.filter((el) => {
    const text = readable(el);
    return wanted.some((word) => text.includes(word));
  });
}

/**
 * Did the agent actually type something into this leg?
 *
 * ## The false success this exists for
 *
 * Live run against amazon.in, goal "open amazon.in and search for mobiles". The run
 * reported `ok`, four steps, no problems -- and the screenshot at the end is Amazon's
 * Mobiles *category* page with the search box empty. The agent had clicked the "Mobiles"
 * link in the nav bar.
 *
 * The `search` leg's only criterion was `element-present` with the hint "mobiles", and
 * that criterion was true before the leg ever ran: Amazon's nav bar says "Mobiles" on
 * every page of the site. Any action at all that kept the word on screen -- including
 * doing nothing -- satisfied it.
 *
 * So a `search` leg is asked for the one thing a page cannot supply on its own: a verified
 * `fill` recorded during this leg. It is read off the ledger rather than off the DOM
 * because a search usually navigates, and after the navigation the field is a new element
 * with no memory of having been typed into; the ledger is in `chrome.storage.session` and
 * survives it.
 *
 * Both tiers feed it. A device-planned `fill` intent and a planner's `type` action both
 * produce a `verb: 'fill'` fulfilment, verified by `VERIFY_FILLED` against the text that
 * was meant to land (router.ts).
 *
 * ## Why the window is not just "since this leg started"
 *
 * Because the device does not work leg by leg. Measured on the same amazon.in run once
 * perception was fixed: tier 0 read the whole sentence at step 1, while `navigate-1` was
 * still the active leg, and typed "mobiles" into the search box there -- results page and
 * all. `search-1` was not activated until step 2, so a strict "verified at or after this
 * leg's first step" window rejected the very fill that had done the leg's work, and the
 * run carried on wandering the site for three more steps with the task already finished.
 *
 * So a fill from before the leg counts when the leg's own sentence names what was filled:
 * the ledger's target came from the user's words ("search"), and so did the leg's intent
 * ("search for mobiles"). What is still refused is the case this rule exists for -- a leg
 * that typed nothing anywhere, and was passing on a word the site puts in its nav bar.
 */
function typedDuringLeg(subgoal: SubgoalState, progress: TaskProgress): boolean {
  const since = subgoal.stepIndex ?? 0;
  const named = tokens(subgoal.intent);
  return progress.entries.some((entry) => {
    if (entry.verb !== 'fill' || entry.status !== 'verified') return false;
    if (entry.stepIndex >= since) return true;
    const target = entry.target.toLowerCase();
    return named.some((word) => target.includes(word));
  });
}

/** Is a piece of work the ledger verified named by this hint? */
function verifiedByHint(progress: TaskProgress, hint: string): boolean {
  const wanted = tokens(hint);
  return progress.entries.some((entry) => {
    if (entry.status !== 'verified') return false;
    if (wanted.length === 0) return true;
    const target = entry.target.toLowerCase();
    return wanted.some((word) => target.includes(word));
  });
}

export function criterionMet(
  criterion: Criterion,
  observation: Observation,
  baseline: PageBaseline,
  progress: TaskProgress,
): boolean {
  switch (criterion.check) {
    case 'url-changed':
      return (
        documentOf(observation.snapshotId) !== documentOf(baseline.snapshotId) ||
        observation.origin !== baseline.origin
      );
    case 'element-present':
      return matching(observation.elements, criterion.hint).length > 0;
    case 'element-gone':
      return matching(observation.elements, criterion.hint).length === 0;
    case 'field-filled':
      return matching(observation.elements, criterion.hint).some((el) => el.state.filled);
    case 'text-present':
      return matching(observation.elements, criterion.hint).length > 0;
    case 'action-verified':
      return verifiedByHint(progress, criterion.hint);
  }
}

/** What the loop should do with the leg that was current. */
export type Verdict = 'done' | 'failed' | 'continue';

export interface Judgement {
  verdict: Verdict;
  /**
   * Why the leg is not finished, whether or not its budget has run out.
   *
   * Present on `continue` as well as on `failed`, because the recovery ladder needs the
   * reason *before* the last attempt has been spent -- "the target was never there" on
   * attempt one is what makes a second look worth taking. Absent only when the leg is
   * done.
   */
  diagnosis?: SubgoalFailure;
  /** Set only when the verdict is `failed`. The same value as `diagnosis`. */
  failure?: SubgoalFailure;
  /** The checks that held, for the step note. Enum names, never page content. */
  met: string[];
  /** The checks that did not. */
  unmet: string[];
}

export interface JudgeInput {
  subgoal: SubgoalState;
  observation: Observation;
  baseline: PageBaseline;
  progress: TaskProgress;
  /** Did the step that ran this leg end cleanly? */
  lastStepOk: boolean;
}

/**
 * Decide what became of the current leg.
 *
 * Two ways to finish, and the second one is a deliberate concession rather than an
 * oversight. A leg with criteria finishes when all of them hold -- that is the whole point
 * of writing criteria down. A leg *without* criteria finishes when the step that ran it
 * ended cleanly, because `filter`, `inspect` and `confirm` have no signature that holds on
 * every site, and inventing one would mean failing legs that succeeded. What stops that
 * from being a rubber stamp is that it is not the last word: `complete.ts` still re-reads
 * the fields the user named before the session may say it is done.
 *
 * Failure is by budget only. A leg that has not finished but has attempts left is not a
 * failure yet, it is a leg in progress, and the recovery ladder (recover.ts) reads the
 * distinction.
 */
export function judge(input: JudgeInput): Judgement {
  const { subgoal, observation, baseline, progress } = input;

  const met: string[] = [];
  const unmet: string[] = [];
  for (const criterion of subgoal.criteria) {
    const ok = criterionMet(criterion, observation, baseline, progress);
    (ok ? met : unmet).push(criterion.check);
  }

  // Not a criterion the planner can write, and deliberately not one it can drop: it is
  // the definition of the verb. See typedDuringLeg.
  if (subgoal.kind === 'search') {
    (typedDuringLeg(subgoal, progress) ? met : unmet).push('text-entered');
  }

  // A leg with nothing to check finishes on a clean step -- `filter`, `inspect` and
  // `confirm` have no signature that holds on every site. A leg with something to check
  // finishes when all of it holds, whether the checks came from its criteria or from the
  // rule above.
  const checked = met.length + unmet.length > 0;
  const finished = checked ? unmet.length === 0 : input.lastStepOk;

  if (finished) return { verdict: 'done', met, unmet };

  const diagnosis = failureFor(input, unmet);
  if (subgoal.attempts >= subgoal.budget) {
    return { verdict: 'failed', diagnosis, failure: diagnosis, met, unmet };
  }
  return { verdict: 'continue', diagnosis, met, unmet };
}

/**
 * Why the leg did not finish, in the vocabulary the recovery ladder reads.
 *
 * Guessed from what the criteria said, and only where the guess is grounded:
 *
 *   target-missing  the leg was waiting for something to appear and it never did
 *   page-changed    the document was replaced while the leg was still running
 *   no-effect       nothing observable changed at all across the leg's attempts
 *
 * Everything else is `budget-spent`, which is the honest answer to "we tried three times
 * and cannot say why it did not work".
 */
function failureFor(input: JudgeInput, unmet: readonly string[]): SubgoalFailure {
  const { observation, baseline } = input;
  const navigated =
    documentOf(observation.snapshotId) !== documentOf(baseline.snapshotId) ||
    observation.origin !== baseline.origin;

  // The leg was not asked to navigate and the page navigated under it.
  const wantedNavigation = input.subgoal.criteria.some((c) => c.check === 'url-changed');
  if (navigated && !wantedNavigation) return 'page-changed';

  if (
    unmet.includes('element-present') ||
    unmet.includes('field-filled') ||
    unmet.includes('text-entered')
  ) {
    return 'target-missing';
  }
  if (!navigated && unmet.includes('url-changed')) return 'no-effect';
  return 'budget-spent';
}

// -- Driving the plan forward --------------------------------------------------

export interface PlanAdvance {
  observation: Observation;
  stepIndex: number;
  /** Did the step that ran the current leg end cleanly? */
  lastStepOk: boolean;
  /** How many steps the whole run may still take. Bounds what recovery may cost. */
  stepsLeft: number;
}

export interface PlanStep {
  progress: TaskProgress;
  /** Leg ids and verdicts for the step note. Never page content. */
  note: string;
  /**
   * The recovery this step is carrying out, when the last one did not work.
   *
   * Read by `perceive`: the rungs that mean "let something that can see the page decide"
   * make the step skip Tier 0. See recover.ts.
   */
  recovery?: Recovery;
}

/**
 * Checks that only a thing the *run did* can satisfy.
 *
 * `element-present` and `text-present` are satisfied by whatever the page happens to be
 * showing, and a site's own furniture satisfies them on arrival: Amazon's nav bar says
 * "Mobiles" on every page it serves. The three below cannot be satisfied that way -- two
 * are read off the ledger of verified work, and the third needs a field that holds a
 * value.
 */
const RUN_EVIDENCE: ReadonlySet<string> = new Set([
  'text-entered',
  'action-verified',
  'field-filled',
]);

/**
 * Is this leg finished before it has been given a step?
 *
 * The device does not work leg by leg. Tier 0 reads the user's whole sentence at once, so
 * by the time the plan gets round to activating `search-1`, the search may already have
 * been typed, submitted and answered. Measured on amazon.in: tier 0 typed "mobiles" and
 * landed on the results page at step 1, `search-1` was activated at step 2, and the loop
 * -- having nothing that said the leg was already done -- handed the step to tier 1, which
 * clicked four things and navigated off the results page it had been given.
 *
 * The guard against this becoming a rubber stamp is `RUN_EVIDENCE`: a leg may finish on
 * arrival only if part of what satisfied it is something the run itself produced. A leg
 * whose criteria are met purely by what the page was already showing is not finished, it
 * has just started.
 */
function alreadyDone(
  subgoal: SubgoalState,
  observation: Observation,
  progress: TaskProgress,
): boolean {
  if (!progress.baseline) return false;
  const verdict = judge({
    subgoal,
    observation,
    baseline: progress.baseline,
    progress,
    // Nothing has run for this leg yet, so the "a leg with no criteria finishes on a clean
    // step" concession must not fire here.
    lastStepOk: false,
  });
  return verdict.verdict === 'done' && verdict.met.some((check) => RUN_EVIDENCE.has(check));
}

/**
 * Judge the leg that was current, then choose and charge the leg this step will run.
 *
 * The one place the plan moves. Called from `perceive`, with the walk that step took
 * anyway, so the whole transition costs one storage write and no extra round trip.
 *
 * Order matters and is the interesting part. The leg is judged *before* the next one is
 * chosen, because a leg that just finished must not also be charged for the step that
 * finished it; and the next leg is charged as soon as it is chosen, because an attempt is
 * a step spent on it whatever the step turns out to produce. A budget that only counted
 * successful attempts would never run out.
 */
export function advancePlan(progress: TaskProgress, input: PlanAdvance): PlanStep {
  if (progress.plan.length === 0) return { progress, note: '' };

  const notes: string[] = [];
  let next = progress;

  let recovery: Recovery | undefined;

  const current = activeSubgoal(progress);
  if (current && progress.baseline) {
    const verdict = judge({
      subgoal: current,
      observation: input.observation,
      baseline: progress.baseline,
      progress,
      lastStepOk: input.lastStepOk,
    });

    if (verdict.verdict === 'done') {
      next = completeSubgoal(next, current.id, input.stepIndex);
      notes.push(`${current.id} done`);
    } else if (verdict.diagnosis) {
      // Not finished. What happens next is the ladder's decision, not the budget's: a leg
      // with attempts left may still be worth escalating, and a leg out of attempts is not
      // automatically worth replanning if the run has no steps left to run a new plan in.
      const chosen = withStallPressure(
        recoverFrom({
          failure: verdict.diagnosis,
          attempts: current.attempts,
          budget: current.budget,
          stalled: progress.stalled,
          stepsLeft: input.stepsLeft,
        }),
        progress.stalled,
        MAX_STALLED_STEPS,
      );

      recovery = chosen.recovery;
      notes.push(`${current.id} ${chosen.note}`);
      if (endsTheLeg(chosen.recovery)) {
        next = failSubgoal(next, current.id, verdict.diagnosis, input.stepIndex);
      }
    }
  }

  // A leg can arrive already finished, and the loop has to notice before it spends a step
  // asking a model what to do about work that is done. See `alreadyDone`.
  for (let hop = 0; hop < next.plan.length + 1; hop += 1) {
    const upcoming = nextSubgoal(next);
    if (!upcoming) break;

    if (upcoming.status !== 'active') {
      next = activateSubgoal(next, upcoming.id, input.stepIndex, {
        snapshotId: input.observation.snapshotId,
        origin: input.observation.origin,
      });
      notes.push(`${upcoming.id} started`);
    }

    const arrived = activeSubgoal(next);
    if (arrived && alreadyDone(arrived, input.observation, next)) {
      next = completeSubgoal(next, arrived.id, input.stepIndex);
      notes.push(`${arrived.id} done on arrival`);
      continue;
    }

    next = chargeSubgoal(next, upcoming.id);
    break;
  }

  const summary = describePlan(next);
  const note = [summary, ...notes].filter(Boolean).join(' | ');
  return recovery && escalates(recovery)
    ? { progress: next, note, recovery }
    : { progress: next, note };
}
