/**
 * Choosing between things on a page, when the goal named a constraint rather than a target.
 *
 * ## The problem this is for
 *
 * "Find the best phone under 30,000" names no element. `resolve.ts` answers "which of these
 * controls did the user mean", and there is no answer: the user meant whichever of forty
 * repeated cards satisfies an arithmetic condition, and which one that is cannot be known
 * without reading the numbers on them.
 *
 * ## What it refuses to do
 *
 * It does not invent attributes. A candidate carries the numbers that are *printed near it*
 * and nothing else -- no assumed rating, no inferred category, no "phones usually cost". If
 * the page does not say, the answer is `insufficient-evidence`, which escalates to a model
 * that can see the picture, rather than a confident pick with nothing behind it. That is
 * the whole reason the verdict is an enum with four values instead of an optional
 * `best`: "I could not tell" has to be sayable.
 *
 * It also does not scrape. Candidates come from the element list the walker already
 * produced for this step -- the same list the planner would have been shown -- and are
 * capped. Nothing is fetched, nothing is followed, and no page content is persisted: what
 * leaves this module is an index, a box, and numbers.
 *
 * ## Why it is geometry and not the DOM
 *
 * A product card, a search result and a flight row have nothing in common structurally
 * across two sites, and everything in common visually: a thing you can click, with its
 * numbers printed beside it. So an anchor claims the facts printed within a band around it.
 * That works on a table, a grid and a list, and it works on a site nobody has seen.
 *
 * Node-pure.
 */

import type { Box } from '../shared/coords';
import type { ObservedElement } from '../shared/observed';
import { CURRENCY, toNumber, type Constraint } from './decompose';

/** How many candidates are ever considered. A page of forty results is still forty. */
export const MAX_CANDIDATES = 24;

/**
 * How far below an anchor its own numbers may be printed, in CSS px.
 *
 * A card's price sits under its title; the next card's title sits under that. Too generous
 * a band and every candidate claims its neighbour's price, which is worse than claiming
 * none: a wrong number is acted on and a missing one escalates.
 */
export const CARD_BAND = 220;

/** One number printed near a candidate, with whatever labelled it. */
export interface CandidateFact {
  value: number;
  /** The currency or unit as written, or '' when the number was bare. */
  unit: string;
  /** The text the number was read out of, trimmed. Page content -- never persisted. */
  text: string;
}

/** A thing on the page that could be chosen. */
export interface Candidate {
  /** The handle to act on. Candidates without one cannot be chosen. */
  index: number;
  /** Accessible name. Already what the planner is shown; never written to storage. */
  name: string;
  box: Box;
  facts: CandidateFact[];
}

/** Roles that stand for "a thing you could pick". */
const ANCHOR_ROLES: ReadonlySet<string> = new Set([
  'link',
  'button',
  'option',
  'radio',
  'checkbox',
]);

/**
 * Units a number can be printed in, beyond currency.
 *
 * Short and closed. This is not a units library -- it is the list of things a page puts
 * next to a number when the number means something a person would compare.
 */
const UNIT_WORD = String.raw`(?:%|stars?|reviews?|ratings?|days?|weeks?|months?|years?|hrs?|hours?|mins?|minutes?|km|kms|kg|kb|mb|gb|tb|seats?|nights?|pages?|items?)`;

const AMOUNT_RE = new RegExp(
  String.raw`(${CURRENCY})?\s*(\d[\d,]*(?:\.\d+)?)\s*(crores?\b|lakhs?\b|[kKmM]\b)?\s*(${UNIT_WORD}\b)?`,
  'gi',
);

/**
 * Every amount in a string, in the order it was written.
 *
 * A bare integer is *not* an amount. That rule is the whole of this function's
 * correctness: "Item 1" would otherwise contribute the fact `1`, "AI 501 06:10" the fact
 * `501`, and a page of flight numbers would be filtered as though it were a page of fares.
 * A number becomes a fact only when the page marked it as one -- a currency sign, a
 * written multiplier, or a unit word after it.
 */
