/**
 * A fake OrtRuntime, shared by the host tests.
 *
 * It counts loads, disposals and runs, and can be told to fail a WebGPU load so the
 * WASM fallback is a path that is actually executed rather than hoped for. No ONNX, no
 * GPU, no weights -- which is the point of `OrtRuntime` being an interface.
 *
 * Not a *.test.ts file so both suites can import it.
 */

import type {
  Backend,
  HostInfo,
  LoadedModel,
  ModelSession,
  OrtRuntime,
  TensorLike,
} from './host';

export interface FakeRuntimeOptions {
  info?: Partial<HostInfo>;
  /** Model file sizes, keyed by path. Anything unlisted weighs 1 MB. */
  bytes?: Record<string, number>;
  /** Make WebGPU session creation fail, the way an unimplemented op does. */
  failWebgpu?: boolean;
  /** Make every load fail, whatever the backend. */
  failAll?: boolean;
  /** Resolve loads only when the returned release function is called. */
  manualLoads?: boolean;
}

export interface FakeRuntime extends OrtRuntime {
  readonly loads: Array<{ path: string; backend: Backend }>;
  readonly disposals: string[];
  readonly runs: number;
  /** Release one pending load, when manualLoads is on. */
  finishLoad(path: string): void;
  live(): number;
}

export function createFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  const loads: Array<{ path: string; backend: Backend }> = [];
  const disposals: string[] = [];
  const pending = new Map<string, () => void>();
  let runs = 0;
  let live = 0;

  const info: HostInfo = {
    backend: 'webgpu',
    f16: true,
    limits: { maxBufferSize: 268_435_456 },
    threads: 1,
    ...options.info,
  };

  function makeSession(path: string): ModelSession {
    live += 1;
    return {
      inputNames: ['input'],
      outputNames: ['output'],
      async run(): Promise<Record<string, TensorLike>> {
        runs += 1;
        return { output: { type: 'float32', dims: [1, 8], data: new Float32Array(8) } };
      },
      async dispose(): Promise<void> {
        live -= 1;
        disposals.push(path);
      },
    };
  }

  const runtime: FakeRuntime = {
    get loads() {
      return loads;
    },
    get disposals() {
      return disposals;
    },
    get runs() {
      return runs;
    },
    live: () => live,

    finishLoad(path: string) {
      pending.get(path)?.();
      pending.delete(path);
    },

    async init(): Promise<HostInfo> {
      return info;
    },

    async loadModel(path: string, backend: Backend): Promise<LoadedModel> {
      loads.push({ path, backend });
      if (options.failAll) throw new Error(`fake: ${path} cannot load`);
      if (options.failWebgpu && backend === 'webgpu') {
        throw new Error('fake: webgpu session creation failed (unsupported op)');
      }

      if (options.manualLoads) {
        await new Promise<void>((resolve) => pending.set(path, resolve));
      }
      return { session: makeSession(path), bytes: options.bytes?.[path] ?? 1_000_000 };
    },

    async loadJson<T>(path: string): Promise<T> {
      return { path } as unknown as T;
    },

    async loadText(path: string): Promise<string> {
      return path;
    },

    tensor(type: string, data: ArrayLike<number>, dims: number[]): TensorLike {
      return { type, dims, data: Float32Array.from(data) };
    },
  };

  return runtime;
}

/** A Scheduler backed by a number you move by hand. */
export function createFakeScheduler(startAt = 0): {
  now(): number;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(handle: number): void;
  /** Move the clock and fire anything due. Returns how many timers fired. */
  advance(ms: number): number;
  pending(): number;
} {
  let clock = startAt;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();

  return {
    now: () => clock,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
    advance(ms) {
      clock += ms;
      let fired = 0;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) {
          timers.delete(id);
          timer.fn();
          fired += 1;
        }
      }
      return fired;
    },
    pending: () => timers.size,
  };
}
