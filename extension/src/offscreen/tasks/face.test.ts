/**
 * The YuNet decode, pinned by arithmetic rather than by a model.
 *
 * Every number here is worked out by hand from the encoding, on synthetic head tensors, so
 * the test fails when the anchor arithmetic drifts rather than when the weights change.
 * That matters more than usual for this layer: a decode that is wrong in any of three
 * specific ways -- transposed row-major walk, arithmetic instead of geometric score fusion,
 * a size relative to the anchor instead of the stride -- still produces boxes, still
 * produces plausible scores, and on a symmetric photograph still lands roughly on the face.
 * It looks like it works.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Box } from '../../shared/coords';
import {
  decodeFaces,
  FACE_INPUT,
  fromLetterbox,
  letterbox,
  nms,
  type FaceOutputs,
  type FaceTensor,
} from './face';

/** A small square so the cell counts are hand-checkable: 32/8 = 4 across, 16 cells. */
const INPUT = 32;
const CELLS = { 8: (INPUT / 8) ** 2, 16: (INPUT / 16) ** 2, 32: (INPUT / 32) ** 2 };

function zeros(n: number, width: number): FaceTensor {
  return { data: new Float32Array(n * width), dims: [1, n, width] };
}

/** All twelve heads, silent. Individual cells are then set by the tests. */
function quiet(): Record<string, FaceTensor> {
  const out: Record<string, FaceTensor> = {};
  for (const stride of [8, 16, 32] as const) {
    const cells = CELLS[stride];
    out[`cls_${stride}`] = zeros(cells, 1);
    out[`obj_${stride}`] = zeros(cells, 1);
    out[`bbox_${stride}`] = zeros(cells, 4);
    out[`kps_${stride}`] = zeros(cells, 10);
  }
  return out;
}

/** Make one cell fire, with a chosen box encoding. */
function fire(
  heads: Record<string, FaceTensor>,
  stride: 8 | 16 | 32,
  cell: number,
  { cls, obj, dx, dy, dw, dh }: Record<'cls' | 'obj' | 'dx' | 'dy' | 'dw' | 'dh', number>,
): void {
  const at = (head: string): Float32Array =>
    (heads[`${head}_${stride}`] as FaceTensor).data as Float32Array;

  at('cls')[cell] = cls;
  at('obj')[cell] = obj;
  const bbox = at('bbox');
  bbox[cell * 4] = dx;
  bbox[cell * 4 + 1] = dy;
  bbox[cell * 4 + 2] = dw;
  bbox[cell * 4 + 3] = dh;
}

const decode = (heads: FaceOutputs, over = {}) =>
  decodeFaces(heads, { input: INPUT, scoreThreshold: 0.5, ...over });

describe('the anchor arithmetic', () => {
  /**
   * Cell 5 of the stride-8 map is (col 1, row 1) on a 4x4 grid. With zero offsets:
   *   cx = (1 + 0) * 8 = 8,  cy = 8
   *   w  = exp(0) * 8  = 8,  h  = 8
   * so the corner box is (4, 4, 8, 8).
   */
  it('decodes a zero-offset cell to its own anchor', () => {
    const heads = quiet();
    fire(heads, 8, 5, { cls: 1, obj: 1, dx: 0, dy: 0, dw: 0, dh: 0 });

    expect(decode(heads)).toEqual([{ box: { x: 4, y: 4, w: 8, h: 8 }, score: 1 }]);
  });

  /**
   * The walk is row-major, and this is the test that catches it being transposed.
   * Cell 2 is (col 2, row 0) -- not (col 0, row 2). Those differ, so a transposed decode
   * puts the box on the wrong axis and every later stage carries it.
   */
  it('walks the feature map row-major, not column-major', () => {
    const heads = quiet();
    fire(heads, 8, 2, { cls: 1, obj: 1, dx: 0, dy: 0, dw: 0, dh: 0 });

    const [found] = decode(heads);
    expect(found?.box.x).toBe(16 - 4); // cx = 2*8 = 16, minus half a width of 8
    expect(found?.box.y).toBe(0 - 4); // cy = 0*8 = 0
  });

  /**
   * Offsets are added to the *cell index* before the stride multiplies, and the size is
   * exponential in the stride -- not in an anchor box, which YuNet does not have.
   *   cx = (1 + 0.5) * 8 = 12,  w = exp(1) * 8 = 21.7...
   */
  it('adds the offset to the cell index and scales the size by the stride', () => {
    const heads = quiet();
    fire(heads, 8, 5, { cls: 1, obj: 1, dx: 0.5, dy: -0.25, dw: 1, dh: 0 });

    const [found] = decode(heads);
    const w = Math.exp(1) * 8;
    expect(found?.box.w).toBeCloseTo(w, 6);
    expect(found?.box.h).toBeCloseTo(8, 6);
    expect(found?.box.x).toBeCloseTo(12 - w / 2, 6);
    expect(found?.box.y).toBeCloseTo((1 - 0.25) * 8 - 4, 6);
  });

  it('reads each stride at its own resolution', () => {
    const heads = quiet();
    // Cell 0 of stride 32 is the single cell of a 1x1 map: cx = cy = 0, w = h = 32.
    fire(heads, 32, 0, { cls: 1, obj: 1, dx: 0, dy: 0, dw: 0, dh: 0 });

    expect(decode(heads)).toEqual([{ box: { x: -16, y: -16, w: 32, h: 32 }, score: 1 }]);
  });
});

