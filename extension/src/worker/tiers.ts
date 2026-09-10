/**
 * One pipeline, three tiers, chosen per step.
 *
 * There is no stub mode and no model mode. There is a question -- "what does the user want
 * done to this page?" -- and three ways to answer it, tried in order of cost:
 *
 *   Tier 0   the device answers. No model, no network, no screenshot.
 *   Tier 1   a model on the user's own machine breaks a tie between candidates.
 *   Tier 2   the remote planner, which sees only what the gate let through.
 *
 * Escalation is not failure. Most steps of a real task are open-ended and belong to Tier 2
 * on the first look; what Tier 0 buys is that "fill first name with leo" never leaves the
 * laptop, and that is the common case for the instruction a person actually types.
 *
 * The tier that decided is recorded on every step. So is the score gap Tier 0 measured,
 * because a fast path that cannot show its margin is indistinguishable from a guess.
 *
 * Node-pure: the model call and the network call are the caller's business.
 */

import type { Action } from '../shared/contract';
import type { ObservedElement } from '../shared/observed';
import { describeBlock, isAllCheckboxes, normalise, type GoalBlock, type Intent } from './intent';
import { resolveTarget, type Candidate, type Resolution } from './resolve';

export type Tier = 0 | 1 | 2;

/**
 * Why a step did not stop at Tier 0.
 *
 * The first three are about the *page*: the sentence was understood and the element could
 * not be picked out of it. The last four are about the *sentence*, and they are why this
 * union grew in M16 -- an escalation whose reason is always "open-ended" cannot tell an
 * operator the difference between "this is a real task for the planner" and "you wrote
 * something I refused to guess at".
 */
export type EscalationReason =
  | 'open-ended'
  | 'tie'
  | 'below-floor'
  | 'negation'
  | 'residue'
  | 'unparsed'
  | 'ambiguous'
  /**
   * Tier 0 was skipped on purpose: its last answer did not work.
   *
   * The eighth reason and the only one that is not about this step's sentence or this
   * step's page. It is about the previous step -- the recovery ladder decided that
   * whatever picked the target last time should not pick it again (recover.ts).
   */
  | 'recovery';

/** What Tier 0 decided, and what it measured while deciding. */
export interface LocalPlan {
  actions: Action[];
  /** Per intent, the winning index and how far clear it was. For the trace. */
  decisions: Array<{ target: string; index: number; score: number; gap: number }>;
}

export interface Escalation {
  /** The intent Tier 0 could not place. Tier 1 is asked about exactly this one. */
  intent: Intent;
  candidates: Candidate[];
  reason: 'tie' | 'below-floor' | 'open-ended';
}

export type TierChoice =
  | { tier: 0; plan: LocalPlan }
  | { tier: 1; escalation: Escalation }
  | { tier: 2; reason: EscalationReason; detail?: string };

/**
 * What `chooseTier` needs to know about the sentence.
 *
 * `ParsedGoal` satisfies this structurally, and the router passes a hybrid: the intents
 * after tokenisation, with the block from the parse that produced them. Written as its own
 * type rather than taking `ParsedGoal` because the intents that reach here have been
 * through the allocator and the ones that came out of the parser have not.
 */
export interface TierGoal {
  intents: Intent[];
  /** Set when the sentence itself forbids a local answer. See intent.ts. */
  block?: GoalBlock;
}

/**
 * The action one resolved intent becomes.
 *
 * `text` is the token when the value was PII and the literal otherwise. That is the same
 * contract a planner-emitted action has, so the executor's rehydration path handles both
 * without knowing which tier produced them -- and a value the user typed into the task box
 * reaches the field by the same route as one found on the page.
 */
function formatNavigateUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const siteMap: Record<string, string> = {
    spotify: 'https://open.spotify.com',
    amazon: 'https://www.amazon.com',
    youtube: 'https://www.youtube.com',
    google: 'https://www.google.com',
    github: 'https://github.com',
    wikipedia: 'https://www.wikipedia.org',
    reddit: 'https://www.reddit.com',
    twitter: 'https://x.com',
  };
  const lower = trimmed.toLowerCase();
  if (siteMap[lower]) return siteMap[lower];
  if (trimmed.includes('.')) return `https://${trimmed}`;
  return `https://${trimmed.replace(/\s+/g, '')}.com`;
}

export function actionFor(intent: Intent, index: number): Action | null {
  switch (intent.verb) {
    case 'fill': {
      const isSearch = ['search', 'search box', 'search bar', 'search query', 'query', 'lookup', 'search input'].includes(
        normalise(intent.target),
      );
      return {
        type: 'type',
        index,
        text: intent.valueRef ?? intent.value ?? '',
        submit: isSearch,
      };
    }
    case 'select':
      return intent.value ? { type: 'select', index, option: intent.value } : null;
    case 'click':
    case 'submit':
      return { type: 'click', index };
    case 'navigate':
      return {
        type: 'navigate',
        url: formatNavigateUrl(intent.value ?? intent.target),
      };
    default:
      return null;
  }
}

