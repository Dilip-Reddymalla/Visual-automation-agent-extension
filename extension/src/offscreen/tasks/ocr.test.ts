/**
 * Unit tests for the on-device OCR pipeline (L3 text perception).
 */

import { describe, expect, it } from 'vitest';
import type { ObservedElement } from '../../shared/observed';
import type { ModelSession, TensorLike } from '../host';
import {
  createOcrCache,
  createOcrRunner,
  decodeCtc,
  linesToViewport,
  opaqueRegions,
  postprocessDet,
  preprocessDetImage,
  preprocessRecCrop,
  resizeBilinear,
  type OcrLine,
  type RawImageLike,
} from './ocr';

describe('OCR pipeline', () => {
  describe('opaqueRegions', () => {
    it('selects opaque tags with side >= 48px', () => {
      const elements: ObservedElement[] = [
        {
          index: 1,
          tag: 'img',
          name: '',
          box: { x: 10, y: 20, w: 100, h: 80 },
          state: { focused: false, filled: false },
          attributes: {},
        } as unknown as ObservedElement,
        {
          index: 2,
          tag: 'canvas',
          name: '',
          box: { x: 120, y: 20, w: 200, h: 150 },
          state: { focused: false, filled: false },
          attributes: {},
        } as unknown as ObservedElement,
        {
          index: 3,
          tag: 'img',
          name: 'icon',
          box: { x: 0, y: 0, w: 16, h: 16 }, // too small
          state: { focused: false, filled: false },
          attributes: {},
        } as unknown as ObservedElement,
        {
          index: 4,
          tag: 'div',
          name: 'text',
          box: { x: 50, y: 50, w: 200, h: 100 }, // not opaque
          state: { focused: false, filled: false },
          attributes: {},
        } as unknown as ObservedElement,
      ];

      const regions = opaqueRegions(elements);
      expect(regions).toHaveLength(2);
      expect(regions[0]?.region).toBe(0);
      expect(regions[0]?.elementIndex).toBe(1);
      expect(regions[1]?.region).toBe(1);
      expect(regions[1]?.elementIndex).toBe(2);
    });
  });

  describe('OcrCache', () => {
    it('stores and retrieves cached OCR lines by pixel hash', () => {
      const cache = createOcrCache(2);
      const lines: OcrLine[] = [
        { text: 'Aadhaar 1234', box: { x: 5, y: 5, w: 50, h: 20 }, score: 0.95, region: 0 },
      ];

      expect(cache.get('hash1', 1000)).toBeUndefined();
      expect(cache.misses).toBe(1);

      cache.set('hash1', lines, 1000);
      expect(cache.size).toBe(1);

      const hit = cache.get('hash1', 1100);
      expect(hit).toBeDefined();
      expect(hit?.[0]?.text).toBe('Aadhaar 1234');
      expect(cache.hits).toBe(1);

      // Mutating returned box must not mutate cache
      hit![0]!.box.x = 999;
      expect(cache.get('hash1', 1200)?.[0]?.box.x).toBe(5);

      // LRU Eviction
      cache.set('hash2', lines, 1200);
      cache.set('hash3', lines, 1300); // evicts hash1
      expect(cache.get('hash1', 1400)).toBeUndefined();
      expect(cache.get('hash2', 1400)).toBeDefined();
    });
  });

  describe('linesToViewport', () => {
    it('transforms crop coordinates to visual viewport CSS px', () => {
      const lines: OcrLine[] = [
        { text: 'HELLO', box: { x: 10, y: 10, w: 40, h: 20 }, score: 0.9, region: 0 },
      ];
      const region = {
        region: 3,
        box: { x: 100, y: 200, w: 300, h: 150 },
        reason: 'tag-img',
      };
      const scale = 2.0; // 2 image px per CSS px

      const projected = linesToViewport(lines, region, scale);
      expect(projected).toHaveLength(1);
      expect(projected[0]?.region).toBe(3);
      expect(projected[0]?.box).toEqual({
        x: 100 + 10 / 2,
        y: 200 + 10 / 2,
        w: 40 / 2,
        h: 20 / 2,
      });
    });
  });

  describe('DBNet Preprocessing & Postprocessing', () => {
    it('resizes and normalizes images to multiple of 32', () => {
      const dummyImage: RawImageLike = {
        width: 100,
        height: 50,
        data: new Uint8ClampedArray(100 * 50 * 4).fill(128),
      };

      const pre = preprocessDetImage(dummyImage);
      expect(pre.dims[0]).toBe(1);
      expect(pre.dims[1]).toBe(3);
      expect(pre.dims[2] % 32).toBe(0);
      expect(pre.dims[3] % 32).toBe(0);
      expect(pre.tensorData.length).toBe(3 * pre.dims[2] * pre.dims[3]);
    });

    it('extracts bounding boxes from probability map with unclip expansion', () => {
      const W = 64;
      const H = 64;
      const probMap = new Float32Array(W * H).fill(0.1);

      // Plant a high-probability text blob in the center: rectangle (16, 20) to (48, 30)
      for (let y = 20; y <= 30; y++) {
        for (let x = 16; x <= 48; x++) {
          probMap[y * W + x] = 0.9;
        }
      }

      const boxes = postprocessDet(probMap, W, H, 1.0, 1.0, 0.3, 0.5, 1.5);
      expect(boxes).toHaveLength(1);
      const b = boxes[0]!;
      expect(b.x).toBeLessThanOrEqual(16);
      expect(b.y).toBeLessThanOrEqual(20);
      expect(b.w).toBeGreaterThanOrEqual(32);
      expect(b.h).toBeGreaterThanOrEqual(10);
    });
  });

  describe('CTC Decoding', () => {
    it('decodes greedy CTC logits and collapses consecutive duplicates', () => {
      const charset = ['A', 'B', 'C', 'D', 'E', 'F'];
      const vocabSize = charset.length + 2; // +1 for blank (0), +1 for space (7)
      const timeSteps = 8;

      const logits = new Float32Array(timeSteps * vocabSize).fill(0);

      // Let sequence be: [0, 1 (A), 1 (A), 0 (blank), 2 (B), 2 (B), 7 (space), 3 (C)]
      // Expect decoded: "AB C"
      const sequence = [0, 1, 1, 0, 2, 2, 7, 3];
      for (let t = 0; t < timeSteps; t++) {
        logits[t * vocabSize + sequence[t]!] = 5.0;
      }

      const res = decodeCtc(logits, timeSteps, vocabSize, charset);
      expect(res.text).toBe('AB C');
      expect(res.score).toBeGreaterThan(0.9);
    });
  });

  describe('createOcrRunner', () => {
    it('executes detection and recognition pipeline end to end', async () => {
      const charset = ['T', 'E', 'S', 'T', '1', '2', '3'];

      const sessionDet: ModelSession = {
        inputNames: ['x'],
        outputNames: ['sigmoid_0'],
        async run(): Promise<Record<string, TensorLike>> {
          const W = 64;
          const H = 64;
          const prob = new Float32Array(W * H).fill(0.1);
          for (let y = 10; y <= 25; y++) {
            for (let x = 10; x <= 50; x++) {
              prob[y * W + x] = 0.95;
            }
          }
          return {
            sigmoid_0: {
              type: 'float32',
              dims: [1, 1, H, W],
              data: prob,
            },
          };
        },
        async dispose(): Promise<void> {},
      };

      const sessionRec: ModelSession = {
        inputNames: ['x'],
        outputNames: ['softmax_0'],
        async run(): Promise<Record<string, TensorLike>> {
          const timeSteps = 6;
          const vocabSize = 6625;
          const logits = new Float32Array(timeSteps * vocabSize).fill(0);

          // Spell out: 1 (T), 2 (E), 3 (S), 1 (T) -> "TEST"
          const seq = [1, 2, 3, 1, 0, 0];
          for (let t = 0; t < timeSteps; t++) {
            logits[t * vocabSize + seq[t]!] = 6.0;
          }

          return {
            softmax_0: {
              type: 'float32',
              dims: [1, timeSteps, vocabSize],
              data: logits,
            },
          };
        },
        async dispose(): Promise<void> {},
      };

      const runner = createOcrRunner(sessionDet, sessionRec, charset, (type, data, dims) => ({
        type,
        dims,
        data: Float32Array.from(data as ArrayLike<number>),
      }));

      const dummyImage: RawImageLike = {
        width: 64,
        height: 64,
        data: new Uint8ClampedArray(64 * 64 * 4).fill(200),
      };

      const lines = await runner(dummyImage, 5);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.text).toBe('TEST');
      expect(lines[0]?.region).toBe(5);
      expect(lines[0]?.score).toBeGreaterThan(0.9);
    });
  });
});
