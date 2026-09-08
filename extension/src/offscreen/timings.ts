/**
 * One ring buffer of wall times per task, and no second timing mechanism anywhere.
 *
 * Every model call goes through `InferenceHost.withTask`, which records into this. The
 * latency waterfall (M10) and the p50/p95 in the report (M11) both read it. If a later
 * module wants a number, it comes from here -- two clocks disagreeing is how a latency
 * budget stops meaning anything.
 *
 * Fixed capacity, so a long session cannot grow it without bound.
 */

import type { InferTask } from '../shared/messages';

export const RING_CAPACITY = 64;

export interface TimingRing {
  record(task: InferTask, ms: number): void;
  /** Newest first. */
  samples(task: InferTask): number[];
  /** Most recent duration per task, which is what HostStats carries on the wire. */
  latest(): Partial<Record<InferTask, number>>;
  /** Linear-interpolation-free nearest-rank percentile. p is 0..100. */
  percentile(task: InferTask, p: number): number | undefined;
  count(task: InferTask): number;
  clear(): void;
}

export function createTimingRing(capacity: number = RING_CAPACITY): TimingRing {
  // Newest first, capped. Small enough that shifting beats index arithmetic.
  const buffers = new Map<InferTask, number[]>();

  function buffer(task: InferTask): number[] {
    const existing = buffers.get(task);
    if (existing) return existing;
    const fresh: number[] = [];
    buffers.set(task, fresh);
    return fresh;
  }

  return {
    record(task, ms) {
      const b = buffer(task);
      b.unshift(ms);
      if (b.length > capacity) b.length = capacity;
    },

    samples: (task) => [...buffer(task)],

    latest() {
      const out: Partial<Record<InferTask, number>> = {};
      for (const [task, b] of buffers) {
        const newest = b[0];
        if (newest !== undefined) out[task] = Math.round(newest * 100) / 100;
      }
      return out;
    },

    percentile(task, p) {
      const b = buffer(task);
      if (b.length === 0) return undefined;
      const sorted = [...b].sort((a, z) => a - z);
      const clamped = Math.min(100, Math.max(0, p));
      const rank = Math.ceil((clamped / 100) * sorted.length);
      return sorted[Math.max(0, rank - 1)];
    },

    count: (task) => buffer(task).length,

    clear() {
      buffers.clear();
    },
  };
}
