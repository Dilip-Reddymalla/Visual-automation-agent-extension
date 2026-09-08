/**
 * The inference host: the one place that owns ONNX sessions, and the seam that keeps
 * Chrome offscreen documents and Firefox event pages interchangeable.
 *
 * The host does lifecycle and accounting -- loading, unloading, timing, backend
 * choice. It does not know what a model means. Model-specific pre- and
 * post-processing lives in offscreen/tasks/*, and the message shapes live in
 * offscreen/handlers.ts. That split is deliberate: M5 and M6 are written against it.
 *
 * Everything ONNX-flavoured arrives through the injected `OrtRuntime`, so this module
 * and sessions.ts are exercised in Node with no browser and no weights.
 */

import type { HostStats, InferTask } from '../shared/messages';
import { createSessionRegistry, type Scheduler, type SessionRegistry } from './sessions';
import { createTimingRing, type TimingRing } from './timings';

export type Backend = 'webgpu' | 'wasm';

/** What the backend probe found at init. The HUD shows it; the eval report records it. */
export interface HostInfo {
  backend: Backend;
  /** The GPU advertises shader-f16. Halves the bandwidth bill for the vision models. */
  f16: boolean;
  /** Adapter limits worth knowing before choosing a model size. */
  limits: Record<string, number>;
  /** WASM threads in use. 1 unless the page is cross-origin isolated -- see runtime-ort. */
  threads: number;
}

export interface TensorLike {
  readonly type: string;
  readonly dims: readonly number[];
  /**
   * BigInt64Array is here because a transformer's `input_ids` are int64 and ORT will not
   * take them as anything else. It is deliberately a union rather than a widening to
   * `ArrayLike<unknown>`: a task that reads a float output still gets numbers, and a task
   * that builds token ids has to say so.
   */
  readonly data: (ArrayLike<number> & Iterable<number>) | BigInt64Array;
}

export interface ModelSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, TensorLike>): Promise<Record<string, TensorLike>>;
  dispose(): Promise<void>;
}

export interface LoadedModel {
  session: ModelSession;
  /** Model file size. The honest, deterministic stand-in for resident bytes. */
  bytes: number;
}

/**
 * The ORT-shaped hole. runtime-ort.ts fills it in the browser; the tests fill it with
 * a fake that counts calls.
 */
export interface OrtRuntime {
  /** Probe the GPU, configure the WASM backend. Called once, lazily. */
  init(): Promise<HostInfo>;
  /** Load a bundled model. `path` is relative to the extension root, always. */
  loadModel(path: string, backend: Backend): Promise<LoadedModel>;
  /** Fetch a bundled JSON file (the smoke fixture). */
  loadJson<T>(path: string): Promise<T>;
  /** Fetch a bundled text file (such as the OCR charset). */
  loadText(path: string): Promise<string>;
  tensor(type: string, data: ArrayLike<number> | BigInt64Array, dims: number[]): TensorLike;
}

/** Where each task's weights live, relative to the extension root. */
export type ModelPaths = Record<InferTask, string>;

export const DEFAULT_MODEL_PATHS: ModelPaths = {
  ner: 'models/ner.onnx',
  face: 'models/face-yunet.onnx',
  ocr: 'models/ocr-det.onnx',
  ocrDet: 'models/ocr-det.onnx',
  ocrRec: 'models/ocr-rec.onnx',
};

export interface InferenceHost {
  /** Idempotent. The first call probes the backend; later ones return the same answer. */
  init(): Promise<HostInfo>;
  /**
   * Borrow a task's session, run something with it, and give it back -- with the wall
   * time recorded. Every model call in the project goes through this, which is why
   * there is exactly one timing mechanism (M10's waterfall, M11's p50/p95).
   */
  withTask<T>(task: InferTask, fn: (session: ModelSession) => Promise<T>): Promise<T>;
  unload(task: InferTask | 'all'): Promise<number>;
  stats(): HostStats;
  residentBytes(): number;
  /** The ring buffer behind `stats().timings`. M10 reads it for the waterfall. */
  timings(): TimingRing;
  /** For the smoke test and for M5's tasks: create input tensors. */
  runtime(): OrtRuntime;
  /** Drop everything, cancel every timer. Called when the host page goes away. */
  dispose(): Promise<void>;
}

export interface HostOptions {
  runtime: OrtRuntime;
  models?: ModelPaths;
  scheduler?: Scheduler;
  idleMs?: number;
}

const defaultScheduler: Scheduler = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimer: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};

export function createInferenceHost(options: HostOptions): InferenceHost {
  const { runtime } = options;
  const ring = createTimingRing();

  let info: HostInfo | null = null;
  let initialising: Promise<HostInfo> | null = null;
  let registry: SessionRegistry | null = null;

  async function ensureInit(): Promise<HostInfo> {
    if (info) return info;
    // Concurrent callers share one probe: two adapters is two GPU contexts.
    initialising ??= runtime.init().then((result) => {
      info = result;
      initialising = null;
      return result;
    });
    return initialising;
  }

  function ensureRegistry(backend: Backend): SessionRegistry {
    registry ??= createSessionRegistry({
      runtime,
      backend,
      models: options.models ?? DEFAULT_MODEL_PATHS,
      scheduler: options.scheduler ?? defaultScheduler,
      idleMs: options.idleMs,
      onBackendDowngrade: (to) => {
        // A GPU that advertises itself and then fails to build a session is exactly
        // what the fallback exists for. Record what actually ran.
        if (info) info = { ...info, backend: to };
      },
    });
    return registry;
  }

  return {
    init: ensureInit,

    async withTask<T>(task: InferTask, fn: (session: ModelSession) => Promise<T>): Promise<T> {
      const probed = await ensureInit();
      const sessions = ensureRegistry(probed.backend);
      const session = await sessions.acquire(task);
      const startedAt = performance.now();
      try {
        return await fn(session);
      } finally {
        ring.record(task, performance.now() - startedAt);
        sessions.release(task);
      }
    },

    async unload(task: InferTask | 'all'): Promise<number> {
      return registry ? registry.unload(task) : 0;
    },

    stats(): HostStats {
      const resident = registry?.resident() ?? [];
      return {
        backend: info ? info.backend : 'none',
        residentBytes: resident.reduce((sum, entry) => sum + entry.bytes, 0),
        loaded: resident.map((entry) => entry.task),
        timings: ring.latest(),
        residentByTask: Object.fromEntries(resident.map((e) => [e.task, e.bytes])),
        threads: info?.threads,
      };
    },

    residentBytes(): number {
      return registry?.residentBytes() ?? 0;
    },

    timings: () => ring,
    runtime: () => runtime,

    async dispose(): Promise<void> {
      await registry?.unload('all');
      registry?.stop();
      registry = null;
      info = null;
    },
  };
}
