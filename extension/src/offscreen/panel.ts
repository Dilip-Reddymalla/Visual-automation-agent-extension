/**
 * What the side-by-side panel is shown, and why it is kept here.
 *
 * The panel puts the frame as captured beside the frame that was sent, so a judge can
 * see what the gate removed rather than take our word for it. That means holding, for a
 * few recent steps, a reference to the **pre-gate** frame -- which by definition still
 * has the Aadhaar number in it.
 *
 * Four constraints, and they pick the location on their own:
 *
 *   It must never be persisted.     Storage outlives the session and the gate cannot
 *                                   reach into it. So: memory, and never IndexedDB,
 *                                   which is where the *sealed* bytes legitimately go.
 *   It must never be encoded.       redaction/gate.ts is the only module allowed to turn
 *                                   pixels into bytes, and scripts/test-gate.mjs fails
 *                                   the build otherwise. Nothing here calls an encoder:
 *                                   a FrameRef is already a URL, and an <img> renders it.
 *   It must outlive the worker.     MV3 kills the service worker between steps.
 *   It must be where the frame is.  SEAL_AND_ENCODE runs in the offscreen document and
 *                                   already has both frames in hand.
 *
 * So: a small bounded ring in the offscreen document, dropped when the session ends.
 *
 * The ring is deliberately short. Ten steps is what the panel is asked to walk back
 * through, and every entry pins a decoded frame in memory -- a panel that kept the whole
 * session would cost more than the model does and lose the resource metric to a
 * debugging aid.
 */

import type { Manifest } from '../shared/contract';
import type { FrameRef } from '../shared/frames';

/** How many steps the panel can walk back through. */
export const PANEL_RING_CAPACITY = 10;

export interface PanelStep {
  sessionId: string;
  stepIndex: number;
  at: number;
  /** The frame as captured, before the gate. Never stored, never encoded. */
  preGate: FrameRef;
  /** An object URL for the bytes that were actually POSTed. */
  sentUrl: string;
  sentMime: string;
  manifest: Manifest;
  capture: { width: number; height: number; scale: number };
}

/** Newest last. */
let ring: PanelStep[] = [];

/** Object URLs this module created, so it can revoke exactly its own. */
const owned = new Set<string>();

export interface PanelDeps {
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
}

const browserUrls: PanelDeps = {
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
};

/**
 * Record one step for the panel.
 *
 * A new session clears the ring rather than appending to it: the previous session's
 * frames have no further use, and holding an unredacted frame for no reason is the one
 * thing this module exists not to do.
 */
export function recordStep(
  entry: Omit<PanelStep, 'sentUrl' | 'sentMime' | 'at'> & { sent: Blob },
  deps: PanelDeps = browserUrls,
): void {
  if (ring.length > 0 && ring[0]?.sessionId !== entry.sessionId) clearPanel(deps);

  const sentUrl = deps.createObjectUrl(entry.sent);
  owned.add(sentUrl);

  ring.push({
    sessionId: entry.sessionId,
    stepIndex: entry.stepIndex,
    at: Date.now(),
    preGate: entry.preGate,
    sentUrl,
    sentMime: entry.sent.type,
    manifest: entry.manifest,
    capture: entry.capture,
  });

  while (ring.length > PANEL_RING_CAPACITY) {
    const dropped = ring.shift();
    if (dropped) release(dropped, deps);
  }

  // Hand it to the panel, if one is open. The ring above is only a bridge: this document
  // is closed when the session's host is released, so the panel's own copy is the one
  // that survives long enough to be looked at.
  const latest = ring[ring.length - 1];
  if (latest && notifyPanel) {
    void notifyPanel({
      sessionId: latest.sessionId,
      stepIndex: latest.stepIndex,
      preGate: latest.preGate,
      sentUrl: latest.sentUrl,
      sentMime: latest.sentMime,
      manifest: latest.manifest,
      capture: latest.capture,
    });
  }
}

/** Set by the offscreen entry point. Absent in tests, which assert on the ring itself. */
let notifyPanel: ((step: Omit<PanelStep, 'at'>) => Promise<unknown>) | null = null;

export function setPanelNotifier(fn: typeof notifyPanel): void {
  notifyPanel = fn;
}

function release(step: PanelStep, deps: PanelDeps): void {
  if (owned.delete(step.sentUrl)) deps.revokeObjectUrl(step.sentUrl);
  // The pre-gate ref is the worker's to own -- it was created for the capture and is
  // revoked when that step's frame is released. Revoking it here would pull an image out
  // from under whoever else still holds it.
}

/**
 * Step summaries, newest first. No frames: the selector only needs to list them.
 *
 * Two counts, because they answer different questions and only one of them is a claim.
 * `protected` is what was on the page before the agent touched it; `agentTyped` is what
 * the agent itself put there and the gate then dutifully covered. Both are redacted --
 * a value we typed is in the screenshot exactly like any other -- but reporting the
 * second as protection is reporting our own keystrokes back to the operator as their
 * data. On a form the agent filled from scratch it was the entire count.
 */
export function listSteps(): Array<
  Pick<PanelStep, 'sessionId' | 'stepIndex' | 'at'> & {
    findings: number;
    protected: number;
    agentTyped: number;
  }
> {
  return [...ring].reverse().map((step) => {
    const agentTyped = step.manifest.findings.filter((f) => f.origin === 'agent').length;
    return {
      sessionId: step.sessionId,
      stepIndex: step.stepIndex,
      at: step.at,
      findings: step.manifest.findings.length,
      protected: step.manifest.findings.length - agentTyped,
      agentTyped,
    };
  });
}

export function getStep(stepIndex: number): PanelStep | undefined {
  return ring.find((step) => step.stepIndex === stepIndex);
}

/**
 * Drop everything, revoking what we made.
 *
 * Called when the session ends and when the panel closes. An object URL pins the whole
 * decoded image until it is revoked, so forgetting this is a leak measured in megabytes.
 */
export function clearPanel(deps: PanelDeps = browserUrls): number {
  const count = ring.length;
  for (const step of ring) release(step, deps);
  ring = [];
  return count;
}

/** Tests only. */
export function panelSize(): number {
  return ring.length;
}
