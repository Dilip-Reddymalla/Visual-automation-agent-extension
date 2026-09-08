/**
 * Set-of-Mark: the element indices, drawn onto the image that is sent.
 *
 * ## Why this is in the gate and not in the overlay
 *
 * `content/overlay.ts` also draws numbered badges, and it is unrelated to this file. That
 * one is for a human, on the live page, behind a toggle in the panel. This one is for the
 * planner, on the outbound frame, always.
 *
 * They were the same thing by accident, and that was the bug. The capture pipeline knew
 * nothing about the overlay, so whether the planner received a numbered screenshot or a
 * bare one depended on whether somebody had ticked a debug checkbox. We were getting
 * Set-of-Mark by accident and losing it at random, and a model's input was changing based
 * on a UI setting nobody thought of as part of the pipeline.
 *
 * ## Why marks at all
 *
 * Set-of-Mark is what lets a small planner be reliable: instead of predicting pixel
 * coordinates from an image, it reads a number off the image and looks that number up in
 * the element list, where the label and the filled state already are. The two halves of
 * the payload then agree by construction, because the number drawn is the same integer
 * the list carries -- not a recomputed one.
 *
 * It is worth more here than in most agents, because half our fields are covered by black
 * bars. The planner cannot read what is under a mask. It can read the mark on top of one,
 * and that is what keeps a redacted field usable rather than merely hidden.
 *
 * ## Order
 *
 * Drawn after every redaction operation and before the receipt is issued. A mark painted
 * before the masks would be masked away, on precisely the fields that need it most.
 *
 * Node-pure apart from the 2D context it is handed.
 */

import type { Box, Viewport } from '../shared/coords';

/** One element to mark: the index the planner will use, and where it is in CSS px. */
export interface Markable {
  index: number;
  box: Box;
}

/**
 * Chip geometry, in image pixels of the frame as it will be sent.
 *
 * These are the sizes the planner actually sees, and that is not the same as the CSS box.
 * `offscreen/frames.ts` downscales the capture to LONG_EDGE (1024) *before* seal runs, so
 * the canvas being drawn on here is already the encoded buffer -- 15 px of chip is 15 px
 * in the POSTed image, whatever the display's device pixel ratio was. Size these against
 * a CSS box instead and a two-digit number on a 2x screen arrives at 7 px, which is not a
 * number, it is a smudge.
 */
export const MARK_FONT_PX = 15;
export const MARK_PAD_X = 5;
export const MARK_PAD_Y = 3;

/** Ink and paper. High contrast both ways, because a mark lands on anything. */
const FILL = '#ffd400';
const TEXT = '#101010';
const OUTLINE = '#101010';

/** The 2D surface this needs, and nothing more. Keeps the module testable in Node. */
export interface MarkContext {
  save(): void;
  restore(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textBaseline: string;
}

export interface MarkOptions {
  /** Image pixels per CSS pixel, so a box in CSS px lands where it is on the canvas. */
  scale: number;
  /** The frame, in image pixels. Marks are clamped inside it. */
  width: number;
  height: number;
}

/**
 * Where one chip goes: just outside the element's top-left corner, clamped into the frame.
 *
 * Outside rather than inside, which is the change M15 got wrong. A chip drawn *in* the box
 * covers the first character or two of whatever is there -- a nav item labelled "Dashboard"
 * arrived at the planner reading "1ashboard". The planner has the label in the element list
 * either way, so nothing was lost that mattered, but the picture is also read by a human
 * during a demo and a mark should annotate the page rather than eat it.
 *
 * Above the box, left-aligned with it: the standard Set-of-Mark convention, and the one
 * that stays legible when boxes stack vertically down a form.
 *
 * Clamped rather than dropped, in both directions and for different reasons. Horizontally,
 * an element scrolled half off the left edge is still one the planner may be told to act
 * on, and a mark pushed to the edge is readable where an absent one is silence. Vertically,
 * an element at the very top of the frame has no room above it, so the chip goes back
 * inside -- covering a letter is worse than the old behaviour, but a chip drawn off the top
 * of the frame is not drawn at all.
 */
function place(
  box: Box,
  chipW: number,
  chipH: number,
  options: MarkOptions,
): { x: number; y: number } {
  const x = box.x * options.scale;
  const top = box.y * options.scale;
  // Above the box when there is room; back inside its top-left when there is not.
  const y = top - chipH >= 0 ? top - chipH : top;

  return {
    x: Math.max(0, Math.min(x, options.width - chipW)),
    y: Math.max(0, Math.min(y, options.height - chipH)),
  };
}

/**
 * Draw one chip per element. Returns how many were drawn.
 *
 * The count goes into the manifest so the payload is self-describing: a judge asking how
 * the planner knows which box is which gets "12 elements marked" rather than an
 * explanation.
 */
export function drawMarks(
  ctx: MarkContext,
  elements: readonly Markable[],
  options: MarkOptions,
): number {
  if (elements.length === 0) return 0;

  ctx.save();
  ctx.font = `600 ${MARK_FONT_PX}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.lineWidth = 1;

  let drawn = 0;
  for (const element of elements) {
    const label = String(element.index);
    const chipW = ctx.measureText(label).width + MARK_PAD_X * 2;
    const chipH = MARK_FONT_PX + MARK_PAD_Y * 2;
    const { x, y } = place(element.box, chipW, chipH, options);

    ctx.fillStyle = FILL;
    ctx.fillRect(x, y, chipW, chipH);
    // An outline, because a yellow chip on a yellow page is one rectangle of nothing.
    ctx.strokeStyle = OUTLINE;
    ctx.strokeRect(x, y, chipW, chipH);
    ctx.fillStyle = TEXT;
    ctx.fillText(label, x + MARK_PAD_X, y + MARK_PAD_Y);
    drawn += 1;
  }

  ctx.restore();
  return drawn;
}

/** Elements worth marking: the indexed ones, which are the ones a plan can refer to. */
export function markable(
  elements: ReadonlyArray<{ index?: number; box: Box }>,
  viewport: Viewport,
): Markable[] {
  return elements
    .filter(
      (el): el is { index: number; box: Box } =>
        // No index, no mark. A visual-only element is reachable by coordinate and there
        // is no integer for the planner to name it by, so a chip on one would be a
        // number that means nothing.
        typeof el.index === 'number' &&
        el.box.w > 0 &&
        el.box.h > 0 &&
        el.box.x < viewport.w &&
        el.box.y < viewport.h,
    )
    .map((el) => ({ index: el.index, box: el.box }));
}
