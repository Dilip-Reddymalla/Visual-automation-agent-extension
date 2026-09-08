import { describe, it, expect } from 'vitest';
import {
  area,
  clampToViewport,
  expand,
  fromImageSpace,
  intersection,
  iou,
  isEmpty,
  toImageSpace,
  union,
  type Box,
} from './coords';

const b = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });

describe('area / isEmpty', () => {
  it('multiplies', () => expect(area(b(0, 0, 3, 4))).toBe(12));
  it('is zero for a degenerate box', () => expect(area(b(5, 5, 0, 9))).toBe(0));
  it('never goes negative', () => expect(area(b(0, 0, -3, 4))).toBe(0));
  it('flags degenerate boxes', () => {
    expect(isEmpty(b(0, 0, 0, 10))).toBe(true);
    expect(isEmpty(b(0, 0, 1, 1))).toBe(false);
  });
});

describe('toImageSpace / fromImageSpace', () => {
  it('scales all four components', () => {
    expect(toImageSpace(b(10, 20, 30, 40), 2)).toEqual(b(20, 40, 60, 80));
  });

  it('round-trips exactly for a dyadic scale', () => {
    const box = b(10.5, 20.25, 30, 40);
    expect(fromImageSpace(toImageSpace(box, 2), 2)).toEqual(box);
  });

  it('round-trips within float tolerance for a fractional scale', () => {
    const box = b(13.7, 91.3, 44.9, 12.1);
    const back = fromImageSpace(toImageSpace(box, 1.25), 1.25);
    for (const k of ['x', 'y', 'w', 'h'] as const) {
      expect(back[k]).toBeCloseTo(box[k], 10);
    }
  });

  it('does not round — a half pixel survives the trip', () => {
    expect(toImageSpace(b(0.5, 0.5, 1, 1), 3).x).toBeCloseTo(1.5, 12);
  });

  it('rejects a non-positive or non-finite scale', () => {
    expect(() => toImageSpace(b(0, 0, 1, 1), 0)).toThrow(RangeError);
    expect(() => toImageSpace(b(0, 0, 1, 1), -2)).toThrow(RangeError);
    expect(() => fromImageSpace(b(0, 0, 1, 1), Number.NaN)).toThrow(RangeError);
  });

  it('rejects a non-finite box', () => {
    expect(() => toImageSpace(b(Number.NaN, 0, 1, 1), 2)).toThrow(RangeError);
  });
});

describe('intersection', () => {
  it('finds the overlap', () => {
    expect(intersection(b(0, 0, 10, 10), b(5, 5, 10, 10))).toEqual(b(5, 5, 5, 5));
  });
  it('returns an empty box when they miss', () => {
    expect(isEmpty(intersection(b(0, 0, 4, 4), b(9, 9, 2, 2)))).toBe(true);
  });
  it('treats edge contact as no overlap', () => {
    expect(area(intersection(b(0, 0, 5, 5), b(5, 0, 5, 5)))).toBe(0);
  });
});

describe('iou', () => {
  it('is 1 for identical boxes', () => expect(iou(b(3, 3, 7, 9), b(3, 3, 7, 9))).toBe(1));
  it('is 0 for disjoint boxes', () => expect(iou(b(0, 0, 5, 5), b(50, 50, 5, 5))).toBe(0));

  it('computes the classic half-overlap case', () => {
    // two 10x10 boxes offset by 5 in x: intersection 5x10=50, union 200-50=150
    expect(iou(b(0, 0, 10, 10), b(5, 0, 10, 10))).toBeCloseTo(50 / 150, 12);
  });

  it('is symmetric', () => {
    const a = b(2, 4, 11, 6);
    const c = b(7, 1, 5, 20);
    expect(iou(a, c)).toBeCloseTo(iou(c, a), 12);
  });

  it('is scale-invariant — the same in CSS space and image space', () => {
    const a = b(4, 8, 20, 10);
    const c = b(10, 9, 20, 10);
    expect(iou(toImageSpace(a, 2), toImageSpace(c, 2))).toBeCloseTo(iou(a, c), 12);
  });

  it('is 0 when a box is degenerate', () => {
    expect(iou(b(0, 0, 0, 0), b(0, 0, 10, 10))).toBe(0);
  });

  it('is the containment ratio when one box encloses the other', () => {
    expect(iou(b(0, 0, 10, 10), b(2, 2, 5, 5))).toBeCloseTo(25 / 100, 12);
  });
});

describe('union', () => {
  it('covers both boxes', () => {
    expect(union(b(0, 0, 4, 4), b(10, 10, 2, 2))).toEqual(b(0, 0, 12, 12));
  });
  it('ignores a degenerate operand instead of swallowing the origin', () => {
    expect(union(b(0, 0, 0, 0), b(10, 10, 2, 2))).toEqual(b(10, 10, 2, 2));
    expect(union(b(10, 10, 2, 2), b(0, 0, 0, 0))).toEqual(b(10, 10, 2, 2));
  });
  it('handles negative coordinates (scrolled above the viewport)', () => {
    expect(union(b(-20, -10, 5, 5), b(0, 0, 5, 5))).toEqual(b(-20, -10, 25, 15));
  });
  it('is symmetric', () => {
    expect(union(b(1, 2, 3, 4), b(9, 8, 7, 6))).toEqual(union(b(9, 8, 7, 6), b(1, 2, 3, 4)));
  });
});

describe('expand', () => {
  it('grows about the centre', () => {
    // 100x100 at (0,0) grown 10% -> 110x110 centred on (50,50)
    expect(expand(b(0, 0, 100, 100), 0.1)).toEqual(b(-5, -5, 110, 110));
  });
  it('keeps the centre fixed', () => {
    const box = b(10, 20, 30, 40);
    const out = expand(box, 0.5);
    expect(out.x + out.w / 2).toBeCloseTo(box.x + box.w / 2, 12);
    expect(out.y + out.h / 2).toBeCloseTo(box.y + box.h / 2, 12);
  });
  it('shrinks for a negative pct', () => {
    expect(expand(b(0, 0, 100, 100), -0.2)).toEqual(b(10, 10, 80, 80));
  });
  it('clamps to zero instead of inverting', () => {
    const out = expand(b(0, 0, 10, 10), -2);
    expect(out.w).toBe(0);
    expect(out.h).toBe(0);
    expect(out.x).toBe(5);
  });
  it('is a no-op at 0', () => {
    expect(expand(b(3, 4, 5, 6), 0)).toEqual(b(3, 4, 5, 6));
  });
});

describe('clampToViewport', () => {
  const vp = { w: 1280, h: 720 };

  it('leaves a fully visible box alone', () => {
    expect(clampToViewport(b(10, 10, 100, 50), vp)).toEqual(b(10, 10, 100, 50));
  });

  it('clips rather than translates — the box stays over its own pixels', () => {
    const out = clampToViewport(b(-40, 100, 100, 50), vp);
    expect(out).toEqual(b(0, 100, 60, 50));
  });

  it('clips the bottom-right', () => {
    expect(clampToViewport(b(1200, 700, 200, 200), vp)).toEqual(b(1200, 700, 80, 20));
  });

  it('empties a box that is entirely offscreen', () => {
    expect(isEmpty(clampToViewport(b(-500, -500, 100, 100), vp))).toBe(true);
    expect(isEmpty(clampToViewport(b(4000, 10, 100, 100), vp))).toBe(true);
  });

  it('rejects a non-finite viewport', () => {
    expect(() => clampToViewport(b(0, 0, 1, 1), { w: Number.NaN, h: 10 })).toThrow(RangeError);
  });
});