export function readAmounts(text: string): CandidateFact[] {
  const out: CandidateFact[] = [];
  AMOUNT_RE.lastIndex = 0;
  for (let m = AMOUNT_RE.exec(text); m; m = AMOUNT_RE.exec(text)) {
    const [whole, currency, digits, multiplier, unitWord] = m;
    if (!digits) continue;
    // Nothing marked this number as a quantity of anything.
    if (!currency && !multiplier && !unitWord) continue;
    const value = toNumber(digits, multiplier);
    if (!Number.isFinite(value)) continue;
    out.push({
      value,
      unit: (currency ?? unitWord ?? '').trim(),
      text: whole.trim(),
    });
  }
  return out;
}

/**
 * The DOM path out of an element's stable key.
 *
 * `stableKey` (content/perceive.ts) is `frame|tag|role|name|path`, and the path is the
 * last field because a name may contain anything except the separator. Reading it here
 * rather than adding a field to ObservedElement keeps the change inside the module that
 * needs it; the format is asserted in candidates.test.ts so a change to `stableKey`
 * breaks loudly rather than quietly widening every card.
 */
export function pathOf(key: string): string {
  const at = key.lastIndexOf('|');
  return at === -1 ? key : key.slice(at + 1);
}

/**
 * The container an anchor sits in -- its card, its row, its cell.
 *
 * The anchor's own parent, which on every layout that repeats is the thing being
 * repeated: `html/body/ul/li[1]/a` gives `html/body/ul/li[1]`, and the price inside that
 * card is `html/body/ul/li[1]/div`.
 */
export function containerOf(key: string): string {
  const path = pathOf(key);
  const at = path.lastIndexOf('/');
  return at === -1 ? path : path.slice(0, at);
}

/** Is this element inside that container? */
function within(container: string, key: string): boolean {
  const path = pathOf(key);
  return path === container || path.startsWith(`${container}/`);
}

/** All the text an element shows, for reading numbers out of. */
function textOf(el: ObservedElement): string {
  return [el.name, el.selectedText, ...el.textRuns.map((run) => run.text)]
    .filter(Boolean)
    .join(' ');
}

/** Is `other` inside the band this anchor claims? */
function inBand(anchor: Box, other: Box, band: number): boolean {
  const overlapsHorizontally =
    other.x < anchor.x + anchor.w && other.x + other.w > anchor.x;
  const below = other.y >= anchor.y && other.y <= anchor.y + band;
  return overlapsHorizontally && below;
}

/**
 * The things on this page that could be chosen, with the numbers printed beside them.
 *
 * Ordered by position, so "the first one" means what a reader would mean, and capped so a
 * page of four hundred rows costs the same as a page of twenty.
 */
export function findCandidates(
  elements: readonly ObservedElement[],
  band = CARD_BAND,
): Candidate[] {
  const anchors = elements.filter(
    (el) =>
      el.index !== undefined &&
      ANCHOR_ROLES.has(el.role) &&
      el.state.visible &&
      el.name.trim().length > 0,
  );

  const ordered = [...anchors].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);

  return ordered.slice(0, MAX_CANDIDATES).map((anchor) => {
    const container = containerOf(anchor.key);
    const facts: CandidateFact[] = [...readAmounts(textOf(anchor))];
    for (const el of elements) {
      if (el === anchor) continue;
      // Structure first, geometry second.
      //
      // Geometry alone was wrong in a way that only showed in a real browser: on a
      // product page the "Back to the market" link sits above the title, the price is
      // printed a hundred pixels below it, and a band-only rule let a navigation link
      // claim the product's price -- so the run "chose" the Back link, went back, and did
      // it again. The DOM already says which card a number belongs to. The band stays as
      // a second filter, for a container tall enough to hold two of anything.
      if (!within(container, el.key)) continue;
      if (!inBand(anchor.box, el.box, band)) continue;
      // Another anchor's own text belongs to that anchor, not to this one.
      if (el.index !== undefined && ANCHOR_ROLES.has(el.role)) continue;
      facts.push(...readAmounts(textOf(el)));
    }
    return {
      // Filtered above; the walker guarantees an index on an interactive element.
      index: anchor.index ?? 0,
      name: anchor.name,
      box: anchor.box,
      facts,
    };
  });
}

// -- Deciding -------------------------------------------------------------------

