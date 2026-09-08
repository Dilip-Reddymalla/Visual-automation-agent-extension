import { describe, it, expect } from 'vitest';
import { createTimingRing, RING_CAPACITY } from './timings';

describe('the timing ring', () => {
  it('is empty until something runs', () => {
    const ring = createTimingRing();
    expect(ring.latest()).toEqual({});
    expect(ring.count('ner')).toBe(0);
    expect(ring.percentile('ner', 50)).toBeUndefined();
  });

  it('keeps the newest sample per task, which is what goes on the wire', () => {
    const ring = createTimingRing();
    ring.record('ner', 12);
    ring.record('ner', 8);
    ring.record('ocr', 240);

    expect(ring.latest()).toEqual({ ner: 8, ocr: 240 });
  });

  it('rounds the wire value but keeps the samples exact', () => {
    const ring = createTimingRing();
    ring.record('face', 3.14159);
    expect(ring.latest().face).toBe(3.14);
    expect(ring.samples('face')[0]).toBe(3.14159);
  });

  it('holds a bounded history -- a long session cannot grow it', () => {
    const ring = createTimingRing();
    for (let i = 0; i < RING_CAPACITY + 20; i += 1) ring.record('ocr', i);

    expect(ring.count('ocr')).toBe(RING_CAPACITY);
    // Newest first, and the oldest have fallen off the end.
    expect(ring.samples('ocr')[0]).toBe(RING_CAPACITY + 19);
  });

  it('computes the percentiles the report needs', () => {
    const ring = createTimingRing();
    for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) ring.record('ner', ms);

    expect(ring.percentile('ner', 50)).toBe(50);
    expect(ring.percentile('ner', 95)).toBe(100);
    expect(ring.percentile('ner', 0)).toBe(10);
    expect(ring.percentile('ner', 100)).toBe(100);
  });

  it('keeps tasks apart', () => {
    const ring = createTimingRing();
    ring.record('ner', 5);
    ring.record('ocr', 500);

    expect(ring.percentile('ner', 50)).toBe(5);
    expect(ring.percentile('ocr', 50)).toBe(500);
  });

  it('clears', () => {
    const ring = createTimingRing();
    ring.record('ner', 5);
    ring.clear();
    expect(ring.latest()).toEqual({});
  });
});
