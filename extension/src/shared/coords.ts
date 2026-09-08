/**
 * One coordinate space (CLAUDE.md invariant 2).
 *
 * Every Box in this project is CSS pixels of the *visual* viewport, origin at the
 * top-left of that viewport. Not device pixels. Not layout-viewport pixels. Not page
 * coordinates. A box that has been scrolled off the top has a negative `y`.
 *
 * Exactly one number converts between that space and image space: `scale`, defined as
 * image pixels per CSS pixel. It is captured once per screenshot and travels with it.
 * Nothing else in the tree is allowed to multiply a coordinate by devicePixelRatio.
 *
 * ── The contract, in full (M4) ────────────────────────────────────────────────
 *
 * Three coordinate systems exist in a browser and only one of them is ours:
 *
 *   Page          what the document is laid out in. Unbounded, scrolls.
 *   Layout        what getBoundingClientRect returns. Page minus scroll offset.
 *   Visual        what the user can actually see, and what captureVisibleTab
 *                 photographs. Equals layout unless the user has pinch-zoomed, in
 *                 which case it is a moving window inside layout.
 *
 * Ours is Visual, in CSS px. `viewportBox()` is the one conversion into it, and
 * `captureScale()` the one conversion out to image pixels. Two adjustments live in
 * those functions and nowhere else:
 *
 *   Pinch-zoom offset   visualViewport.offsetLeft/offsetTop. Zero almost always, and
 *                       non-zero exactly when a tester pinches on a laptop trackpad
 *                       and every box on the page silently shifts.
 *
 *   Device scale        devicePixelRatio x visualViewport.scale. captureVisibleTab
 *                       returns a frame at this multiple of CSS px. Mixing it with a
 *                       CSS-px rect is the bug this module exists to prevent: on a 2x
 *                       display every redaction box lands at half its intended
 *                       position, which looks plausible in a screenshot and forfeits
 *                       the 20% redaction metric.
 *
 * Then the frame is downscaled to a fixed long edge, so the scale that actually
 * travels with a capture is `downscaledWidth / viewportWidthInCssPx` -- not the raw
 * device ratio. `captureScale()` computes it; nothing else may.
 */

export interface Box {
  /** CSS px from the left edge of the visual viewport. */
  x: number;
  /** CSS px from the top edge of the visual viewport. */
  y: number;
  /** Width in CSS px. Never negative. */
  w: number;
  /** Height in CSS px. Never negative. */
  h: number;
}

/** Visual viewport size in CSS px. */
export interface Viewport {
  w: number;
  h: number;
}

/** Image pixels per CSS pixel. Usually devicePixelRatio, but read from the capture. */
export type Scale = number;

/** A box in image space. Structurally identical; the brand keeps the two apart. */
export interface ImageBox extends Box {
  readonly __imageSpace?: never;
}

function assertFiniteBox(b: Box, who: string): void {
  if (
    !Number.isFinite(b.x) ||
    !Number.isFinite(b.y) ||
    !Number.isFinite(b.w) ||
    !Number.isFinite(b.h)
  ) {
    throw new RangeError(`${who}: box has a non-finite component`);
  }
}

function assertScale(scale: Scale): void {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError(`scale must be a positive finite number, got ${String(scale)}`);
  }
}

/** Area in the box's own units. Zero for a degenerate box. */
export function area(b: Box): number {
  return Math.max(0, b.w) * Math.max(0, b.h);
}

/** True when the box encloses no pixels. */
export function isEmpty(b: Box): boolean {
  return b.w <= 0 || b.h <= 0;
}

/**
 * CSS px -> image px. `scale` is image pixels per CSS pixel.
 * No rounding: rounding is the caller's decision and belongs next to the canvas op.
 */
export function toImageSpace(box: Box, scale: Scale): ImageBox {
  assertFiniteBox(box, 'toImageSpace');
  assertScale(scale);
  return { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale };
}

/** image px -> CSS px. Exact inverse of `toImageSpace` for the same scale. */
export function fromImageSpace(box: ImageBox, scale: Scale): Box {
  assertFiniteBox(box, 'fromImageSpace');
  assertScale(scale);
  return { x: box.x / scale, y: box.y / scale, w: box.w / scale, h: box.h / scale };
}

