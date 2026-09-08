/**
 * Where the placeholder map lives, and why it lives there.
 *
 * The map holds raw values -- it is the single most sensitive object in the extension.
 * Four constraints decide its home, and only one place satisfies all of them:
 *
 *   It must not be persisted.        Storage outlives the session and the gate cannot
 *                                    reach into it. So: memory only, never
 *                                    chrome.storage.
 *   It must outlive an MV3 worker.   The service worker is terminated between steps,
 *                                    routinely. So: not the worker.
 *   It must be reachable by M9.      The executor, in the content script, has to turn
 *                                    a planned placeholder back into a value before
 *                                    typing it. So: reachable over the bus.
 *   It must sit where sealing does.  M6 allocates while building the manifest, and a
 *                                    round trip per finding would be absurd.
 *
 * That is the offscreen document (on Firefox, the background event page): it holds no
 * storage, it is not the worker, it answers messages, and SEAL_AND_ENCODE already runs
 * there.
 *
 * One instance per session. A new session gets a new map, because placeholder numbering
 * is per-session by definition -- PERSON_1 in one task is not PERSON_1 in the next.
 *
 * The Firefox caveat is real and is handled loudly. A background event page can be
 * suspended, taking the map with it. Silently re-allocating would hand the planner
 * PERSON_1 for a different human mid-task, and stable numbering across steps is the one
 * property the planner is told it can rely on. So a resolve for a session we no longer
 * hold reports the loss, and the step ends.
 */

import { PlaceholderAllocator } from '../shared/placeholders';

/** The live map, and the session it belongs to. Exactly one at a time. */
let current: PlaceholderAllocator | null = null;

/** Sessions whose map we know we lost, so the degradation is reported once, not twice. */
const abandoned = new Set<string>();

/**
 * The allocator for this session, creating it if this is the first the host has heard
 * of it. Starting a different session drops the previous map immediately: those values
 * have no further use, and holding them would be holding PII for no reason.
 */
export function allocatorFor(sessionId: string): PlaceholderAllocator {
  if (current?.sessionId === sessionId) return current;
  if (current) abandoned.add(current.sessionId);
  current = new PlaceholderAllocator(sessionId);
  return current;
}

export type ResolveOutcome =
  | { ok: true; value: string }
  /** The session is live and simply never issued this placeholder. */
  | { ok: false; reason: 'unknown-placeholder' }
  /** The host was suspended and the map went with it. The step must end. */
  | { ok: false; reason: 'session-lost' };

/**
 * Resolve a placeholder for a session, distinguishing "we never issued that" from "we
 * used to know and no longer do".
 *
 * The difference matters. The first is a planner inventing a token, which is a plan to
 * reject. The second is our own state loss, which is a degradation to report -- and the
 * two must never be conflated, because one is the model's fault and one is ours.
 */
export function resolvePlaceholder(sessionId: string, placeholder: string): ResolveOutcome {
  if (!current || current.sessionId !== sessionId) {
    return { ok: false, reason: 'session-lost' };
  }
  const value = current.resolve(placeholder);
  if (value === undefined) return { ok: false, reason: 'unknown-placeholder' };
  return { ok: true, value };
}

/** True once this session's map has been dropped. For the degradation event. */
export function wasAbandoned(sessionId: string): boolean {
  return abandoned.has(sessionId);
}

/** End of session: drop the values. Called when the agent stops or the tab closes. */
export function disposeAllocator(sessionId?: string): void {
  if (sessionId !== undefined && current?.sessionId !== sessionId) return;
  if (current) abandoned.add(current.sessionId);
  current = null;
}

/** Tests only. */
export function resetAllocators(): void {
  current = null;
  abandoned.clear();
}
