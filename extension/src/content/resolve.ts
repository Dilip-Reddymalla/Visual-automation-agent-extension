/**
 * Turning a placeholder back into the value it stands for.
 *
 * Extracted from content/index.ts for one reason: the distinction this function draws is
 * a privacy-relevant contract, and a contract that cannot be tested in Node is a
 * contract nobody checks. The entry point runs `main()` on import, so nothing in it is
 * reachable from a unit test; this file uses only the injectable bus and is.
 *
 * The distinction, restated because it is the whole point:
 *
 *   unknown-placeholder   the planner invented a token this session never issued.
 *                         Theirs. Refuse this one action and carry on.
 *   session-lost          our own map is gone -- the offscreen host was suspended,
 *                         collected, or never came up. Ours. End the step.
 *
 * Collapsing the two either lets a fabricated token look like our own bug, or reports
 * our state loss as the planner misbehaving. Both are wrong in a way that is invisible
 * from the outside, which is why this is worth a file.
 */

import { send } from '../shared/messages';
import type { ResolveOutcome } from './executor';

/**
 * Ask the offscreen document, once.
 *
 * A resolved reply -- value or reason -- is an answer. A throw is not: `send` rejects on
 * transport failure and on the five-second timeout, and an absent offscreen document
 * produces exactly that.
 */
async function ask(sessionId: string, placeholder: string): Promise<ResolveOutcome> {
  const reply = await send(
    'PLACEHOLDER_RESOLVE',
    { sessionId, placeholder },
    { to: 'offscreen' },
  );
  if (reply.value !== undefined) return { ok: true, value: reply.value };
  return { ok: false, reason: reply.reason ?? 'unknown-placeholder' };
}

/**
 * Ask the offscreen document what a token stands for, bringing it back if it has gone.
 *
 * Without the catch this function had a hole precisely where its distinction lives: with
 * no offscreen document the bus times out after five seconds and rejects with a
 * transport error, so the caller saw a thrown `Error` rather than `session-lost` -- the
 * one outcome the whole two-reason contract exists to express. The executor's
 * StepEndingRejection never fired; the raw error escaped `execute()` and killed the
 * batch by a different route, with a message about the bus rather than about the
 * session.
 *
 * So: catch, ask the worker to bring the host up (only the worker can create an
 * offscreen document, which is why HOST_ENSURE goes there and not to the host itself),
 * and try exactly once more. Once, not repeatedly -- a host that will not come up twice
 * running is not going to on the third ask, and an action already has a step's worth of
 * timeout budget behind it.
 *
 * The retry's `unknown-placeholder` is reported as `session-lost`, and that is not a
 * conflation but the honest reading of what just happened. We only reach the retry
 * because the first ask failed at the transport, which means the host was absent; a host
 * that had to be created has an empty allocator map, so *every* token looks invented to
 * it. Calling that the planner's fault would blame it for our own restart. When the host
 * was in fact alive all along, HOST_ENSURE is a no-op, the map is intact, and the value
 * comes back -- this path is not reached.
 */
export async function resolveThroughOffscreen(
  sessionId: string,
  placeholder: string,
): Promise<ResolveOutcome> {
  try {
    return await ask(sessionId, placeholder);
  } catch {
    try {
      await send('HOST_ENSURE', {});
    } catch {
      return { ok: false, reason: 'session-lost' };
    }

    try {
      const second = await ask(sessionId, placeholder);
      // See above: a resurrected host cannot tell an invented token from a lost map, and
      // the safe reading of that ambiguity is that the loss was ours.
      if (!second.ok && second.reason === 'unknown-placeholder') {
        return { ok: false, reason: 'session-lost' };
      }
      return second;
    } catch {
      return { ok: false, reason: 'session-lost' };
    }
  }
}
