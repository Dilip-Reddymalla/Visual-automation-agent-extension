/**
 * Tier 0: matching a target the user named against the elements on the page.
 *
 * This is the fast path, not a placeholder for one. On "fill first name with leo" the
 * device already holds everything needed to answer -- the autocomplete token says
 * `given-name`, the label says "First Name", and no model on earth is going to improve on
 * that. Sending a screenshot across a network to be told the same thing is latency and
 * exposure bought for nothing.
 *
 * What matters as much as matching is *knowing when not to*. Two email fields on one form
 * is a real page, and picking the first is a coin toss dressed up as a decision. So the
 * scorer reports the gap between first and second place, and the caller escalates when
 * that gap is small. The gap is logged on every step: it is the number that says whether
 * Tier 0 is deciding or guessing.
 *
 * Node-pure.
 */

import type { ObservedElement } from '../shared/observed';
import { aliasesOf, normalise, type Intent } from './intent';

/**
 * What each signal is worth.
 *
 * Ordered by how hard it is to be wrong. `autocomplete` is a machine-readable statement
 * of purpose the site author wrote for browsers to read; a label is written for humans
 * and is usually right; `name`/`id` are internal and often abbreviated; nearby text is a
 * guess about layout. Nothing here is tuned -- the ordering is the claim, and the numbers
 * only have to preserve it.
 */
const WEIGHTS = {
  autocomplete: 10,
  label: 8,
  ariaLabel: 8,
  placeholder: 6,
  nameAttr: 4,
  idAttr: 4,
  /**
   * A caption the page never associated with the field, read off document order.
   *
   * Worth what a declared label is worth, which looks wrong for an inference until you see
   * where it applies: `perceive` only sets `nearbyText` when the element has *no* declared
   * label and no aria-label, so the two can never both score on the same element. When the
   * page declares nothing, the caption sitting above the box is the label as far as any
   * human reading the page is concerned, and scoring it as a lesser signal was scoring it
   * against nothing.
   *
   * What it cost at 6: the parivahan state dropdown, whose caption is "DL Holder's Last
   * Transaction State" and whose id is "ddlState", scored 3 + 2 = 5 against a floor of 6.
   * The only dropdown on the page, its caption ending in the word the user typed, was not
   * found -- and "select state as telangana" died at a planner. At 8 it scores 6 and
   * resolves with the whole page as its margin.
   */
  nearby: 8,
  text: 2,
} as const;

/** Below this, a match is noise. A target that matches nothing lands here. */
export const SCORE_FLOOR = 6;

/**
 * How far first must be clear of second.
 *
 * Two candidates within this are a tie, and a tie is what Tier 1 exists for. Set against
 * the weights above: a field matched on its label alone (8) does not beat one matched on
 * its autocomplete (10) by enough to act without a second opinion.
 */
export const CLEAR_MARGIN = 4;

/** An exact match is worth its full weight; a containment, half. */
function scoreField(value: string | undefined, aliases: string[], weight: number): number {
  if (!value) return 0;
  const haystack = normalise(value);
  if (!haystack) return 0;

  let best = 0;
  for (const alias of aliases) {
    if (haystack === alias) best = Math.max(best, weight);
    else if (haystack.includes(alias) || alias.includes(haystack)) {
      best = Math.max(best, weight / 2);
    }
  }
  return best;
}

/** Roles a `fill` can target. A click on a textbox is not what the user asked for. */
const FILLABLE = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox', 'video']);
const CLICKABLE = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'video']);
const SELECTABLE = new Set(['combobox', 'listbox']);

function rolesFor(verb: Intent['verb']): ReadonlySet<string> {
  if (verb === 'fill') return FILLABLE;
  if (verb === 'select') return SELECTABLE;
  return CLICKABLE;
}

export interface Candidate {
  index: number;
  score: number;
  /** For the shortlist Tier 1 is given, and for the log. */
  label: string;
  role: string;
}

export type Resolution =
  | { kind: 'resolved'; index: number; score: number; gap: number; candidates: Candidate[] }
  /** Several plausible, or nothing convincing. Tier 1 decides; Tier 2 if it cannot. */
  | { kind: 'ambiguous'; candidates: Candidate[]; reason: 'tie' | 'below-floor' };

/** The best name we have for an element, for a shortlist a human or a model will read. */
function labelOf(el: ObservedElement): string {
  // `??` on `name` is wrong here: the walker sets it to `''` when an element has no
  // accessible name, and an empty string is not nullish, so every fallback after it was
  // unreachable. On a page whose fields are labelled by adjacent text and nothing else --
  // which is the parivahan form, and a great many government forms -- every candidate
  // reached the operator, the log and the local model with a blank label.
  return (
    el.labelText ||
    el.ariaLabel ||
    el.name ||
    el.nearbyText ||
    el.placeholder ||
    el.nameAttr ||
    ''
  );
}

/**
 * Score every element against one intent, and say whether the answer is clear.
 *
 * The verb narrows the field before anything is scored: "click submit" has no business
 * matching a textbox labelled "Submit your message", and filtering by role first is both
 * cheaper and more correct than scoring everything and hoping the weights sort it out.
 */
export function resolveTarget(intent: Intent, elements: ObservedElement[]): Resolution {
  const aliases = aliasesOf(intent.target);
  const roles = rolesFor(intent.verb);

  const candidates: Candidate[] = [];
  for (const el of elements) {
    if (el.index === undefined) continue;
    if (!roles.has(el.role)) continue;

    const score =
      scoreField(el.autocomplete, aliases, WEIGHTS.autocomplete) +
      scoreField(el.labelText, aliases, WEIGHTS.label) +
      scoreField(el.ariaLabel ?? el.name, aliases, WEIGHTS.ariaLabel) +
      scoreField(el.placeholder, aliases, WEIGHTS.placeholder) +
      scoreField(el.nameAttr, aliases, WEIGHTS.nameAttr) +
      scoreField(el.idAttr, aliases, WEIGHTS.idAttr) +
      scoreField(el.nearbyText, aliases, WEIGHTS.nearby) +
      scoreField(el.textRuns.map((run) => run.text).join(' '), aliases, WEIGHTS.text);

    if (score > 0)
      candidates.push({ index: el.index, score, label: labelOf(el), role: el.role });
  }

  candidates.sort((a, b) => b.score - a.score || a.index - b.index);

  const first = candidates[0];
  if (!first || first.score < SCORE_FLOOR) {
    return { kind: 'ambiguous', candidates: candidates.slice(0, 5), reason: 'below-floor' };
  }

  const gap = first.score - (candidates[1]?.score ?? 0);
  if (gap < CLEAR_MARGIN) {
    return { kind: 'ambiguous', candidates: candidates.slice(0, 5), reason: 'tie' };
  }

  return {
    kind: 'resolved',
    index: first.index,
    score: first.score,
    gap,
    candidates: candidates.slice(0, 5),
  };
}