/** Which way the goal asked us to order the eligible candidates. */
export type Preference = 'lowest' | 'highest' | 'first' | 'none';

/**
 * Read the ordering out of the goal's own words.
 *
 * A superlative is the only thing that licenses picking one candidate over another. "Find
 * a phone under 30,000" asks for an eligible one; "find the *cheapest* phone under 30,000"
 * asks for a particular one, and the difference decides whether a single pick is supported
 * by the sentence at all.
 */
export function preferenceIn(goal: string): Preference {
  const text = goal.toLowerCase();
  if (/\b(?:cheapest|lowest|least expensive|nearest|closest|earliest|shortest|smallest)\b/.test(text)) {
    return 'lowest';
  }
  if (/\b(?:highest|most expensive|largest|longest|latest|top[- ]rated|best[- ]rated)\b/.test(text)) {
    return 'highest';
  }
  if (/\b(?:first|first available|next available|any)\b/.test(text)) return 'first';
  return 'none';
}

export type Verdict =
  /** One candidate is supported by the evidence and the goal's own ordering. */
  | 'choose'
  /** Candidates exist and nothing on the page separates them. Ask a model. */
  | 'insufficient-evidence'
  /** Every candidate was ruled out by a constraint the user stated. */
  | 'none-eligible'
  /** The constraints cannot all hold at once. Nothing can satisfy them. */
  | 'conflicting-constraints'
  /** There is nothing here to choose between. */
  | 'no-candidates';

export interface Rejection {
  index: number;
  why: 'over-maximum' | 'under-minimum' | 'outside-range';
}

export interface Evaluation {
  verdict: Verdict;
  /** Set only when the verdict is `choose`. */
  best?: Candidate;
  /** Candidates that satisfied every constraint, in page order. */
  eligible: Candidate[];
  rejected: Rejection[];
  /** Candidates with no number to judge, so no constraint could be applied to them. */
  unjudged: Candidate[];
  /** Counts and enum names, safe for a step note. Never a candidate's text. */
  reason: string;
}

/** Does this candidate satisfy the constraint, and if not, why not? */
function against(
  candidate: Candidate,
  constraint: Constraint,
): { ok: boolean; why?: Rejection['why'] } | undefined {
  // Prefer a number in the same unit the constraint named; fall back to any number when
  // the constraint was bare. Anything else is comparing a price to a star rating.
  const usable = constraint.unit
    ? candidate.facts.filter((f) => f.unit.toLowerCase() === constraint.unit.toLowerCase())
    : candidate.facts;
  if (usable.length === 0) return undefined;

  // The largest number in a card is the one a price constraint is about: a phone card
  // prints "₹28,999" beside "24 months" and "8 GB".
  const value = Math.max(...usable.map((f) => f.value));

  switch (constraint.kind) {
    case 'max':
      return value <= constraint.value ? { ok: true } : { ok: false, why: 'over-maximum' };
    case 'min':
      return value >= constraint.value ? { ok: true } : { ok: false, why: 'under-minimum' };
    case 'range':
      return value >= constraint.value && value <= (constraint.upper ?? Infinity)
        ? { ok: true }
        : { ok: false, why: 'outside-range' };
  }
}

/** Can these constraints all hold at once? */
export function constraintsConflict(constraints: readonly Constraint[]): boolean {
  let floor = -Infinity;
  let ceiling = Infinity;
  for (const constraint of constraints) {
    if (constraint.kind === 'min') floor = Math.max(floor, constraint.value);
    if (constraint.kind === 'max') ceiling = Math.min(ceiling, constraint.value);
    if (constraint.kind === 'range') {
      floor = Math.max(floor, constraint.value);
      ceiling = Math.min(ceiling, constraint.upper ?? Infinity);
    }
  }
  return floor > ceiling;
}

/** The number a preference orders by: the largest in the card, as above. */
function orderingValue(candidate: Candidate, unit: string): number | undefined {
  const usable = unit
    ? candidate.facts.filter((f) => f.unit.toLowerCase() === unit.toLowerCase())
    : candidate.facts;
  if (usable.length === 0) return undefined;
  return Math.max(...usable.map((f) => f.value));
}

export interface EvaluateInput {
  candidates: readonly Candidate[];
  constraints: readonly Constraint[];
  preference: Preference;
}