/** Overlapping region, or an empty box at the origin of the overlap when there is none. */
export function intersection(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

/** Intersection over union. 0 when either box is degenerate or they do not overlap. */
export function iou(a: Box, b: Box): number {
  assertFiniteBox(a, 'iou');
  assertFiniteBox(b, 'iou');
  const inter = area(intersection(a, b));
  if (inter === 0) return 0;
  const denom = area(a) + area(b) - inter;
  return denom <= 0 ? 0 : inter / denom;
}

/** Smallest box containing both. A degenerate operand is ignored rather than swallowing. */
/**
 * How much of `inner` lies inside `outer`, 0 to 1.
 *
 * Not IoU: a link inside a card overlaps the card completely while sharing little of
 * its area, and IoU would score that near zero. This is the number the containment
 * collapse needs -- "is this element merely a part of that one".
 */
export function containment(inner: Box, outer: Box): number {
  const a = area(inner);
  if (a === 0) return 0;
  return area(intersection(inner, outer)) / a;
}

/**
 * A layout-viewport rect (what getBoundingClientRect gives) in visual-viewport space.
 *
 * The subtraction is a no-op until someone pinch-zooms, at which point it is the
 * difference between a redaction box on the Aadhaar number and one beside it.
 */
export function viewportBox(rect: Box, offsetX: number, offsetY: number): Box {
  return { x: rect.x - offsetX, y: rect.y - offsetY, w: rect.w, h: rect.h };
}

/**
 * Image pixels per CSS pixel for a frame that has been downscaled.
 *
 * Derived from the frame itself rather than from devicePixelRatio, because after the
 * downscale the device ratio is no longer the truth: a 2x display captured at 2560 px
 * and downscaled to 1024 has a scale of 0.8, not 2.
 */
export function captureScale(imageWidth: number, viewportWidthCss: number): Scale {
  if (!Number.isFinite(imageWidth) || imageWidth <= 0) {
    throw new RangeError(`captureScale: bad image width ${String(imageWidth)}`);
  }
  if (!Number.isFinite(viewportWidthCss) || viewportWidthCss <= 0) {
    throw new RangeError(`captureScale: bad viewport width ${String(viewportWidthCss)}`);
  }
  return imageWidth / viewportWidthCss;
}

/**
 * What captureVisibleTab will hand back, in image px per CSS px, before any downscale.
 * devicePixelRatio alone is wrong on a pinch-zoomed page.
 */
export function deviceScale(devicePixelRatio: number, visualViewportScale = 1): Scale {
  assertScale(devicePixelRatio);
  assertScale(visualViewportScale);
  return devicePixelRatio * visualViewportScale;
}

/** Longest edge of a frame at `scale`, for planning the downscale. */
export function longEdge(viewport: Viewport, scale: Scale): number {
  assertScale(scale);
  return Math.round(Math.max(viewport.w, viewport.h) * scale);
}

/**
 * Exact area covered by a set of boxes, counting overlaps once.
 *
 * Summing areas double-counts every overlap, which would make the redaction metrics
 * lie in the flattering direction -- an over-redaction rate computed from a
 * double-counted denominator looks smaller than it is. Coordinate compression is exact
 * and, at the tens of boxes a page produces, cheaper than being clever.
 */
/**
 * Grow a box by a fixed number of pixels on every side.
 *
 * Absolute, unlike `expand`, which takes a fraction. Both exist because they answer
 * different questions: a proportional grow is right when the thing being corrected
 * scales with the box, and a fixed one is right when it does not. Glyph bleed does not
 * -- a wider field does not have wider anti-aliasing -- so redaction padding uses this.
 */
export function padBox(box: Box, px: number): Box {
  assertFiniteBox(box, 'padBox');
  if (!Number.isFinite(px)) throw new RangeError('padBox: px must be finite');
  return {
    x: box.x - px,
    y: box.y - px,
    w: Math.max(0, box.w + px * 2),
    h: Math.max(0, box.h + px * 2),
  };
}

export function unionArea(boxes: readonly Box[]): number {
  const real = boxes.filter((b) => b.w > 0 && b.h > 0);
  if (real.length === 0) return 0;

  const xs = [...new Set(real.flatMap((b) => [b.x, b.x + b.w]))].sort((p, q) => p - q);
  const ys = [...new Set(real.flatMap((b) => [b.y, b.y + b.h]))].sort((p, q) => p - q);

  let total = 0;
  for (let i = 0; i < xs.length - 1; i += 1) {
    const x0 = xs[i] ?? 0;
    const x1 = xs[i + 1] ?? 0;
    for (let j = 0; j < ys.length - 1; j += 1) {
      const y0 = ys[j] ?? 0;
      const y1 = ys[j + 1] ?? 0;
      const covered = real.some(
        (b) => b.x <= x0 && b.x + b.w >= x1 && b.y <= y0 && b.y + b.h >= y1,
      );
      if (covered) total += (x1 - x0) * (y1 - y0);
    }
  }
  return total;
}

/** Area covered by `boxes` that no box in `mask` also covers. */
export function areaOutside(boxes: readonly Box[], mask: readonly Box[]): number {
  const both = unionArea([...boxes, ...mask]);
  return Math.max(0, unionArea(boxes) - (unionArea(boxes) + unionArea(mask) - both));
}

export function union(a: Box, b: Box): Box {
  assertFiniteBox(a, 'union');
  assertFiniteBox(b, 'union');
  if (isEmpty(a)) return { ...b };
  if (isEmpty(b)) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * Grow (or shrink, for negative `pct`) a box about its own centre.
 * `pct` is a fraction of the box's own size: 0.1 makes it 10% wider and 10% taller.
 * Shrinking past nothing clamps to a zero-size box at the centre — it never inverts.
 */
export function expand(box: Box, pct: number): Box {
  assertFiniteBox(box, 'expand');
  if (!Number.isFinite(pct)) throw new RangeError('expand: pct must be finite');
  const dw = box.w * pct;
  const dh = box.h * pct;
  const w = Math.max(0, box.w + dw);
  const h = Math.max(0, box.h + dh);
  return {
    x: box.x + (box.w - w) / 2,
    y: box.y + (box.h - h) / 2,
    w,
    h,
  };
}

/**
 * Clip a box to the visible viewport. Anything outside is cut away, not translated —
 * a redaction box must stay over the pixels it was measured against.
 * A box entirely offscreen comes back empty; callers drop empties.
 */
export function clampToViewport(box: Box, vp: Viewport): Box {
  assertFiniteBox(box, 'clampToViewport');
  if (!Number.isFinite(vp.w) || !Number.isFinite(vp.h)) {
    throw new RangeError('clampToViewport: viewport has a non-finite component');
  }
  return intersection(box, { x: 0, y: 0, w: Math.max(0, vp.w), h: Math.max(0, vp.h) });
}
