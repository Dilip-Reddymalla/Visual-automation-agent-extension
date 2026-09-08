/**
 * A canvas that really holds pixels, in Node.
 *
 * The gate's tests are not about whether a 2D context exists -- they are about whether
 * the right pixels changed. A mock that records calls could not tell a mask that
 * covered the Aadhaar number from one that covered the label beside it, and it could
 * not compare the two blur paths at all, which acceptance criterion 6 asks for.
 *
 * So this is a real, tiny raster: an RGBA buffer with the handful of operations the
 * gate uses. `drawImage` does nearest-neighbour when smoothing is off and box-average
 * when it is on, which is close enough to a browser's behaviour for "did these two
 * blurs produce the same picture" to be a meaningful question.
 *
 * It lives in testing/ rather than beside the gate because it implements
 * `convertToBlob` -- and the encoder ban covers all of redaction/, correctly. Nothing
 * outside a test imports this, so it reaches no bundle and `npm run test:gate`, which
 * reads the emitted bundles, is unaffected. `boundaries.test.ts` asserts that.
 *
 * Not a *.test.ts file, so several suites can import it.
 */

import type { GateCanvas, GateContext, SourceBitmap } from '../redaction/gate';

export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function createRaster(width: number, height: number, fill = 255): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(fill);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

/** A recognisable pattern, so a blur has something to destroy. */
export function checkerboard(width: number, height: number, cell = 4): Raster {
  const raster = createRaster(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dark = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const at = (y * width + x) * 4;
      const value = dark ? 20 : 235;
      raster.data[at] = value;
      raster.data[at + 1] = value;
      raster.data[at + 2] = value;
      raster.data[at + 3] = 255;
    }
  }
  return raster;
}

export function pixelAt(raster: Raster, x: number, y: number): [number, number, number] {
  const at = (y * raster.width + x) * 4;
  return [raster.data[at] ?? 0, raster.data[at + 1] ?? 0, raster.data[at + 2] ?? 0];
}

/** Mean absolute difference per channel, 0 (identical) to 255. */
export function meanAbsDiff(a: Raster, b: Raster): number {
  if (a.width !== b.width || a.height !== b.height) return 255;
  let total = 0;
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      total += Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0));
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

/** How much a region varies. A blur flattens it; a mask flattens it to nothing. */
export function regionVariance(
  raster: Raster,
  x0: number,
  y0: number,
  w: number,
  h: number,
): number {
  const values: number[] = [];
  for (let y = y0; y < Math.min(raster.height, y0 + h); y += 1) {
    for (let x = x0; x < Math.min(raster.width, x0 + w); x += 1) {
      values.push(pixelAt(raster, x, y)[0]);
    }
  }
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
}

export interface FakeCanvasOptions {
  /** Whether ctx.filter takes effect. False models Firefox's OffscreenCanvas. */
  supportsFilter?: boolean;
}

export interface FakeCanvas extends GateCanvas {
  raster: Raster;
  /** Every convertToBlob call, so the tests can prove there was exactly one. */
  encodes: number;
}

function sourceRaster(source: unknown): Raster | null {
  if (source && typeof source === 'object' && 'raster' in source) {
    return (source as { raster: Raster }).raster;
  }
  return null;
}

/** Box-average sample, which is what a browser does when smoothing is on. */
function sample(src: Raster, sx: number, sy: number, sw: number, sh: number, smooth: boolean) {
  if (!smooth) {
    const x = Math.min(src.width - 1, Math.max(0, Math.round(sx)));
    const y = Math.min(src.height - 1, Math.max(0, Math.round(sy)));
    return pixelAt(src, x, y);
  }

  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = Math.floor(sy); y < Math.ceil(sy + sh); y += 1) {
    for (let x = Math.floor(sx); x < Math.ceil(sx + sw); x += 1) {
      if (x < 0 || y < 0 || x >= src.width || y >= src.height) continue;
      const [pr, pg, pb] = pixelAt(src, x, y);
      r += pr;
      g += pg;
      b += pb;
      n += 1;
    }
  }
  return n === 0
    ? ([0, 0, 0] as [number, number, number])
    : ([r / n, g / n, b / n] as [number, number, number]);
}

/** A separable box blur, standing in for the browser's Gaussian. */
function boxBlur(
  raster: Raster,
  x0: number,
  y0: number,
  w: number,
  h: number,
  radius: number,
): void {
  const copy = new Uint8ClampedArray(raster.data);
  for (let y = y0; y < Math.min(raster.height, y0 + h); y += 1) {
    for (let x = x0; x < Math.min(raster.width, x0 + w); x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sx = x + dx;
          const sy = y + dy;
          if (sx < 0 || sy < 0 || sx >= raster.width || sy >= raster.height) continue;
          const at = (sy * raster.width + sx) * 4;
          r += copy[at] ?? 0;
          g += copy[at + 1] ?? 0;
          b += copy[at + 2] ?? 0;
          n += 1;
        }
      }
      const at = (y * raster.width + x) * 4;
      raster.data[at] = r / n;
      raster.data[at + 1] = g / n;
      raster.data[at + 2] = b / n;
    }
  }
}

