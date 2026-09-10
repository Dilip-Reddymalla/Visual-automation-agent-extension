/**
 * Turning one sentence into the legs of a task.
 *
 * ## Why this is a grammar and not a model call
 *
 * The same argument intent.ts makes. "Go to a shop, search for phones, find the best one
 * under 30,000, add it to the basket" is four clauses joined by commas, and each clause
 * opens with a verb that says what *kind* of work it is. That is a grammar. Asking a
 * remote model to say so costs a round trip before the agent has looked at the page once,
 * and produces an answer nobody can unit-test.
 *
 * The planner still gets to disagree: `StepResponse.plan` replaces whatever this produced,
 * and worker/progress.ts keeps the progress of any leg whose id survives. So this is a
 * starting decomposition, not a commitment.
 *
 * ## Why the vocabulary has no nouns in it
 *
 * Nothing here knows what a cart is, or a phone, or a shop. `add it to the basket` is
 * recognised as `interact` because it opens with an adding verb, and the same rule reads
 * `attach the certificate` and `add a passenger`. A table with `add-to-cart` in it would
 * need `book-appointment` the following week and `renew-licence` the week after, and the
 * corpus for this project is government forms, not shops.
 *
 * The one thing that is domain-shaped is the constraint reader below, and it reads
 * *numbers*, which are the same on a price, a distance and a deadline.
 *
 * ## Bounded, and silent when it has nothing to say
 *
 * A goal that yields one leg produces no plan at all. A single-field instruction is not a
 * multi-step task, and wrapping it in a decomposition would put a plan on the wire, in the
 * state record and in the step note for every run of "fill first name with Leo".
 *
 * Node-pure.
 */

import { MAX_SUBGOALS, type Criterion, type Subgoal, type SubgoalKind } from '../shared/contract';
import type { ParsedGoal } from './intent';

/** A numeric limit the user put on the task. See `extractConstraints`. */
export interface Constraint {
  /** `max` is "under 30000"; `min` is "at least 4 stars"; `range` uses `upper` too. */
  kind: 'max' | 'min' | 'range';
  value: number;
  /** The top of a range. Absent otherwise. */
  upper?: number;
  /** The currency or unit as written, or '' when the number was bare. */
  unit: string;
  /** The fragment this came from, for the subgoal's `intent` line. */
  text: string;
}

/**
 * Multipliers people write instead of zeros.
 *
 * Indian English is the target deployment, so `lakh` and `crore` are here beside `k` and
 * `m`. Getting these wrong is not cosmetic: "under 30k" read as "under 30" filters out
 * every candidate, and the run then reports, correctly and uselessly, that nothing
 * qualified.
 */
export function multiplierFor(word: string): number {
  if (/^crores?$/i.test(word)) return 10_000_000;
  if (/^lakhs?$/i.test(word)) return 100_000;
  if (/^k$/i.test(word)) return 1_000;
  if (/^m$/i.test(word)) return 1_000_000;
  return 1;
}

/** Currency marks and the words people use instead. Kept out of the number itself. */
export const CURRENCY = String.raw`(?:[₹$£€¥]|\b(?:rs\.?|inr|usd|eur|gbp|rupees?|dollars?)\b)`;

export const NUMBER = String.raw`(\d[\d,]*(?:\.\d+)?)\s*(crores?|lakhs?|[kKmM])?`;

const AT_MOST = String.raw`under|below|less than|lower than|cheaper than|at most|no more than|not more than|up to|upto|within|max(?:imum)?(?: of)?`;
const AT_LEAST = String.raw`over|above|more than|greater than|at least|min(?:imum)?(?: of)?|starting (?:at|from)|from`;

const MAX_RE = new RegExp(
  String.raw`\b(?:${AT_MOST})\s+(?:${CURRENCY}\s*)?${NUMBER}`,
  'gi',
);
const MIN_RE = new RegExp(
  String.raw`\b(?:${AT_LEAST})\s+(?:${CURRENCY}\s*)?${NUMBER}`,
  'gi',
);
const RANGE_RE = new RegExp(
  String.raw`\bbetween\s+(?:${CURRENCY}\s*)?${NUMBER}\s+and\s+(?:${CURRENCY}\s*)?${NUMBER}`,
  'gi',
);

