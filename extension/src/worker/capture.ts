/**
 * `chrome.tabs.captureVisibleTab`, rate-limited and coalesced.
 *
 * Chrome allows roughly two captures a second and rejects the rest with
 * MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND. A burst of ten mutation events must
 * therefore produce one capture, not eight rejections and two frames -- and the
 * absorbing has to happen here, because by the time that error reaches a step it looks
 * like a perception failure and the agent retries into the same wall.
 *
 * Coalescing, precisely: callers arriving while a capture is in flight, or inside the
 * cooldown after one, all receive the *same* frame. That is correct rather than merely
 * cheap. Ten mutations in 300 ms describe one page state, and photographing it once is
 * what a person would do.
 *
 * The clock and the capture function are injected, so the queue is tested in Node with
 * no browser and no timers of its own.
 */

import type { FrameRef } from '../shared/frames';

/** Chrome's limit is about two per second. 500 ms is the safe floor. */
export const MIN_CAPTURE_INTERVAL_MS = 500;

/** Why a capture did not produce a usable frame. Each one is handled differently. */
export type CaptureFailure =
  /** activeTab was revoked -- almost always a navigation since the grant. Re-perceive. */
  | 'permission-lost'
  /** The tab went away or navigated mid-capture. Discard and re-perceive. */
  | 'tab-gone'
  /** Chrome's rate limiter. Should never escape this module. */
  | 'rate-limited'
  /**
   * The tab strip is mid-change and Chrome will not photograph anything.
   *
   * "Tabs cannot be edited right now (user may be dragging a tab)" -- which Chrome also
   * says for a fraction of a second around a navigation, with no tab being dragged and
   * no user present. It is over in a frame or two, and it used to end the session: one
   * unlucky step out of three during a page load, on the demo's own page-A-to-page-B
   * transition. Retried here, like the limiter, and for the same reason: waiting is the
   * entire fix, and by the time it reaches a step it looks like a perception failure.
   */
  | 'busy'
  /** Anything else. */
  | 'unknown';

/**
 * What to do about it, for the failures where the operator can do something.
 *
 * `permission-lost` is the one that reads as a bug and is not. `captureVisibleTab` takes
 * `<all_urls>` or `activeTab`, and this extension ships `activeTab` on purpose -- it is
 * the permission that makes "what can this see?" answerable with "the tab you pointed it
 * at". Chrome grants it when the *user* invokes the extension and revokes it when the tab
 * navigates, so the first run in a fresh tab, and every run after a page load the
 * operator did not initiate, fails with a sentence about permissions that names no
 * remedy. The remedy is one click, and it belongs in the message.
 *
 * The toolbar click is also what opens and closes the side panel, so it toggles: with the
 * panel already open, one click grants the permission and hides the panel, and a second
 * brings it back. Saying so is the difference between a working instruction and one that
 * appears to make things worse.
 */
const REMEDY: Partial<Record<CaptureFailure, string>> = {
  'permission-lost':
    'this extension may only photograph a tab you have pointed it at. Click the ' +
    'Redaction Gate icon in the toolbar while this tab is in front, then run again ' +
    '(the same click toggles the panel, so click it twice if the panel was open). ' +
    'A page load revokes the grant, so it has to be this tab as it is now',
};

export class CaptureError extends Error {
  constructor(
    readonly kind: CaptureFailure,
    message: string,
  ) {
    const remedy = REMEDY[kind];
    super(remedy ? `${remedy} (${message})` : message);
    this.name = 'CaptureError';
  }
}

/** Chrome reports all of these as plain strings on runtime.lastError. */
export function classify(message: string): CaptureFailure {
  const m = message.toLowerCase();
  if (m.includes('max_capture_visible_tab_calls_per_second')) return 'rate-limited';
  if (m.includes('cannot be edited') || m.includes('dragging a tab')) return 'busy';
  if (m.includes('activetab') || m.includes('permission') || m.includes('not allowed')) {
    return 'permission-lost';
  }
  if (
    m.includes('no tab') ||
    m.includes('no window') ||
    m.includes('closed') ||
    m.includes('discarded')
  ) {
    return 'tab-gone';
  }
  return 'unknown';
}

export interface CaptureDeps {
  /** The raw API call. Resolves to a data URL, or throws. */
  capture(windowId?: number): Promise<string>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Retries after Chrome's limiter fires anyway. One is enough in practice. */
  maxRetries?: number;
}

export interface CaptureQueue {
  /**
   * A frame of the visible tab. Callers inside one cooldown window share a frame.
   * `expected` is the pre-downscale size, from the content script's geometry.
   */
  request(expected: { width: number; height: number; scale: number }): Promise<FrameRef>;
  /** For tests and for the step log. */
  stats(): { captures: number; coalesced: number; rateLimitRetries: number };
}

export function createCaptureQueue(deps: CaptureDeps): CaptureQueue {
  const maxRetries = deps.maxRetries ?? 2;

  let inFlight: Promise<FrameRef> | null = null;
  let lastCaptureAt = Number.NEGATIVE_INFINITY;
  let captures = 0;
  let coalesced = 0;
  let rateLimitRetries = 0;

  async function callWithRetries(): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await deps.capture();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const kind = classify(message);

        // The limiter fired despite the cooldown -- another extension, or a tab we do
        // not control, spent the budget. Waiting is the whole fix; it must never
        // surface as a step failure. Same for a tab strip that is mid-change: see the
        // note on 'busy'.
        if ((kind === 'rate-limited' || kind === 'busy') && attempt < maxRetries) {
          rateLimitRetries += 1;
          await deps.sleep(MIN_CAPTURE_INTERVAL_MS);
          continue;
        }
        throw new CaptureError(kind, message);
      }
    }
  }

  async function captureOnce(expected: {
    width: number;
    height: number;
    scale: number;
  }): Promise<FrameRef> {
    const since = deps.now() - lastCaptureAt;
    if (since < MIN_CAPTURE_INTERVAL_MS) await deps.sleep(MIN_CAPTURE_INTERVAL_MS - since);

    const dataUrl = await callWithRetries();
    lastCaptureAt = deps.now();
    captures += 1;

    // The one data URL in the project we did not choose: captureVisibleTab offers no
    // other output. It is handed to the decoder once and never re-encoded.
    return {
      kind: 'capture-tab',
      dataUrl,
      width: expected.width,
      height: expected.height,
      scale: expected.scale,
    };
  }

  return {
    request(expected) {
      if (inFlight) {
        coalesced += 1;
        return inFlight;
      }
      inFlight = captureOnce(expected).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    stats: () => ({ captures, coalesced, rateLimitRetries }),
  };
}

/** The real dependencies, for the service worker. */
export function chromeCaptureDeps(): CaptureDeps {
  return {
    capture: () =>
      new Promise<string>((resolve, reject) => {
        chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 92 }, (dataUrl) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message ?? 'captureVisibleTab failed'));
            return;
          }
          if (!dataUrl) {
            reject(new Error('captureVisibleTab returned nothing'));
            return;
          }
          resolve(dataUrl);
        });
      }),
    now: () => Date.now(),
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}