export function createFakeCanvas(
  width: number,
  height: number,
  options: FakeCanvasOptions = {},
): FakeCanvas {
  const supportsFilter = options.supportsFilter ?? true;
  const raster = createRaster(width, height, 255);

  const ctx: GateContext = {
    filter: 'none',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    fillStyle: '#000000',

    save() {
      saved.push({
        filter: ctx.filter,
        smoothing: ctx.imageSmoothingEnabled,
        quality: ctx.imageSmoothingQuality,
        fill: ctx.fillStyle,
      });
    },
    restore() {
      const state = saved.pop();
      if (!state) return;
      ctx.filter = state.filter;
      ctx.imageSmoothingEnabled = state.smoothing;
      ctx.imageSmoothingQuality = state.quality;
      ctx.fillStyle = state.fill;
    },

    drawImage(source: unknown, ...args: number[]) {
      const src = sourceRaster(source);
      if (!src) return;

      const [sx, sy, sw, sh, dx, dy, dw, dh] =
        args.length >= 8
          ? (args as [number, number, number, number, number, number, number, number])
          : ([
              0,
              0,
              src.width,
              src.height,
              args[0] ?? 0,
              args[1] ?? 0,
              src.width,
              src.height,
            ] as [number, number, number, number, number, number, number, number]);

      const scaleX = sw / dw;
      const scaleY = sh / dh;
      const smooth = ctx.imageSmoothingEnabled && (dw < sw || dh < sh);

      for (let y = 0; y < Math.round(dh); y += 1) {
        for (let x = 0; x < Math.round(dw); x += 1) {
          const tx = Math.round(dx) + x;
          const ty = Math.round(dy) + y;
          if (tx < 0 || ty < 0 || tx >= raster.width || ty >= raster.height) continue;

          const [r, g, b] = sample(
            src,
            sx + x * scaleX,
            sy + y * scaleY,
            scaleX,
            scaleY,
            smooth,
          );
          const at = (ty * raster.width + tx) * 4;
          raster.data[at] = r;
          raster.data[at + 1] = g;
          raster.data[at + 2] = b;
          raster.data[at + 3] = 255;
        }
      }

      // The filter, if this context claims to have one.
      const match = /^blur\((\d+(?:\.\d+)?)px\)$/.exec(ctx.filter);
      if (supportsFilter && match) {
        const radius = Math.max(1, Math.round(Number.parseFloat(match[1] ?? '0') / 2));
        boxBlur(raster, Math.round(dx), Math.round(dy), Math.round(dw), Math.round(dh), radius);
      }
    },

    fillRect(x, y, w, h) {
      const [r, g, b] = parseColour(ctx.fillStyle);
      for (let py = y; py < Math.min(raster.height, y + h); py += 1) {
        for (let px = x; px < Math.min(raster.width, x + w); px += 1) {
          if (px < 0 || py < 0) continue;
          const at = (py * raster.width + px) * 4;
          raster.data[at] = r;
          raster.data[at + 1] = g;
          raster.data[at + 2] = b;
          raster.data[at + 3] = 255;
        }
      }
    },
  };

  const saved: Array<{
    filter: string;
    smoothing: boolean;
    quality: 'low' | 'medium' | 'high';
    fill: string;
  }> = [];

  // Firefox's failure mode: the assignment succeeds and reads back, but blurs nothing.
  // Modelling it as "does not read back" is the detectable case; the silent one is
  // covered by the fallback being the default when the probe is not a definite yes.
  if (!supportsFilter) {
    let stored = 'none';
    Object.defineProperty(ctx, 'filter', {
      get: () => stored,
      set: (value: string) => {
        stored = value === 'none' ? 'none' : 'none';
      },
    });
  }

  const canvas: FakeCanvas = {
    raster,
    encodes: 0,
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    getContext: () => ctx,
    async convertToBlob() {
      canvas.encodes += 1;
      // The "encoded" bytes are the raster itself: deterministic, which is what the
      // digest tests need.
      return new Blob([new Uint8Array(raster.data)], { type: 'image/webp' });
    },
  };

  return canvas;
}

function parseColour(style: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(style);
  if (!hex?.[1]) return [0, 0, 0];
  const n = Number.parseInt(hex[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A source bitmap backed by a raster, which records whether it was closed. */
export function createFakeBitmap(
  raster: Raster,
): SourceBitmap & { raster: Raster; closed: boolean } {
  const bitmap = {
    raster,
    closed: false,
    get width() {
      return raster.width;
    },
    get height() {
      return raster.height;
    },
    close() {
      bitmap.closed = true;
    },
  };
  return bitmap;
}