export function toNumber(digits: string, suffix: string | undefined): number {
  const base = Number.parseFloat(digits.replace(/,/g, ''));
  if (!Number.isFinite(base)) return Number.NaN;
  return base * multiplierFor(suffix ?? '');
}

function unitIn(fragment: string): string {
  const hit = new RegExp(CURRENCY, 'i').exec(fragment);
  return hit ? hit[0] : '';
}

/**
 * Numeric limits in a clause, in the order they appear.
 *
 * Deliberately conservative: a number with no comparator in front of it is not a
 * constraint, it is a quantity ("add 2 to the basket"), and treating it as one would
 * filter a list nobody asked to filter. Ranges are read before the single-sided forms so
 * that "between 10000 and 30000" does not also produce a spurious `min` from its `from`.
 */
export function extractConstraints(text: string): Constraint[] {
  const found: Array<{ at: number; constraint: Constraint }> = [];
  const claimed: Array<[number, number]> = [];

  const overlaps = (from: number, to: number): boolean =>
    claimed.some(([a, b]) => from < b && to > a);

  RANGE_RE.lastIndex = 0;
  for (let m = RANGE_RE.exec(text); m; m = RANGE_RE.exec(text)) {
    const low = toNumber(m[1] ?? '', m[2]);
    const high = toNumber(m[3] ?? '', m[4]);
    if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
    claimed.push([m.index, m.index + m[0].length]);
    found.push({
      at: m.index,
      constraint: {
        kind: 'range',
        value: Math.min(low, high),
        upper: Math.max(low, high),
        unit: unitIn(m[0]),
        text: m[0].trim(),
      },
    });
  }

  for (const [re, kind] of [
    [MAX_RE, 'max'],
    [MIN_RE, 'min'],
  ] as const) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (overlaps(m.index, m.index + m[0].length)) continue;
      const value = toNumber(m[1] ?? '', m[2]);
      if (!Number.isFinite(value)) continue;
      claimed.push([m.index, m.index + m[0].length]);
      found.push({
        at: m.index,
        constraint: { kind, value, unit: unitIn(m[0]), text: m[0].trim() },
      });
    }
  }

  return found.sort((a, b) => a.at - b.at).map((f) => f.constraint);
}

// -- Classifying a clause ------------------------------------------------------

/**
 * Cue phrases, most specific first.
 *
 * Order is the whole design. `check the box` is an interaction and `check the results` is
 * a reading, and the only thing separating them is which pattern gets to look first. Same
 * for `confirm the order` (submitting) against `confirm that it worked` (a checkpoint).
 *
 * Anchored at the start of the clause, except where a cue is genuinely mid-sentence
 * ("add it to the basket" opens with `add`; "under 30000" can appear anywhere). A verb
 * matched anywhere in a clause would classify "go to the page and check nothing is
 * missing" three different ways depending on which pattern ran first.
 */
const CUES: ReadonlyArray<readonly [RegExp, SubgoalKind]> = [
  // Interactions that would otherwise read as inspections.
  [/^(?:tick|untick|check|uncheck|toggle|enable|disable|switch)\s+(?:the\s+)?(?:box|checkbox|checkboxes|option|toggle|switch)\b/i, 'interact'],

  // Checkpoints, before the submit verbs that share their words.
  [/^(?:confirm|verify|make sure|ensure|check)\s+(?:that|the\s+\w+\s+(?:is|was|has))\b/i, 'confirm'],

  [/^(?:go|goto|head|navigate|browse|proceed)\s+(?:to|over to)\b/i, 'navigate'],
  [/^(?:open|visit|launch|load)\b/i, 'navigate'],
  // A bare address is an instruction to go there.
  [/^(?:https?:\/\/|www\.)\S+$/i, 'navigate'],
  [/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i, 'navigate'],

  [/^(?:search|look)\s+(?:for|up)\b/i, 'search'],
  [/^(?:search|query)\b/i, 'search'],

  [/^(?:filter|narrow|restrict|sort)\b/i, 'filter'],
  // `order by price` sorts; `order the tickets` buys. Only the first form is a filter.
  [/^order\s+by\b/i, 'filter'],
  [/^(?:only|just)\s+(?:show|list)\b/i, 'filter'],

  [/^(?:find|locate|discover)\b/i, 'inspect'],
  [/^(?:compare|review|inspect|browse|read|show|list|see|look at|check)\b/i, 'inspect'],

  [/^(?:select|choose|pick)\b/i, 'select'],

  [/^(?:add|attach|append|include|put|insert|upload)\b/i, 'interact'],
  [/^(?:click|tap|press|hit)\b/i, 'interact'],
  [/^(?:fill|enter|type|input|set|write)\b/i, 'interact'],

  [
    /^(?:submit|checkout|check out|place|buy|purchase|order|book|reserve|claim|renew|schedule|send|pay|apply|register|sign up)\b/i,
    'submit',
  ],
  [/^confirm\b/i, 'submit'],
];

