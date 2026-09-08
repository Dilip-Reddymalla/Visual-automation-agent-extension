/**
 * Decode a captured frame and immediately shrink it.
 *
 * This runs in the offscreen document, not the worker, for the same reason inference
 * does: it needs a real graphics context. It is also the only place a full-resolution
 * frame exists, and it exists for one tick.
 *
 * The full-resolution bitmap is closed in the same synchronous stretch that draws it.
 * On a 2x 1440p display captureVisibleTab hands back a 5120x2880 image -- about 59 MB
 * of decoded RGBA, per step, held for as long as anyone keeps a reference. Client
 * resource utilisation is 20% of the evaluation and this single `close()` is a large
 * fraction of it.
 *
 * `transferToImageBitmap` is a transfer, not an encode: no toBlob, no toDataURL, no
 * convertToBlob. Encoding happens once, in the gate, after redaction (invariant 1).
 *
 * Every browser primitive is injected, so the arithmetic and the lifetime are testable
 * in Node -- where none of these types exist.
 */

import { captureScale, type Scale, type Viewport } from '../shared/coords';
import { frameUrl, type FrameRef } from '../shared/frames';

/** Long edge of the buffer everything downstream works on. */
export const LONG_EDGE = 1024;

export interface BitmapLike {
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface CanvasLike {
  getContext(type: '2d'): { drawImage(image: BitmapLike, ...args: number[]): void } | null;
  transferToImageBitmap(): BitmapLike;
}

export interface DecodeDeps {
  fetchBytes(url: string): Promise<Blob>;
  createBitmap(blob: Blob): Promise<BitmapLike>;
  createCanvas(width: number, height: number): CanvasLike;
}

export interface DecodedFrame {
  bitmap: BitmapLike;
  /** Image px per CSS px *of this buffer*, which is what every box conversion uses. */
  scale: Scale;
  width: number;
  height: number;
  /** What the full-resolution frame was, for the record. It no longer exists. */
  sourceWidth: number;
  sourceHeight: number;
}

/** Target size with the aspect ratio preserved and the long edge capped. */
export function downscaledSize(
  width: number,
  height: number,
  longEdge = LONG_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= longEdge) return { width, height };
  const factor = longEdge / longest;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

export async function decodeFrame(
  frame: FrameRef,
  viewport: Viewport,
  deps: DecodeDeps,
): Promise<DecodedFrame> {
  const blob = await deps.fetchBytes(frameUrl(frame));
  const full = await deps.createBitmap(blob);

  const sourceWidth = full.width;
  const sourceHeight = full.height;
  const target = downscaledSize(sourceWidth, sourceHeight);

  try {
    const canvas = deps.createCanvas(target.width, target.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('frames: no 2d context on the offscreen canvas');
    ctx.drawImage(full, 0, 0, sourceWidth, sourceHeight, 0, 0, target.width, target.height);
    const bitmap = canvas.transferToImageBitmap();

    return {
      bitmap,
      // From the buffer, not from devicePixelRatio: after the downscale the device
      // ratio is no longer the relationship between a box and a pixel.
      scale: captureScale(bitmap.width, viewport.w),
      width: bitmap.width,
      height: bitmap.height,
      sourceWidth,
      sourceHeight,
    };
  } finally {
    // Same tick as the draw, on every path including the failing one.
    full.close();
  }
}

/** The real dependencies, for a document that has a graphics context. */
export function browserDecodeDeps(): DecodeDeps {
  return {
    async fetchBytes(url: string): Promise<Blob> {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`frames: could not read the frame (${response.status})`);
      return response.blob();
    },
    createBitmap: (blob) => createImageBitmap(blob) as unknown as Promise<BitmapLike>,
    createCanvas: (width, height) =>
      new OffscreenCanvas(width, height) as unknown as CanvasLike,
  };
}
