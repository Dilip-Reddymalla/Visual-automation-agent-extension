/**
 * Set-of-Mark, and the order that makes it worth anything.
 *
 * The bug this replaces: marks arrived on the outbound image only when somebody had
 * ticked "Show redaction overlay" in the panel, so the planner's input changed with a
 * debug checkbox. We were getting Set-of-Mark by accident and losing it at random.
 */

import { describe, it, expect } from 'vitest';
import { drawMarks, markable, MARK_FONT_PX, type MarkContext, type Markable } from './marks';

interface Call {
  op: 'fillRect' | 'strokeRect' | 'fillText';
  args: number[];
  text?: string;
}

/** A context that records rather than paints, so the geometry is checkable in Node. */
function recorder(): MarkContext & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    save: () => undefined,
    restore: () => undefined,
    fillRect: (x, y, w, h) => calls.push({ op: 'fillRect', args: [x, y, w, h] }),
    strokeRect: (x, y, w, h) => calls.push({ op: 'strokeRect', args: [x, y, w, h] }),
    fillText: (text, x, y) => calls.push({ op: 'fillText', args: [x, y], text }),
    // Monospace-ish: one number is what a chip holds, and the width only has to be
    // proportional for the clamping arithmetic to be exercised.
    measureText: (text: string) => ({ width: text.length * 9 }),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textBaseline: '',
  };
}

const FRAME = { scale: 1, width: 1024, height: 768 };

describe('one mark per indexed element', () => {
  it('draws the index the element list uses, not a recomputed one', () => {
    const ctx = recorder();
    const marks: Markable[] = [
      { index: 3, box: { x: 10, y: 20, w: 100, h: 30 } },
      { index: 17, box: { x: 200, y: 40, w: 100, h: 30 } },
    ];

    expect(drawMarks(ctx, marks, FRAME)).toBe(2);
    expect(ctx.calls.filter((c) => c.op === 'fillText').map((c) => c.text)).toEqual([
      '3',
      '17',
    ]);
  });

  const CHIP_H = MARK_FONT_PX + 3 * 2;

  /**
   * Above the box, not in it. A chip inside covered the first character or two of the
   * label -- a nav item reading "Dashboard" reached the planner as "1ashboard".
   */
  it('puts the chip just above the element, left-aligned with it', () => {
    const ctx = recorder();
    drawMarks(ctx, [{ index: 1, box: { x: 10, y: 40, w: 100, h: 30 } }], {
      ...FRAME,
      scale: 2,
    });

    // CSS px times the scale: (10, 40) on a 2x buffer is (20, 80), and the chip sits its
    // own height above that.
    expect(ctx.calls[0]?.args.slice(0, 2)).toEqual([20, 80 - CHIP_H]);
  });

  it('drops the chip back inside when there is no room above', () => {
    const ctx = recorder();
    drawMarks(ctx, [{ index: 1, box: { x: 10, y: 4, w: 100, h: 30 } }], FRAME);

    // A chip drawn off the top of the frame is not drawn at all, so covering a letter is
    // the better of the two failures.
    expect(ctx.calls[0]?.args.slice(0, 2)).toEqual([10, 4]);
  });

  it('uses the space above as soon as there is exactly enough', () => {
    const ctx = recorder();
    drawMarks(ctx, [{ index: 1, box: { x: 0, y: CHIP_H, w: 100, h: 30 } }], FRAME);
    expect(ctx.calls[0]?.args[1]).toBe(0);
  });

  it('outlines every chip, because a yellow chip on a yellow page is nothing', () => {
    const ctx = recorder();
    drawMarks(ctx, [{ index: 1, box: { x: 0, y: 0, w: 10, h: 10 } }], FRAME);
    expect(ctx.calls.map((c) => c.op)).toEqual(['fillRect', 'strokeRect', 'fillText']);
  });

  it('draws nothing for an empty list rather than touching the context', () => {
    const ctx = recorder();
    expect(drawMarks(ctx, [], FRAME)).toBe(0);
    expect(ctx.calls).toEqual([]);
  });
});

describe('staying inside the frame', () => {
  /**
   * Clamped rather than dropped. An element scrolled half off the edge is still one the
   * planner may be told to act on, and a mark pushed to the edge is readable where an
   * absent one is silence.
   */
  it('pulls a chip back from the right edge', () => {
    const ctx = recorder();
    drawMarks(ctx, [{ index: 42, box: { x: 1020, y: 10, w: 50, h: 20 } }], FRAME);

    const [x] = ctx.calls[0]?.args ?? [];
    const chipWidth = 2 * 9 + 5 * 2;
    expect(x).toBe(FRAME.width - chipWidth);
  });

  it('pulls a chip back from the bottom edge', () => {
    const ctx = recorder();
    drawMarks(ctx, [{ index: 1, box: { x: 10, y: 900, w: 50, h: 20 } }], FRAME);

    const y = ctx.calls[0]?.args[1];
    expect(y).toBe(FRAME.height - (MARK_FONT_PX + 3 * 2));
  });

  it('never places a chip at a negative coordinate', () => {
    const ctx = recorder();
    drawMarks(ctx, [{ index: 1, box: { x: -80, y: -40, w: 50, h: 20 } }], FRAME);
    expect(ctx.calls[0]?.args.slice(0, 2)).toEqual([0, 0]);
  });
});

describe('what gets marked', () => {
  const viewport = { w: 1280, h: 800 };

  it('marks an indexed element', () => {
    expect(markable([{ index: 4, box: { x: 1, y: 1, w: 10, h: 10 } }], viewport)).toEqual([
      { index: 4, box: { x: 1, y: 1, w: 10, h: 10 } },
    ]);
  });

  /**
   * A visual-only element is reachable by coordinate and has no integer for the planner
   * to name it by, so a chip on one would be a number that refers to nothing.
   */
  it('does not mark an element with no index', () => {
    expect(markable([{ box: { x: 1, y: 1, w: 10, h: 10 } }], viewport)).toEqual([]);
  });

  it('does not mark a zero-area element', () => {
    expect(markable([{ index: 1, box: { x: 1, y: 1, w: 0, h: 10 } }], viewport)).toEqual([]);
  });

  it('does not mark an element past the viewport', () => {
    expect(markable([{ index: 1, box: { x: 5000, y: 1, w: 10, h: 10 } }], viewport)).toEqual(
      [],
    );
  });
});