/** Words that mean "and there is a right one among them", so a choice is implied. */
const SUPERLATIVE =
  /\b(?:best|cheapest|closest|nearest|earliest|latest|fastest|highest|lowest|top(?:[- ]rated)?|most\s+\w+|least\s+\w+|first available|next available)\b/i;

function kindOf(clause: string): SubgoalKind | undefined {
  for (const [re, kind] of CUES) {
    if (re.test(clause)) return kind;
  }
  return undefined;
}

/** Where in the clause the classifying cue matched. Decides the order of split legs. */
function cueAt(clause: string): number {
  for (const [re] of CUES) {
    const m = re.exec(clause);
    if (m) return m.index;
  }
  return 0;
}

// -- Criteria and budgets ------------------------------------------------------

/**
 * What the loop should look for to call each kind of leg done.
 *
 * Only where the verb genuinely implies a check. A `filter` has no observable signature
 * that holds on every site -- some filter in place, some navigate, some do neither
 * visibly -- and inventing one would mean the loop failing legs that succeeded. An empty
 * criteria list means "the verification ledger decides", which is the honest default; the
 * planner can add a real criterion in a replan once it has seen the page.
 */
function criteriaFor(kind: SubgoalKind, hint: string): Criterion[] {
  switch (kind) {
    case 'navigate':
      return [{ check: 'url-changed', hint: '' }];
    case 'search':
      return hint ? [{ check: 'element-present', hint }] : [];
    case 'select':
    case 'interact':
    case 'submit':
      return hint ? [{ check: 'action-verified', hint }] : [];
    case 'filter':
    case 'inspect':
    case 'confirm':
      return [];
  }
}

/**
 * Steps each kind of leg gets.
 *
 * A `navigate` that has not arrived in two steps is not going to; an `inspect` over a list
 * that needs scrolling legitimately takes several. These are the numbers the loop bounds
 * recovery with, so they are per-kind rather than one global constant.
 */
const BUDGETS: Readonly<Record<SubgoalKind, number>> = {
  navigate: 2,
  search: 2,
  filter: 3,
  inspect: 4,
  select: 3,
  interact: 3,
  submit: 2,
  confirm: 2,
};

// -- The decomposition ---------------------------------------------------------

export interface Decomposition {
  /** Empty when the goal is not a multi-step task. */
  subgoals: Subgoal[];
  /** Clauses no cue matched, in reading order. Reported, never silently dropped. */
  unclassified: string[];
  /** Numeric limits found anywhere in the goal, for the candidate stage. */
  constraints: Constraint[];
}

/** How many legs a goal must yield before it is worth calling a plan. */
const MIN_SUBGOALS = 2;

/**
 * Break a goal into legs, using the clause split intent.ts already performed.
 *
 * Reusing `ParsedGoal.clauses` rather than splitting again is not only economy: the
 * separator in intent.ts is the one that has been argued with -- it knows that the `and`
 * in "terms and conditions" is not a clause boundary -- and a second splitter would
 * disagree with it on exactly the sentences that matter.
 */
