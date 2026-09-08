/**
 * Find the field the user named, wherever it is on the page.
 *
 * ## The failure
 *
 * Two runs, same page, same sentence, same build. `fill first name with leo` on the
 * w3schools contact form:
 *
 *   scrolled to the form   tier 0 · nothing sent | first name -> [62] | ok at settle
 *   scrolled two screens   tier 2 · nothing sent | tier 1 declined (below-floor) | failed
 *
 * The only difference was where the scrollbar happened to be. `perceive` filters every
 * admission class through `intersectsViewport`, which is correct for redaction -- what
 * leaves the machine is a photograph of the visual viewport, and a box outside it cannot
 * be painted in that frame -- but the same list is what `resolve.ts` scores the sentence
 * against. So the agent's ability to hear its user depended on the scroll position, and it
 * failed in the direction that looks like a bug in something else entirely: with no
 * planner running, `failed at plan`.
 *
 * ## The fix, and what it deliberately does not do
 *
 * It does not widen perception. The viewport rule stays exactly as it was.
 *
 * Instead, when the sentence parsed and the field was not on screen, the worker asks for a
 * survey -- every control in the document, values stripped -- scores the *same* resolver
 * against it, and asks the page to scroll the winner into view. Then it perceives again,
 * normally, and re-runs the tier choice. Every action still comes from a real in-viewport
 * walk with a real index; nothing here produces an index anyone acts on.
 *
 * Bounded, because "scroll until it works" is a loop and this project does not have those.
 * At most REVEAL_ATTEMPTS reveals per step, one per intent that could not be placed. A goal
 * naming two fields that are three screens apart cannot be satisfied by one scroll position
 * and is not silently half-done: it escalates, and the note says why.
 *
 * Node-pure. The messages are the caller's business.
 */

import type { ObservedElement } from '../shared/observed';
import type { Intent } from './intent';
import { resolveTarget } from './resolve';

/**
 * How many times one step will scroll and look again.
 *
 * One per intent would be the principled number; four is the action ceiling and therefore
 * the most intents a Tier 0 plan can carry. In practice the first reveal settles it: fields
 * a sentence names together are laid out together.
 */
export const REVEAL_ATTEMPTS = 4;

export interface RevealTarget {
  intent: Intent;
  /** The stable key of the control the survey matched. */
  key: string;
  score: number;
  gap: number;
}

/**
 * Which intents the current viewport cannot place, and where they actually are.
 *
 * Returns one entry per intent that the survey could place and the viewport could not.
 * An intent that neither can place is not here: nothing on this page matches what the user
 * asked for, scrolling will not change that, and the honest answer is the escalation the
 * caller was about to make anyway.
 */
export function locate(
  intents: readonly Intent[],
  inViewport: readonly ObservedElement[],
  surveyed: readonly ObservedElement[],
): RevealTarget[] {
  const targets: RevealTarget[] = [];

  for (const intent of intents) {
    // Already reachable. Scrolling towards it would move something else out of view.
    if (resolveTarget(intent, [...inViewport]).kind === 'resolved') continue;

    const found = resolveTarget(intent, [...surveyed]);
    if (found.kind !== 'resolved') continue;

    const element = surveyed.find((candidate) => candidate.index === found.index);
    if (!element?.key) continue;

    targets.push({ intent, key: element.key, score: found.score, gap: found.gap });
  }

  // Best margin first. If only one scroll is going to happen, it should be the one the
  // resolver is most confident about rather than whichever intent came first in the
  // sentence.
  return targets.sort((a, b) => b.gap - a.gap);
}

/** What the step log and the trace say about a reveal. Field names only, never values. */
export function describeReveal(
  targets: readonly RevealTarget[],
  revealed: readonly string[],
): string {
  if (targets.length === 0) return '';
  const names = targets.map((t) => `"${t.intent.target}"`).join(', ');
  return revealed.length === 0
    ? `${names} was off screen and could not be revealed`
    : `scrolled to reach ${names}`;
}