/**
 * Which candidate the goal supports choosing, if any.
 *
 * The verdicts are the point. Three of the five are refusals, and each is a different
 * thing to do next: `none-eligible` means say so to the operator, `conflicting-constraints`
 * means the request cannot be satisfied by anything, and `insufficient-evidence` means the
 * page did not print what the sentence asked about -- which is a question for a model that
 * can see the picture, not a reason to guess.
 *
 * A single eligible candidate is chosen without a preference, because there is nothing to
 * prefer between. More than one, with no ordering in the sentence, is not a choice this
 * module is entitled to make.
 */
export function evaluate(input: EvaluateInput): Evaluation {
  const { candidates, constraints, preference } = input;

  if (candidates.length === 0) {
    return {
      verdict: 'no-candidates',
      eligible: [],
      rejected: [],
      unjudged: [],
      reason: 'nothing on the page to choose between',
    };
  }

  if (constraintsConflict(constraints)) {
    return {
      verdict: 'conflicting-constraints',
      eligible: [],
      rejected: [],
      unjudged: [],
      reason: 'the stated limits cannot all hold at once',
    };
  }

  const eligible: Candidate[] = [];
  const rejected: Rejection[] = [];
  const unjudged: Candidate[] = [];

  for (const candidate of candidates) {
    let ok = true;
    let judged = constraints.length === 0;

    for (const constraint of constraints) {
      const outcome = against(candidate, constraint);
      if (!outcome) continue; // this constraint has nothing to bite on here
      judged = true;
      if (!outcome.ok) {
        ok = false;
        rejected.push({ index: candidate.index, why: outcome.why ?? 'over-maximum' });
        break;
      }
    }

    if (!ok) continue;
    // A constraint was stated and this candidate printed nothing it could apply to.
    // Counting that as eligible is how a page of unpriced cards ends up in a basket.
    if (!judged) unjudged.push(candidate);
    else eligible.push(candidate);
  }

  const unit = constraints[0]?.unit ?? '';

  if (eligible.length === 0) {
    const verdict: Verdict = unjudged.length > 0 ? 'insufficient-evidence' : 'none-eligible';
    return {
      verdict,
      eligible,
      rejected,
      unjudged,
      reason:
        verdict === 'insufficient-evidence'
          ? `${unjudged.length} candidates, none printing a number the limit applies to`
          : `${rejected.length} candidates, all outside the stated limits`,
    };
  }

  if (eligible.length === 1) {
    return {
      verdict: 'choose',
      best: eligible[0],
      eligible,
      rejected,
      unjudged,
      reason: '1 eligible candidate',
    };
  }

  const ordered = rank(eligible, preference, unit);
  if (!ordered) {
    return {
      verdict: 'insufficient-evidence',
      eligible,
      rejected,
      unjudged,
      reason: `${eligible.length} eligible candidates and nothing in the goal to order them by`,
    };
  }

  return {
    verdict: 'choose',
    best: ordered,
    eligible,
    rejected,
    unjudged,
    reason: `${eligible.length} eligible, chose the ${preference} by ${unit || 'value'}`,
  };
}

/** The candidate a preference picks, or undefined when the preference cannot be applied. */
function rank(
  eligible: readonly Candidate[],
  preference: Preference,
  unit: string,
): Candidate | undefined {
  if (preference === 'none') return undefined;
  if (preference === 'first') return eligible[0];

  const scored = eligible
    .map((candidate) => ({ candidate, value: orderingValue(candidate, unit) }))
    .filter((entry): entry is { candidate: Candidate; value: number } => entry.value !== undefined);

  if (scored.length === 0) return undefined;

  scored.sort((a, b) => (preference === 'lowest' ? a.value - b.value : b.value - a.value));
  // A tie at the top is not an ordering. Two cards at the same price are two answers.
  if (scored.length > 1 && scored[0]?.value === scored[1]?.value) return undefined;
  return scored[0]?.candidate;
}

/** The evaluation in one line for a step note. Counts and enum names only. */
export function describeEvaluation(evaluation: Evaluation): string {
  return `candidates: ${evaluation.verdict} (${evaluation.reason})`;
}