export function decompose(parsed: ParsedGoal): Decomposition {
  const subgoals: Subgoal[] = [];
  const unclassified: string[] = [];
  const constraints: Constraint[] = [];
  const counts = new Map<SubgoalKind, number>();

  const push = (kind: SubgoalKind, intent: string, hint: string): void => {
    if (subgoals.length >= MAX_SUBGOALS) return;
    const n = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, n);
    const previous = subgoals[subgoals.length - 1];
    subgoals.push({
      id: `${kind}-${n}`,
      kind,
      intent: intent.slice(0, 200),
      // A chain, not a lattice. The clauses arrived in an order the user chose, and
      // nothing here knows enough to say that two of them are independent.
      after: previous ? [previous.id] : [],
      criteria: criteriaFor(kind, hint),
      budget: BUDGETS[kind],
    });
  };

  for (const clause of parsed.clauses) {
    if (clause.outcome === 'ignored') continue;

    const text = clause.text.trim();
    if (!text) continue;

    const found = extractConstraints(text);
    constraints.push(...found);

    const kind = kindOf(text);
    if (!kind) {
      unclassified.push(text);
      // A clause nobody could classify may still have stated a limit -- intent.ts splits
      // "flights from Delhi to Mumbai under 8000" at the from/to boundary, leaving the
      // constraint in a fragment with no verb in it. The limit is still an instruction.
      const stray = found[0];
      if (stray) push('filter', `narrow the results to ${stray.text}`, stray.text);
      continue;
    }

    // One clause can carry two legs: "find the best phone under 30,000" is a reading and
    // a limit. They are emitted in the order the cues appear in the sentence, rather than
    // in an order chosen here, so the plan reads the way the user wrote it.
    const constraintAt = found.length > 0 ? text.indexOf(found[0]?.text ?? '') : -1;
    const emitFilterFirst =
      kind !== 'filter' && constraintAt >= 0 && constraintAt < cueAt(text);

    const limit = found[0];
    const filterIntent = limit ? `narrow the results to ${limit.text}` : '';

    if (emitFilterFirst && limit) push('filter', filterIntent, limit.text);
    push(kind, text, hintFor(kind, text));
    if (!emitFilterFirst && limit && kind !== 'filter') push('filter', filterIntent, limit.text);

    // "the best one" is a reading *and* a choice. Without this the plan inspects a list
    // and then has no leg that says a candidate was ever picked, which is the leg the
    // whole task turns on.
    if (SUPERLATIVE.test(text) && kind !== 'select' && kind !== 'submit') {
      push('select', `choose the candidate that best fits: ${text}`, text);
    }
  }

  // A final checkpoint, so "done" is a thing the loop observed rather than a thing it ran
  // out of legs to disprove. Only when there is a run to check: a two-leg plan that is
  // navigate-then-confirm is a checkpoint on nothing.
  const acted = subgoals.some(
    (s) => s.kind === 'interact' || s.kind === 'submit' || s.kind === 'select',
  );
  const alreadyChecks = subgoals.some((s) => s.kind === 'confirm');
  // Only once the goal is already multi-step. Appending a checkpoint to a single leg
  // would turn every "fill first name with Leo" into a two-leg plan, and put a
  // decomposition on the wire for a task that has nothing to decompose.
  if (acted && !alreadyChecks && subgoals.length >= MIN_SUBGOALS) {
    push('confirm', 'check that the task produced the result that was asked for', '');
  }

  return {
    // One leg is not a multi-step task. Leaving the plan empty keeps every single-field
    // run exactly as it was: no plan on the wire, none in the state record, none in the
    // step note.
    subgoals: subgoals.length >= MIN_SUBGOALS ? subgoals : [],
    unclassified,
    constraints,
  };
}

/**
 * What the criterion should look for, taken out of the clause.
 *
 * The object of the verb, stripped of the verb and of articles: "search for mobiles" gives
 * "mobiles", which is a term the element list can plausibly be matched against. Nothing
 * clever, and nothing invented -- if the clause has no object the criterion is dropped
 * rather than guessed at.
 */
function hintFor(kind: SubgoalKind, clause: string): string {
  if (kind === 'navigate' || kind === 'confirm' || kind === 'filter') return '';
  const object = clause
    .replace(/^\W*\w+(?:\s+(?:for|up|to|out|at|the|a|an|it|me)\b)*\s*/i, '')
    .replace(/\b(?:under|below|less than|over|above|at least|at most)\b.*$/i, '')
    // Everything after a value joiner is the value, not the thing being named. The goal
    // has been through the allocator already, but a hint reading "first name with Leo" is
    // a worse hint as well as a wider one.
    .replace(/\s+(?:with|as|=|:)\s+.*$/i, '')
    .trim();
  return object.slice(0, 120);
}

/** The decomposition in one line for a step note. Kinds and ids, never page content. */
export function describeDecomposition(decomposition: Decomposition): string {
  if (decomposition.subgoals.length === 0) return '';
  return `plan: ${decomposition.subgoals.map((s) => s.id).join(' -> ')}`;
}