describe('score fusion', () => {
  /**
   * The geometric mean, not the arithmetic one and not the raw product.
   *
   * All three are between 0 and 1 and all three look reasonable in a log line. sqrt(0.81 *
   * 0.49) = 0.63; the arithmetic mean is 0.65 and the product 0.397 -- close enough to
   * pass a smoke test and far enough to move every detection across a 0.9 threshold.
   */
  it('is the geometric mean of the class and objectness heads', () => {
    const heads = quiet();
    fire(heads, 8, 0, { cls: 0.81, obj: 0.49, dx: 0, dy: 0, dw: 0, dh: 0 });

    expect(decode(heads, { scoreThreshold: 0.1 })[0]?.score).toBeCloseTo(0.63, 6);
  });

  it('clamps each head before fusing, so an overshooting logit cannot inflate the pair', () => {
    const heads = quiet();
    fire(heads, 8, 0, { cls: 3, obj: 0.25, dx: 0, dy: 0, dw: 0, dh: 0 });

    // sqrt(1 * 0.25), not sqrt(3 * 0.25) = 0.866.
    expect(decode(heads, { scoreThreshold: 0.1 })[0]?.score).toBeCloseTo(0.5, 6);
  });

  it('drops everything below the threshold', () => {
    const heads = quiet();
    fire(heads, 8, 0, { cls: 0.8, obj: 0.8, dx: 0, dy: 0, dw: 0, dh: 0 });

    expect(decode(heads, { scoreThreshold: 0.9 })).toEqual([]);
    expect(decode(heads, { scoreThreshold: 0.7 })).toHaveLength(1);
  });
});

describe('suppression', () => {
  /**
   * One face fires on several neighbouring cells and often on two strides at once. Without
   * this, one face is four overlapping blurs and four manifest rows.
   */
  it('keeps the strongest of a cluster', () => {
    const heads = quiet();
    fire(heads, 8, 5, { cls: 1, obj: 1, dx: 0, dy: 0, dw: 0, dh: 0 });
    fire(heads, 8, 6, { cls: 0.9, obj: 0.9, dx: -1, dy: 0, dw: 0, dh: 0 });

    const found = decode(heads);
    expect(found).toHaveLength(1);
    expect(found[0]?.score).toBe(1);
  });

  it('keeps two faces that do not overlap', () => {
    const heads = quiet();
    fire(heads, 8, 0, { cls: 1, obj: 1, dx: 0, dy: 0, dw: 0, dh: 0 });
    fire(heads, 8, 15, { cls: 1, obj: 1, dx: 0, dy: 0, dw: 0, dh: 0 });

    expect(decode(heads)).toHaveLength(2);
  });

  it('is greedy by score, so the winner is chosen before its neighbours are judged', () => {
    const a = { box: { x: 0, y: 0, w: 10, h: 10 }, score: 0.5 };
    const b = { box: { x: 1, y: 1, w: 10, h: 10 }, score: 0.9 };
    expect(nms([a, b], 0.3)).toEqual([b]);
  });
});

describe('a graph that is not ours', () => {
  it('says which head is missing rather than reporting no faces', () => {
    const heads = quiet();
    delete heads.obj_16;
    // Silence here would reach the operator as "this page has no faces on it", which is
    // the one thing a privacy layer must not say when it is actually broken.
    expect(() => decode(heads)).toThrow(/stride 16 is missing a head/);
  });
});

