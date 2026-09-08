import { describe, it, expect } from 'vitest';
import { decodeFrame, downscaledSize, LONG_EDGE, type DecodeDeps } from './frames';
import type { FrameRef } from '../shared/frames';

/**
 * Fake bitmaps that behave like the real thing in the one way that matters: `close()`
 * zeroes the dimensions and frees the memory. Acceptance criterion 3 is literally
 * "assert bitmap.width === 0 after close", and this is what makes that assertable
 * without a browser.
 */
function fakeBitmap(width: number, height: number) {
  const bitmap = {
    width,
    height,
    closed: false,
    close() {
      bitmap.closed = true;
      bitmap.width = 0;
      bitmap.height = 0;
    },
  };
  return bitmap;
}

function deps(sourceWidth: number, sourceHeight: number) {
  const full = fakeBitmap(sourceWidth, sourceHeight);
  const draws: number[][] = [];
  let canvasSize = { width: 0, height: 0 };

  const decode: DecodeDeps = {
    fetchBytes: async () => new Blob(),
    createBitmap: async () => full,
    createCanvas: (width, height) => {
      canvasSize = { width, height };
      return {
        getContext: () => ({
          drawImage: (_image, ...args: number[]) => draws.push(args),
        }),
        transferToImageBitmap: () => fakeBitmap(width, height),
      };
    },
  };

  return { decode, full, draws, canvas: () => canvasSize };
}

const FRAME: FrameRef = {
  kind: 'capture-tab',
  dataUrl: 'data:image/jpeg;base64,AAA',
  width: 2560,
  height: 1440,
  scale: 2,
};

describe('downscaledSize', () => {
  it('caps the long edge and keeps the aspect ratio', () => {
    expect(downscaledSize(2560, 1440)).toEqual({ width: 1024, height: 576 });
    expect(downscaledSize(1440, 2560)).toEqual({ width: 576, height: 1024 });
  });

  it('leaves a frame that is already small alone', () => {
    expect(downscaledSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('never rounds an edge away to nothing', () => {
    expect(downscaledSize(4000, 3).height).toBeGreaterThanOrEqual(1);
  });
});

describe('decodeFrame', () => {
  it('closes the full-resolution bitmap in the same tick', async () => {
    const d = deps(2560, 1440);
    await decodeFrame(FRAME, { w: 1280, h: 720 }, d.decode);

    // ~59 MB of decoded RGBA on a 2x 1440p display, per step, if this is missed.
    expect(d.full.closed).toBe(true);
    expect(d.full.width).toBe(0);
    expect(d.full.height).toBe(0);
  });

  it('closes it even when the draw throws', async () => {
    const d = deps(2560, 1440);
    const broken: DecodeDeps = {
      ...d.decode,
      createCanvas: () => ({
        getContext: () => null,
        transferToImageBitmap: () => fakeBitmap(0, 0),
      }),
    };

    await expect(decodeFrame(FRAME, { w: 1280, h: 720 }, broken)).rejects.toThrow(/2d context/);
    expect(d.full.closed).toBe(true);
  });

  it('hands back a buffer no larger than the long edge', async () => {
    const d = deps(2560, 1440);
    const decoded = await decodeFrame(FRAME, { w: 1280, h: 720 }, d.decode);

    expect(Math.max(decoded.width, decoded.height)).toBe(LONG_EDGE);
    expect(decoded.bitmap.width).toBe(1024);
  });

  it('derives scale from the buffer, not from devicePixelRatio', async () => {
    const d = deps(2560, 1440);
    const decoded = await decodeFrame(FRAME, { w: 1280, h: 720 }, d.decode);

    // Captured at 2x and downscaled to 1024: a CSS px is 0.8 image px now, not 2.
    // Using the device ratio here is the bug the whole module exists to prevent.
    expect(decoded.scale).toBeCloseTo(0.8, 6);
    expect(decoded.sourceWidth).toBe(2560);
  });

  it('is the identity on a 1x display with a small viewport', async () => {
    const d = deps(1000, 800);
    const decoded = await decodeFrame(
      { ...FRAME, width: 1000, height: 800, scale: 1 },
      { w: 1000, h: 800 },
      d.decode,
    );
    expect(decoded.scale).toBeCloseTo(1, 6);
  });

  it('draws the whole source into the whole target', async () => {
    const d = deps(2560, 1440);
    await decodeFrame(FRAME, { w: 1280, h: 720 }, d.decode);
    expect(d.draws).toEqual([[0, 0, 2560, 1440, 0, 0, 1024, 576]]);
  });
});
