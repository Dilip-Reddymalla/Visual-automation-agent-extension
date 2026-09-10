/**
 * What to do about a leg that did not work, and how hard to try.
 *
 * ## The ladder
 *
 *     retry only when justified
 *     otherwise re-observe
 *     otherwise re-resolve
 *     otherwise replan
 *     otherwise fail safely
 *
 * Each rung costs more than the one above it, so the rule is to take the cheapest one that
 * could plausibly work rather than the one that most looks like effort. A click that landed
 * on a page still finishing its own animation deserves a second try; the same click, having
 * changed nothing twice, does not deserve a third.
 *
 * ## What each rung actually does
 *
 * The temptation here is a vocabulary that reads well and changes nothing. Two of these
 * rungs genuinely are "run the next step normally" -- the loop re-observes on every step by
 * construction, so `retry` and `re-observe` differ only in what the note says, and the note
 * is worth having. The rest change behaviour:
 *
 *   re-resolve   the next step skips Tier 0. Something that can see the page picks the
 *                target instead of the grammar that picked the wrong one.
 *   escalate     the same, for an ambiguity the device has no way to settle.
 *   replan       skips Tier 0 *and* ends the leg, so the planner is asked what the task is
 *                made of rather than being handed the same leg a fourth time. The leg's
 *                failure reason travels with the request (contract.ts), so the answer can
 *                be informed rather than a fresh guess.
 *   abandon      ends the leg and carries on with the next one. No escalation: nothing is
 *                being asked, the run is moving on.
 *
 * ## Why `re-resolve` is not "try a different element"
 *
 * The obvious implementation is to remember which element the last attempt acted on and
 * exclude it. It is not available: an element's stable identity is its `key`, which
 * contains its accessible name, and the worker may not write page content to
 * `chrome.storage.session` (CLAUDE.md, the note on the worker). An index is not an
 * alternative -- indices are per-walk and mean different elements after a reflow, which is
 * the exact failure the snapshot nonce exists to prevent.
 *
 * So "resolve it differently" is implemented as "let something that can see the page
 * resolve it". That is a weaker lever than exclusion and it is an honest one.
 *
 * Node-pure.
 */

import type { SubgoalFailure } from '../shared/contract';

export type Recovery =
  /** Do the same thing again. The page may simply not have finished settling. */
  | 'retry'
  /** Look again before deciding anything. Every step re-observes, so this is the default. */
  | 're-observe'
  /** Let a tier that can see the page choose the target. */
  | 're-resolve'
  /** The device cannot settle this. Ask something that can. */
  | 'escalate'
  /** End this leg and ask for a different decomposition. */
  | 'replan'
  /** End this leg and move on. Nothing more will be asked about it. */
  | 'abandon';

/** Rungs that make the next step skip Tier 0. */
const ESCALATING: ReadonlySet<Recovery> = new Set(['re-resolve', 'escalate', 'replan']);

/** Rungs that end the leg where it stands. */
const TERMINAL: ReadonlySet<Recovery> = new Set(['replan', 'abandon']);

export function escalates(recovery: Recovery): boolean {
  return ESCALATING.has(recovery);
}

export function endsTheLeg(recovery: Recovery): boolean {
  return TERMINAL.has(recovery);
}

export interface RecoveryInput {
  /** What the criteria said went wrong. */
  failure: SubgoalFailure;
  /** Steps already spent on this leg, including the one that just ran. */
  attempts: number;
  budget: number;
  /** Consecutive steps across the whole run that verified nothing new. */
  stalled: number;
  /** How many steps the whole run may still take. */
  stepsLeft: number;
}

export interface RecoveryChoice {
  recovery: Recovery;
  /** One clause for the step note. Enum names and counts, never page content. */
  note: string;
}

/**
 * Choose the cheapest rung that could plausibly work.
 *
 * Reads like a table because it is one: every `SubgoalFailure` has a defined answer at
 * every point in a leg's budget, and a recovery policy that has to be reasoned about at
 * runtime is one nobody can predict from the outside.
 */
export function recoverFrom(input: RecoveryInput): RecoveryChoice {
  const { failure, attempts, budget } = input;
  const spent = attempts >= budget;
  const first = attempts <= 1;

  const recovery = decide();
  return { recovery, note: `${failure} -> ${recovery} (${attempts}/${budget})` };

  function decide(): Recovery {
    // Nothing the agent may do unaided will change this. Two more attempts are two more
    // of the same refusal.
    if (failure === 'blocked') return 'abandon';

    // A run with no steps left cannot spend one asking for a new plan it will not run.
    if (input.stepsLeft <= 1) return 'abandon';

    switch (failure) {
      // The page moved under the leg. Nothing about the leg is known to be wrong; what is
      // wrong is everything it was measured against.
      case 'page-changed':
        return spent ? 'replan' : 're-observe';

      // The thing the leg was waiting for is not there. Looking again is cheap and often
      // enough -- a list that was still loading. After that the leg was probably resolved
      // against the wrong thing, and after that the decomposition is wrong.
      case 'target-missing':
        if (first) return 're-observe';
        return spent ? 'replan' : 're-resolve';

      // The action landed and the page did not move. Once, that is a page that had not
      // finished settling; twice, it is the wrong control.
      case 'no-effect':
        if (first) return 'retry';
        return spent ? 'replan' : 're-resolve';

      // Something was acted on and the criteria say it was the wrong thing. Retrying is
      // the one thing that cannot help.
      case 'wrong-target':
        return spent ? 'replan' : 're-resolve';

      // Several candidates fit and nothing on the page separates them. That is exactly the
      // question a model answers better than a grammar.
      case 'ambiguous':
        return spent ? 'replan' : 'escalate';

      // The honest "we tried and cannot say why". One look at a different rung, then stop.
      case 'budget-spent':
        return 'replan';
    }
  }
}

/**
 * The run is going in circles: stop climbing the ladder and ask for a new plan.
 *
 * Applied on top of `recoverFrom` rather than inside it, because it is a fact about the
 * *run* and not about the leg. A leg on its first attempt legitimately deserves a retry;
 * a leg on its first attempt in a run that has verified nothing for three steps does not,
 * because whatever is wrong is not this leg's first attempt.
 */
export function withStallPressure(
  choice: RecoveryChoice,
  stalled: number,
  limit: number,
): RecoveryChoice {
  if (stalled < limit - 1) return choice;
  if (choice.recovery === 'abandon' || choice.recovery === 'replan') return choice;
  return {
    recovery: 'replan',
    note: `${choice.note}, forced to replan after ${stalled} steps with no progress`,
  };
}
