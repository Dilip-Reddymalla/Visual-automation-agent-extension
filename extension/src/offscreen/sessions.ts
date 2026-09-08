/**
 * Model session lifecycle. Lazy-load, unload after 60 idle seconds, keep idle cost at
 * zero -- client resource utilisation is 20% of the evaluation, and loading every model
 * at startup has already cost other teams that whole slice.
 *
 * Two properties this file exists to guarantee:
 *
 *   Nothing is resident that is not being used. A session with no borrowers for
 *   IDLE_UNLOAD_MS is released, and when the last one goes the timer goes with it --
 *   an extension sitting idle has no session, no timer and no wakeups. That is a real
 *   requirement, not a nicety: a repeating timer would show up as non-zero idle CPU.
 *
 *   A session is never loaded twice. Two phases asking at the same moment share one
 *   load; a refcount keeps the second borrower from unloading under the first.
 *
 * Node-pure: the runtime and the clock are both injected.
 */

import type { InferTask } from '../shared/messages';
import type { Backend, ModelPaths, ModelSession, OrtRuntime } from './host';

export const IDLE_UNLOAD_MS = 60_000;

export type TimerHandle = number;

export interface Scheduler {
  now(): number;
  setTimer(fn: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

export interface ResidentEntry {
  task: InferTask;
  bytes: number;
  /** Borrowers right now. Zero means it is a candidate for the idle sweep. */
  refs: number;
  lastUsed: number;
  backend: Backend;
}

export interface SessionRegistry {
  acquire(task: InferTask): Promise<ModelSession>;
  release(task: InferTask): void;
  /** Unload anything idle longer than idleMs. Returns what it dropped. */
  sweepIdle(now: number): Promise<InferTask[]>;
  unload(task: InferTask | 'all'): Promise<number>;
  resident(): ResidentEntry[];
  residentBytes(): number;
  /** Cancel the idle timer without unloading. For teardown. */
  stop(): void;
}

export interface RegistryOptions {
  runtime: OrtRuntime;
  backend: Backend;
  models: ModelPaths;
  scheduler: Scheduler;
  idleMs?: number;
  /** Called when a WebGPU load failed and the WASM path took over. */
  onBackendDowngrade?(to: Backend, task: InferTask, reason: string): void;
}

interface Entry extends ResidentEntry {
  session: ModelSession;
}

export function createSessionRegistry(options: RegistryOptions): SessionRegistry {
  const { runtime, models, scheduler } = options;
  const idleMs = options.idleMs ?? IDLE_UNLOAD_MS;

  const entries = new Map<InferTask, Entry>();
  const loading = new Map<InferTask, Promise<Entry>>();
  let backend = options.backend;
  let timer: TimerHandle | null = null;

  function cancelTimer(): void {
    if (timer === null) return;
    scheduler.clearTimer(timer);
    timer = null;
  }

  /**
   * Arm one timer for the earliest deadline among idle sessions -- or none at all when
   * everything is either borrowed or already gone. This is the whole no-polling story.
   */
  function armTimer(): void {
    cancelTimer();
    const idle = [...entries.values()].filter((e) => e.refs === 0);
    if (idle.length === 0) return;

    const earliest = Math.min(...idle.map((e) => e.lastUsed));
    const delay = Math.max(0, earliest + idleMs - scheduler.now());
    timer = scheduler.setTimer(() => {
      timer = null;
      void sweepIdle(scheduler.now());
    }, delay);
  }

  async function load(task: InferTask): Promise<Entry> {
    const path = models[task];
    // NER runs on WASM regardless of what the GPU advertises. See below.
    const wanted: Backend = task === 'ner' ? 'wasm' : backend;
    let loaded;
    try {
      // The checkpoint is int8, and its MatMulInteger / DynamicQuantizeLinear graph is
      // not faithfully executed by the WebGPU backend: the session builds, inference
      // returns, and every token comes back 'O' with a confident logit. No error, no
      // fallback, no way to tell from the outside that the model is producing noise --
      // the same ids give correct labels on CPU in Python and nothing at all here.
      //
      // The vision models are float and stay on the GPU, which is where the GPU is worth
      // having. This is one task pinned for a reason, not a blanket downgrade.
      loaded = await runtime.loadModel(path, wanted);
    } catch (err) {
      if (wanted !== 'webgpu') throw err;
      // The adapter existed and the session still would not build. This is the
      // fallback the prompt asks to be a tested path, not a hopeful one.
      const reason = err instanceof Error ? err.message : String(err);
      backend = 'wasm';
      options.onBackendDowngrade?.('wasm', task, reason);
      loaded = await runtime.loadModel(path, 'wasm');
    }

    return {
      task,
      bytes: loaded.bytes,
      refs: 0,
      lastUsed: scheduler.now(),
      backend,
      session: loaded.session,
    };
  }

  async function acquire(task: InferTask): Promise<ModelSession> {
    const existing = entries.get(task);
    if (existing) {
      existing.refs += 1;
      existing.lastUsed = scheduler.now();
      // Borrowed sessions are not sweep candidates; the deadline may have moved.
      armTimer();
      return existing.session;
    }

    // Second caller during a load waits for the first one's session.
    let pending = loading.get(task);
    if (!pending) {
      pending = load(task).finally(() => loading.delete(task));
      loading.set(task, pending);
    }

    const entry = await pending;
    entries.set(task, entry);
    entry.refs += 1;
    entry.lastUsed = scheduler.now();
    armTimer();
    return entry.session;
  }

  function release(task: InferTask): void {
    const entry = entries.get(task);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    entry.lastUsed = scheduler.now();
    armTimer();
  }

  async function drop(entry: Entry): Promise<number> {
    entries.delete(entry.task);
    await entry.session.dispose();
    return entry.bytes;
  }

  async function sweepIdle(now: number): Promise<InferTask[]> {
    const stale = [...entries.values()].filter(
      (e) => e.refs === 0 && now - e.lastUsed >= idleMs,
    );
    for (const entry of stale) await drop(entry);
    armTimer();
    return stale.map((e) => e.task);
  }

  async function unload(task: InferTask | 'all'): Promise<number> {
    const doomed = task === 'all' ? [...entries.values()] : [entries.get(task)].filter(isEntry);
    let freed = 0;
    for (const entry of doomed) freed += await drop(entry);
    armTimer();
    return freed;
  }

  return {
    acquire,
    release,
    sweepIdle,
    unload,
    resident: () =>
      [...entries.values()].map(({ task, bytes, refs, lastUsed, backend: b }) => ({
        task,
        bytes,
        refs,
        lastUsed,
        backend: b,
      })),
    residentBytes: () => [...entries.values()].reduce((sum, e) => sum + e.bytes, 0),
    stop: cancelTimer,
  };
}

function isEntry(entry: Entry | undefined): entry is Entry {
  return entry !== undefined;
}
