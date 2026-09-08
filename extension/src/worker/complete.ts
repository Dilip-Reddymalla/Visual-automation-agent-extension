/**
 * Has the task actually been done?
 *
 * This module exists because of a sentence the agent printed while a field sat empty:
 * "the planner reported the task done". The user had asked for two fields. One was filled,
 * the other was never attempted -- its clause did not parse and was dropped -- and the loop
 * ended the session with `ok` and that note. Nothing in the system was in a position to
 * disagree, because nothing in the system had been asked to check.
 *
 * "Done" is the one claim an operator will believe without looking. Every other thing the
 * panel says invites a glance at the page; "done" is the sentence that ends the glancing.
 * So it has to be earned by observation rather than inherited from whoever spoke last.
 *
 * Three ways a session can be finished-but-not-complete, and all three had happened:
 *
 *   1. An intent was parsed and never fulfilled -- the field does not hold the value.
 *   2. An intent was fulfilled by keystroke and not by result -- the executor wrote the
 *      property, the page rejected or reformatted it, and nobody looked afterwards.
 *   3. Part of the sentence was never understood by anybody, and no tier that reads free
 *      text was ever given it.
 *
 * Node-pure: the re-reading is the content script's job, and its verdicts arrive here as
 * data. What this module owns is the arithmetic of "and therefore we are not done".
 */

import type { VerifyReason } from '../shared/messages';
import type { Intent } from './intent';

/** One intent, and what the page said about it after the fact. */
export interface Fulfilment {
  /** The field name the user used. Safe: they typed it, and it is not a value. */
  target: string;
  verb: Intent['verb'];
  reason: VerifyReason;
}

export interface Completion {
  complete: boolean;
  /**
   * What was not done, in words an operator can act on.
   *
   * Field names, verbs and reasons only. Never a value: this ends up in the step log,
   * which is persisted, and in the panel, which ends up on a projector.
   */
  outstanding: string[];
}

export interface CompletionInput {
  intents: Intent[];
  /** Runs of the goal nobody parsed. Already class-masked by the caller. */
  residue: string[];
  /** One per value-bearing intent, from the content script's re-read. */
  fulfilments: Fulfilment[];
  /**
   * Did the goal text reach a tier that reads free text?
   *
   * This is what lets residue be forgiven. The grammar could not read "subject as Write
   * Something", but the planner is given the whole sentence and can. If the request was
   * never sent, nobody read those words and nobody acted on them -- so they are still
   * outstanding, and saying "done" would be saying it about work that has no owner.
   */
  sent: boolean;
  /**
   * Did a model on this machine read the whole sentence?
   *
   * The same forgiveness as `sent`, for the same reason, and it was missing. A goal the
   * grammar could not parse is residue by definition -- and when Tier 1 reads that goal and
   * turns it into actions, the words *were* read, by something that could. Without this the
   * agent filled a form from four lines of free text and then reported "nobody read
   * 'Leo A', 'Australia', 'none'", about the sentence it had just acted on correctly.
   */
  readLocally?: boolean;
}

/** How each verdict reads in a step note. Kept out of the switch so both users agree. */
const WHY: Record<VerifyReason, string> = {
  match: 'holds the value',
  differs: 'holds something else',
  empty: 'is still empty',
  missing: 'is no longer on the page',
  unresolved: 'could not be checked — its placeholder did not resolve',
  'not-applicable': 'was not a value to check',
  'not-done': 'was not carried out',
};

/**
 * Decide whether this session may say it is done.
 *
 * Deliberately conservative in one direction only. An intent whose field could not be
 * re-read at all (`missing`, `unresolved`) counts as *not* fulfilled, because the honest
 * summary of "I could not check" is not "it worked". The cost of that choice is a session
 * that says `incomplete` when it may in fact have succeeded; the cost of the other choice
 * is the bug this module was written for.
 */
export function assessCompletion(input: CompletionInput): Completion {
  const outstanding: string[] = [];

  for (const fulfilment of input.fulfilments) {
    if (fulfilment.reason === 'match' || fulfilment.reason === 'not-applicable') continue;
    outstanding.push(`"${fulfilment.target}" ${WHY[fulfilment.reason]}`);
  }

  // An intent that produced no verdict at all was never even attempted -- the commonest
  // shape of this bug, and the one that reads most like success from the outside.
  //
  // Matched against the alternative reading as well as the primary one. An `as` sentence
  // carries both, and `chooseTier` may have acted on the one the *page* recognised: "enter
  // DL Number as 10001000193" resolves as target "dl number", while the intent on the state
  // record still names "10001000193". Comparing only the primary made the check report that
  // the agent had never acted on a field it had just filled correctly.
  const checked = new Set(input.fulfilments.map((f) => f.target));
  for (const intent of input.intents) {
    if (checked.has(intent.target)) continue;
    if (intent.alt && checked.has(intent.alt.target)) continue;
    outstanding.push(`"${intent.target}" was never acted on`);
  }

  if (!input.sent && !input.readLocally && input.residue.length > 0) {
    outstanding.push(
      `nobody read ${input.residue.map((r) => `"${r}"`).join(', ')}, ` +
        `and it was never sent to a planner that could`,
    );
  }

  return { complete: outstanding.length === 0, outstanding };
}

/** The completion as one line for the step log. Empty when the task really is done. */
export function describeCompletion(completion: Completion): string {
  return completion.complete ? '' : `not done: ${completion.outstanding.join('; ')}`;
}