/** At most this many actions in one batch, matching the contract's own ceiling. */
const MAX_ACTIONS = 4;

/**
 * Choose a tier for this step.
 *
 * All-or-nothing across the intents on purpose. A goal that names two fields and whose
 * second field is ambiguous is not half a local plan: acting on the first and escalating
 * the second would send a screenshot describing a page the agent had already changed, and
 * the planner would be reasoning about a state one action out of date.
 *
 * ## Where the block is checked, and why it goes straight past Tier 1
 *
 * The block comes first, before a single element is scored, because it is a fact about the
 * sentence and no amount of looking at the page can change it. "Dont fill last name with
 * Leo" resolves to a perfectly good element with a comfortable margin -- resolution was
 * never the problem.
 *
 * It escalates to Tier 2 and not to Tier 1, and this is a place where the built system
 * differs from what M16 asked for. Tier 1 answers exactly one question: given this shortlist
 * of candidate elements, which index? A blocked goal has no shortlist, because the thing
 * that failed was comprehension, not resolution -- there is no candidate list to hand it and
 * nothing it could say back within the one-index contract it is deliberately held to. So
 * blocked goals go to the tier that can actually read a sentence. The reason travels with
 * them, so the log says which rung was skipped and why.
 */
export function chooseTier(goal: TierGoal, elements: ObservedElement[]): TierChoice {
  const { intents } = goal;

  if (goal.block) {
    return { tier: 2, reason: goal.block.kind, detail: describeBlock(goal.block) };
  }
  if (intents.length === 0) return { tier: 2, reason: 'open-ended' };

  const actions: Action[] = [];
  const decisions: LocalPlan['decisions'] = [];

  for (const original of intents.slice(0, MAX_ACTIONS)) {
    let intent = original;
    if (intent.verb === 'navigate') {
      const action = actionFor(intent, -1);
      if (action) {
        actions.push(action);
        decisions.push({
          target: intent.target,
          index: -1,
          score: 10,
          gap: 10,
        });
        break;
      }
    }

    if (isAllCheckboxes(intent.target)) {
      const checkboxElements = elements.filter(
        (el) =>
          el.index !== undefined &&
          (el.role === 'checkbox' || el.role === 'switch' || el.inputType === 'checkbox'),
      );
      if (checkboxElements.length > 0) {
        const isUncheck = /\buncheck\b/i.test(intent.target);
        const toToggle = checkboxElements.filter((el) =>
          isUncheck ? el.state.checked === true : el.state.checked !== true,
        );
        const batch = (toToggle.length > 0 ? toToggle : checkboxElements).slice(0, MAX_ACTIONS);
        for (const cb of batch) {
          if (cb.index === undefined) continue;
          actions.push({ type: 'click', index: cb.index });
          decisions.push({
            target: intent.target,
            index: cb.index,
            score: 10,
            gap: 10,
          });
        }
        continue;
      }
    }

    let resolution: Resolution = resolveTarget(intent, elements);

    // Let the page settle a sentence the grammar could not.
    //
    // `as` reads two ways and no vocabulary covers every site: "enter DL Number as
    // 10001000193" means field-then-value, the pattern says value-then-field, and "DL
    // Number" is a field name on precisely one government website. The parser hands both
    // readings up rather than guessing, and this is where the guess becomes a measurement --
    // the page has a box captioned "DL Number" and nothing called 10001000193, so the
    // question answers itself against the only evidence that is actually about this page.
    //
    // Only when the primary reading failed outright. A reading that resolves is not
    // improved by trying the other one, and preferring the alternative on a tie would be a
    // second coin toss on top of the one the margin already refuses to make.
    if (resolution.kind !== 'resolved' && original.alt) {
      const swapped: Intent = {
        ...original,
        target: original.alt.target,
        ...(original.alt.value === undefined ? {} : { value: original.alt.value }),
      };
      // The token was minted for the *other* value, so it cannot travel with this reading.
      delete swapped.valueRef;
      delete swapped.alt;

      const other = resolveTarget(swapped, elements);
      if (other.kind === 'resolved') {
        intent = swapped;
        resolution = other;
      }
    }

    if (resolution.kind !== 'resolved') {
      return {
        tier: 1,
        escalation: {
          intent,
          candidates: resolution.candidates,
          reason: resolution.reason,
        },
      };
    }

    const action = actionFor(intent, resolution.index);
    if (!action) {
      // A verb we resolved but cannot express -- "select" with nothing to select. The
      // planner can, so it gets the step rather than the step doing nothing.
      return {
        tier: 1,
        escalation: { intent, candidates: resolution.candidates, reason: 'tie' },
      };
    }

    actions.push(action);
    decisions.push({
      target: intent.target,
      index: resolution.index,
      score: resolution.score,
      gap: resolution.gap,
    });
  }

  return actions.length > 0
    ? { tier: 0, plan: { actions, decisions } }
    : { tier: 2, reason: 'open-ended' };
}