describe('the letterbox, and undoing it exactly', () => {
  it('fits a landscape frame and centres the padding', () => {
    const fit = letterbox(1024, 640);
    expect(fit.scale).toBeCloseTo(640 / 1024, 6);
    expect(fit.padX).toBe(0);
    expect(fit.padY).toBeCloseTo((FACE_INPUT - 640 * (640 / 1024)) / 2, 6);
  });

  it('round-trips a box back to source pixels', () => {
    const fit = letterbox(1024, 640);
    const source = { x: 100, y: 50, w: 80, h: 90 };
    const inModel = {
      x: source.x * fit.scale + fit.padX,
      y: source.y * fit.scale + fit.padY,
      w: source.w * fit.scale,
      h: source.h * fit.scale,
    };

    const back = fromLetterbox(inModel, fit);
    expect(back.x).toBeCloseTo(source.x, 6);
    expect(back.y).toBeCloseTo(source.y, 6);
    expect(back.w).toBeCloseTo(source.w, 6);
    expect(back.h).toBeCloseTo(source.h, 6);
  });

  /**
   * The failure this exists to prevent: forgetting the pad offset leaves a box that is
   * plausibly sized and vertically wrong by half the padding -- a blur beside the face,
   * which looks like the feature working.
   */
  it('is not the same as dividing by the scale alone', () => {
    const fit = letterbox(1024, 640);
    const box = { x: 0, y: 100, w: 10, h: 10 };
    expect(fromLetterbox(box, fit).y).not.toBeCloseTo(box.y / fit.scale, 3);
  });

  it('leaves a square frame unpadded', () => {
    const fit = letterbox(500, 500);
    expect(fit.padX).toBe(0);
    expect(fit.padY).toBe(0);
    expect(fit.scale).toBeCloseTo(FACE_INPUT / 500, 6);
  });
});

/**
 * The same decode, against the real graph's real outputs.
 *
 * The tests above pin the arithmetic and would all still pass if the tensor layout were
 * not what they assume -- if `cls_8` came back `[1,1,6400]`, or the heads were ordered
 * differently, hand-computed synthetic tensors would say nothing about it and the browser
 * would quietly find no faces.
 *
 * So this replays `face.golden.json`: the bundled model run on a seeded synthetic input,
 * and the boxes the OpenCV FaceDetectorYN postprocess produces from those exact tensors.
 * Two independent implementations of one reference, agreeing on 202 detections.
 *
 * Regenerate with `python scripts/make-face-fixture.py` when the weights change.
 */
function floatsOf(base64: string): Float32Array {
  const bytes = Buffer.from(base64, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

describe('against the real graph', () => {
  const golden = JSON.parse(
    readFileSync(join(import.meta.dirname, 'face.golden.json'), 'utf8'),
  ) as {
    input: number;
    scoreThreshold: number;
    nmsIou: number;
    expected: Array<{ box: Box; score: number }>;
    tensors: Record<string, { dims: number[]; f32: string }>;
  };

  const outputs: FaceOutputs = Object.fromEntries(
    Object.entries(golden.tensors).map(([name, tensor]) => [
      name,
      // `Buffer.from` hands back a view into a pooled ArrayBuffer, so `.buffer` is the
      // whole pool and not this tensor. Reading it directly produced 252 detections
      // instead of 202, scoring a confident 1.0 on somebody else's bytes.
      { dims: tensor.dims, data: floatsOf(tensor.f32) },
    ]),
  );

  const found = decodeFaces(outputs, {
    input: golden.input,
    scoreThreshold: golden.scoreThreshold,
    nmsIou: golden.nmsIou,
  });

  it('reads the tensor layout the model actually produces', () => {
    // A layout mismatch does not throw, it silently decodes garbage -- so the count is
    // the assertion that catches it.
    expect(found).toHaveLength(golden.expected.length);
  });

  it('agrees with the reference postprocess box for box', () => {
    for (const [i, want] of golden.expected.entries()) {
      const got = found[i];
      expect(got?.score).toBeCloseTo(want.score, 5);
      expect(got?.box.x).toBeCloseTo(want.box.x, 3);
      expect(got?.box.y).toBeCloseTo(want.box.y, 3);
      expect(got?.box.w).toBeCloseTo(want.box.w, 3);
      expect(got?.box.h).toBeCloseTo(want.box.h, 3);
    }
  });

  /**
   * Noise is not a face. 202 detections at a 0.05 threshold and none at the shipped 0.9 is
   * the shape a working detector has: confident about nothing in particular.
   */
  it('finds nothing in noise at the threshold that ships', () => {
    expect(decodeFaces(outputs, { input: golden.input })).toEqual([]);
  });
});
