/**
 * Geometry, and the token that binds a frame to the boxes measured against it.
 *
 * This module never produces pixels. A content script cannot call
 * `chrome.tabs.captureVisibleTab` -- that API belongs to the worker -- so the division
 * is: the worker takes the picture, and the content script supplies the two things the
 * worker cannot see, which are the visual viewport and whether the page has moved.
 *
 * The coordinate contract it implements is written out at the top of shared/coords.ts.
 * The short version: everything is CSS px of the *visual* viewport, which equals the
 * layout viewport until a user pinch-zooms, and `offsetX/offsetY` is the difference.
 * The only multiplication by devicePixelRatio in this project happens in coords.ts.
 *
 * Browser access is injected, the way PerceiveEnv does it, so this runs under jsdom --
 * which has no visualViewport at all.
 */

import { deviceScale } from '../shared/coords';
import type { CaptureGeometry, GeometryToken } from '../shared/frames';

/** What the measurement needs from the window. Injected so it can be faked. */
export interface CaptureEnv {
  innerWidth: number;
  innerHeight: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
  /** Absent in older browsers and in jsdom; the layout viewport is then the truth. */
  visualViewport?: {
    width: number;
    height: number;
    offsetLeft: number;
    offsetTop: number;
    scale: number;
  };
  documentHeight: number;
  /** The settle observer's counter. See settle.ts. */
  mutationSeq: number;
}

export function measure(env: CaptureEnv): CaptureGeometry {
  const vv = env.visualViewport;
  const viewport = {
    w: vv?.width ?? env.innerWidth,
    h: vv?.height ?? env.innerHeight,
  };
  const vvScale = vv?.scale ?? 1;

  return {
    viewport,
    scale: deviceScale(env.devicePixelRatio, vvScale),
    offsetX: vv?.offsetLeft ?? 0,
    offsetY: vv?.offsetTop ?? 0,
    token: {
      scrollX: env.scrollX,
      scrollY: env.scrollY,
      vvOffsetX: vv?.offsetLeft ?? 0,
      vvOffsetY: vv?.offsetTop ?? 0,
      vvScale,
      dpr: env.devicePixelRatio,
      mutationSeq: env.mutationSeq,
      docHeight: env.documentHeight,
    },
  };
}

export function currentToken(env: CaptureEnv): GeometryToken {
  return measure(env).token;
}

/** The real environment, read from the live window. */
export function windowEnv(win: Window, doc: Document, mutationSeq: number): CaptureEnv {
  const vv = win.visualViewport;
  return {
    innerWidth: win.innerWidth,
    innerHeight: win.innerHeight,
    scrollX: win.scrollX,
    scrollY: win.scrollY,
    devicePixelRatio: win.devicePixelRatio,
    visualViewport: vv
      ? {
          width: vv.width,
          height: vv.height,
          offsetLeft: vv.offsetLeft,
          offsetTop: vv.offsetTop,
          scale: vv.scale,
        }
      : undefined,
    // scrollHeight, not clientHeight: this is here to catch a reflow that changed
    // nothing else -- a lazy image landing, an accordion opening below the fold.
    documentHeight: doc.documentElement.scrollHeight,
    mutationSeq,
  };
}
