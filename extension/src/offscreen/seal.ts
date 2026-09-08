/**
 * The offscreen document's half of a step: decode, seal, encode, hand the bytes over.
 *
 * Nothing here is new gate logic. redaction/gate.ts is finished and this file calls it:
 * decode the captured frame, run seal(), run encode(), and put the resulting Blob where
 * the worker can take it. The only decisions are about plumbing.
 *
 * Why the bytes go to IndexedDB rather than back in the reply is in
 * platform/frame-store.ts. Why the POST is not simply done from here is invariant 1:
 * worker/receipt.ts checks the bytes in a different process from the one that produced
 * them, and a check that runs inside the thing it is checking is not a check.
 */

import { encode, seal, type GateCanvas } from '../redaction/gate';
import { decodeFrame, browserDecodeDeps, type DecodeDeps } from './frames';
import { frameKey, type FrameStore, type StoredFrame } from '../platform/frame-store';
import { recordStep } from './panel';
import type { Finding, Viewport } from '../shared/contract';
import type { FrameRef } from '../shared/frames';
import type { Markable } from '../redaction/marks';

export interface SealRequest {
  sessionId: string;
  stepIndex: number;
  frame: FrameRef;
  findings: Finding[];
  viewport: Viewport;
  scale: number;
  /** Element indices to draw on the sealed frame. See redaction/marks.ts. */
  marks?: Markable[];
  /** finding id -> placeholder, allocated once during the detect phase. */
  placeholders: Record<string, string>;
  /** finding id -> box kind, which decides its padding. */
  boxKinds: Record<string, 'element' | 'text'>;
}

export interface SealDeps {
  store: FrameStore;
  decode?: DecodeDeps;
  createCanvas?: (width: number, height: number) => GateCanvas;
  now?: () => number;
}

export interface SealOutcome {
  handoffKey: string;
  manifest: import('../shared/contract').Manifest;
  capture: { mime: string; width: number; height: number; scale: number; sha256: string };
  placeholders: Record<string, string>;
}

function browserCanvas(width: number, height: number): GateCanvas {
  return new OffscreenCanvas(width, height) as unknown as GateCanvas;
}

/**
 * The whole offscreen half, in order.
 *
 * No allocation happens here. The detect phase already asked this document for tokens
 * (PLACEHOLDER_ALLOCATE) and passes them back; allocating a second time in one step
 * would hand out «PERSON_1» and «PERSON_2» for the same person, and stable numbering is
 * the one thing the planner is told it can rely on.
 */
export async function sealAndEncode(
  request: SealRequest,
  deps: SealDeps,
): Promise<SealOutcome> {
  const decoded = await decodeFrame(
    request.frame,
    request.viewport,
    deps.decode ?? browserDecodeDeps(),
  );

  const placeholders = request.placeholders;

  const sealed = await seal(decoded.bitmap, request.findings, {
    viewport: request.viewport,
    // The decoded buffer's scale, not the capture's: the frame was downscaled on the
    // way in, and using the pre-downscale number here is the M4 bug one layer up.
    scale: decoded.scale,
    createCanvas: deps.createCanvas ?? browserCanvas,
    placeholders: new Map(Object.entries(placeholders)),
    boxKinds: request.boxKinds,
    marks: request.marks,
    now: deps.now,
  });

  const encoded = await encode(sealed);
  const blob = new Blob([new Uint8Array(encoded.bytes)], { type: encoded.mime });

  const key = frameKey(request.sessionId, request.stepIndex);
  const stored: StoredFrame = {
    bytes: blob,
    sha256: encoded.sha256,
    mime: encoded.mime,
    width: encoded.width,
    height: encoded.height,
    storedAt: (deps.now ?? Date.now)(),
  };
  await deps.store.put(key, stored);

  // Anything left behind by a step that died between sealing and sending. A redacted
  // frame is still a picture of the user's screen.
  await deps.store.sweep(stored.storedAt - 60_000);

  // Both frames, for the operator panel. Memory only, and only here -- see panel.ts for
  // why the pre-gate frame cannot live anywhere else.
  recordStep({
    sessionId: request.sessionId,
    stepIndex: request.stepIndex,
    preGate: request.frame,
    sent: blob,
    manifest: sealed.manifest,
    capture: { width: encoded.width, height: encoded.height, scale: decoded.scale },
  });

  return {
    handoffKey: key,
    manifest: sealed.manifest,
    capture: {
      mime: encoded.mime,
      width: encoded.width,
      height: encoded.height,
      scale: decoded.scale,
      sha256: encoded.sha256,
    },
    placeholders,
  };
}
