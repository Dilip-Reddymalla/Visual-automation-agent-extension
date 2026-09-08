/**
 * How pixels move between contexts.
 *
 * The rule (M1 constraints): an ImageBitmap is never serialised. Not to base64, not to
 * a pixel array. A base64 round-trip of a 1024 px frame costs ~40 ms and a megabyte of
 * heap to produce something the receiver has to decode again.
 *
 * The bus is JSON -- `chrome.runtime.sendMessage` serialises, it does not structured-
 * clone, so an ImageBitmap physically cannot travel on it. So frames do not travel on
 * it. A `FrameRef` is a *handle*: the pixels stay where they were decoded, and the
 * handle names them.
 *
 *   blob-url      the normal case. Whichever context holds the pixels calls
 *                 URL.createObjectURL and passes the string. Any extension context can
 *                 fetch it -- same origin -- and the bytes are never copied through a
 *                 message. Revoke it when the step ends.
 *   capture-tab   the one exception, and it is not ours: chrome.tabs.captureVisibleTab
 *                 hands back a data URL and offers no alternative. It is passed through
 *                 exactly once, to the context that will decode it, and never
 *                 re-encoded. Never construct one of these yourself.
 *
 * Service workers have no URL.createObjectURL, which is another reason the worker is
 * not where pixels live (CLAUDE.md invariant 8).
 */

import type { Viewport } from './coords';

/** Image pixels, not CSS pixels. The `scale` says how the two relate. */
export interface FrameSize {
  width: number;
  height: number;
  /** Image pixels per CSS pixel (CLAUDE.md invariant 2). */
  scale: number;
}

/**
 * Everything about the page's position that could invalidate a set of boxes.
 *
 * Perceive and capture are two messages with a gap between them, and in that gap the
 * page can scroll, reflow, or be scrolled by the user -- after which every box measured
 * by the first message is wrong relative to the frame taken by the second. Nothing
 * about a static demo page will ever show this, and on a real site with a sticky header
 * and lazy images it happens constantly.
 *
 * So the geometry carries a token, the worker re-reads it after the capture, and a
 * frame whose page moved underneath it is thrown away rather than redacted at the wrong
 * coordinates. `framesDiscarded` is a number M11 reports, not a number to hide.
 */
export interface GeometryToken {
  scrollX: number;
  scrollY: number;
  /** visualViewport.offsetLeft/offsetTop -- non-zero only under pinch-zoom. */
  vvOffsetX: number;
  vvOffsetY: number;
  /** visualViewport.scale. 1 unless pinch-zoomed. */
  vvScale: number;
  dpr: number;
  /** Bumped by the settle observer on every batch of mutations. */
  mutationSeq: number;
  /** Catches a reflow that changed nothing else -- lazy images, an expanding accordion. */
  docHeight: number;
}

/**
 * The geometry that travels with a capture. Measured by the content script, which is
 * the only context that can see the visual viewport; the bytes are captured by the
 * worker, which is the only context that can call chrome.tabs.captureVisibleTab.
 */
export interface CaptureGeometry {
  viewport: Viewport;
  /**
   * Image pixels per CSS pixel *before* the downscale -- devicePixelRatio times
   * visualViewport.scale. The scale that travels with the finished frame is smaller;
   * see coords.captureScale.
   */
  scale: number;
  /**
   * Visual-viewport offsets, for turning a layout-viewport rect into a visual one.
   * Zero unless the page is pinch-zoomed.
   */
  offsetX: number;
  offsetY: number;
  token: GeometryToken;
}

/** Did the page hold still between the measurement and the capture? */
export function tokensMatch(a: GeometryToken, b: GeometryToken): boolean {
  return (
    a.scrollX === b.scrollX &&
    a.scrollY === b.scrollY &&
    a.vvOffsetX === b.vvOffsetX &&
    a.vvOffsetY === b.vvOffsetY &&
    a.vvScale === b.vvScale &&
    a.dpr === b.dpr &&
    a.mutationSeq === b.mutationSeq &&
    a.docHeight === b.docHeight
  );
}

/** What moved, for the step log. Empty when nothing did. */
export function tokenDrift(a: GeometryToken, b: GeometryToken): string[] {
  const drift: string[] = [];
  const keys: Array<keyof GeometryToken> = [
    'scrollX',
    'scrollY',
    'vvOffsetX',
    'vvOffsetY',
    'vvScale',
    'dpr',
    'mutationSeq',
    'docHeight',
  ];
  for (const key of keys) {
    if (a[key] !== b[key]) drift.push(`${key} ${a[key]} -> ${b[key]}`);
  }
  return drift;
}

export type FrameRef =
  | ({ kind: 'blob-url'; url: string } & FrameSize)
  | ({ kind: 'capture-tab'; dataUrl: string } & FrameSize);

export function isFrameRef(value: unknown): value is FrameRef {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Partial<FrameRef>;
  if (f.kind === 'blob-url') return typeof (f as { url?: unknown }).url === 'string';
  if (f.kind === 'capture-tab') return typeof (f as { dataUrl?: unknown }).dataUrl === 'string';
  return false;
}

/** The URL a context should fetch to get the bytes, whichever kind it is. */
export function frameUrl(frame: FrameRef): string {
  return frame.kind === 'blob-url' ? frame.url : frame.dataUrl;
}

/**
 * Release a frame. Object URLs leak the whole decoded image until revoked, and a step
 * that keeps every frame it ever saw is the fastest way to lose the 20% resource
 * metric. A no-op for capture-tab refs, which own nothing.
 */
export function revokeFrame(frame: FrameRef, revoke: (url: string) => void): void {
  if (frame.kind === 'blob-url') revoke(frame.url);
}
