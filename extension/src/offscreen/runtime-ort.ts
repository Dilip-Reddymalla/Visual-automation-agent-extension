/**
 * The only module in this project that imports onnxruntime-web.
 *
 * Everything above it talks to `OrtRuntime`, which is why host.ts and sessions.ts run
 * under Vitest with no browser, no GPU and no weights. It also means the day ORT's API
 * moves, one file moves.
 *
 * Three things happen here and nowhere else:
 *
 *   Backend probe. Ask for a GPUAdapter; if one comes back, WebGPU is the backend and
 *   we record whether it has shader-f16 and what its limits are. No adapter, no GPU
 *   path -- fall through to WASM. A session that fails to build on a GPU that *did*
 *   answer is handled a layer up, in sessions.ts.
 *
 *   WASM configuration. SIMD on, threads set to hardwareConcurrency - 1 -- but only if
 *   SharedArrayBuffer actually exists. Extension pages are not cross-origin isolated by
 *   default, so on Chrome this usually resolves to one thread. Asking for more threads
 *   than the platform can give is how ORT ends up throwing during session creation
 *   instead of during init, which is a far worse place to find out.
 *
 *   Model loading. Every path is resolved through the adapter's resourceUrl, which is
 *   chrome.runtime.getURL. A path with a scheme or a `..` is refused outright: CLAUDE.md
 *   invariant 4 says the extension makes no network request but the one sanitized POST,
 *   and this is the check that keeps a future module honest.
 */

import * as ort from 'onnxruntime-web';
import type {
  Backend,
  HostInfo,
  LoadedModel,
  ModelSession,
  OrtRuntime,
  TensorLike,
} from './host';

/** Where the ORT wasm binaries are copied to by build.mjs. */
const ORT_ASSET_DIR = 'ort/';

/** Limits worth recording; the rest of the adapter's list is noise for our purposes. */
const INTERESTING_LIMITS = [
  'maxBufferSize',
  'maxStorageBufferBindingSize',
  'maxComputeWorkgroupStorageSize',
  'maxComputeInvocationsPerWorkgroup',
  'maxTextureDimension2D',
] as const;

type GpuLike = {
  requestAdapter(options?: { powerPreference?: string }): Promise<GpuAdapterLike | null>;
};

type GpuAdapterLike = {
  features: { has(name: string): boolean };
  limits: Record<string, unknown>;
};

export interface OrtRuntimeOptions {
  /** chrome.runtime.getURL, injected by the adapter. */
  resourceUrl(path: string): string;
  /** Overridable for the GPU-disabled run of the suite (acceptance criterion 2). */
  forceBackend?: Backend;
}

function bundledPath(path: string): string {
  if (/^[a-z]+:/i.test(path) || path.includes('..') || path.startsWith('/')) {
    throw new Error(`host: refusing to load "${path}" -- models are bundled, never fetched`);
  }
  return path;
}

function threadBudget(): number {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 1;
  // Threads need SharedArrayBuffer, which needs cross-origin isolation. An MV3
  // extension page is not isolated unless it opts in, and offscreen documents cannot.
  const isolated =
    typeof SharedArrayBuffer !== 'undefined' &&
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  return isolated ? Math.max(1, cores - 1) : 1;
}

async function probeGpu(): Promise<{ f16: boolean; limits: Record<string, number> } | null> {
  const gpu = (globalThis.navigator as unknown as { gpu?: GpuLike } | undefined)?.gpu;
  if (!gpu) return null;

  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return null;

  const limits: Record<string, number> = {};
  for (const name of INTERESTING_LIMITS) {
    const value = adapter.limits[name];
    if (typeof value === 'number') limits[name] = value;
  }
  return { f16: adapter.features.has('shader-f16'), limits };
}

export function createOrtRuntime(options: OrtRuntimeOptions): OrtRuntime {
  const { resourceUrl } = options;
  let configured = false;

  function configureWasm(threads: number): void {
    if (configured) return;
    ort.env.wasm.wasmPaths = resourceUrl(ORT_ASSET_DIR);
    ort.env.wasm.numThreads = threads;
    // Proxying moves inference to a worker; the offscreen document is already off the
    // critical path, and a proxy worker is one more thing to keep alive while idle.
    ort.env.wasm.proxy = false;
    ort.env.logLevel = 'warning';
    configured = true;
  }

  return {
    async init(): Promise<HostInfo> {
      const threads = threadBudget();
      configureWasm(threads);

      if (options.forceBackend === 'wasm') {
        return { backend: 'wasm', f16: false, limits: {}, threads };
      }

      const gpu = await probeGpu().catch(() => null);
      if (!gpu) return { backend: 'wasm', f16: false, limits: {}, threads };
      return { backend: 'webgpu', f16: gpu.f16, limits: gpu.limits, threads };
    },

    async loadModel(path: string, backend: Backend): Promise<LoadedModel> {
      const url = resourceUrl(bundledPath(path));
      const response = await fetch(url);
      if (!response.ok) throw new Error(`host: ${path} is not bundled (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());

      const session = await ort.InferenceSession.create(bytes, {
        // One EP, deliberately: an implicit fallback inside ORT would hide exactly the
        // failure the smoke test is meant to surface. sessions.ts does the retry.
        executionProviders: [backend],
        graphOptimizationLevel: 'all',
      });

      return { session: wrapSession(session), bytes: bytes.byteLength };
    },

    async loadJson<T>(path: string): Promise<T> {
      const response = await fetch(resourceUrl(bundledPath(path)));
      if (!response.ok) throw new Error(`host: ${path} is not bundled (${response.status})`);
      return (await response.json()) as T;
    },

    async loadText(path: string): Promise<string> {
      const response = await fetch(resourceUrl(bundledPath(path)));
      if (!response.ok) throw new Error(`host: ${path} is not bundled (${response.status})`);
      return await response.text();
    },

    tensor(type: string, data: ArrayLike<number> | BigInt64Array, dims: number[]): TensorLike {
      // int64 is not a convenience: a transformer's input_ids are int64 and ORT rejects
      // anything else for them. Passing a plain {data, dims, type} object instead of a
      // real Tensor fails with "invalid data location", which reads like a WebGPU
      // problem and is not one.
      const typed =
        type === 'int64'
          ? data instanceof BigInt64Array
            ? data
            : BigInt64Array.from(Array.from(data as ArrayLike<number>, (n) => BigInt(n)))
          : type === 'float32'
            ? Float32Array.from(data as ArrayLike<number>)
            : Int32Array.from(data as ArrayLike<number>);
      return new ort.Tensor(type as 'float32', typed as never, dims) as unknown as TensorLike;
    },
  };
}

function wrapSession(session: ort.InferenceSession): ModelSession {
  return {
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    async run(feeds: Record<string, TensorLike>): Promise<Record<string, TensorLike>> {
      const result = await session.run(
        feeds as unknown as ort.InferenceSession.OnnxValueMapType,
      );
      return result as unknown as Record<string, TensorLike>;
    },
    async dispose(): Promise<void> {
      await session.release();
    },
  };
}
