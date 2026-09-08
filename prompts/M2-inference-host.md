# Prompt M2 — Inference host

> Depends on: M1. Owner: Models + Platform. Estimate: ~17 h.
> **This is the highest-risk module in the project. Build it second, not eighth.**

---

Read `CLAUDE.md`. You are implementing M2, the inference host: the single process that owns
every ONNX session. This module alone determines the client-resource score (20% of the
evaluation), and if WebGPU inference cannot run inside an extension on the target machines,
the whole plan changes — which is why it comes early.

## The constraint that shapes this module

Neither WebGPU nor the ONNX Runtime WASM backend exists in an MV3 service worker. Inference
must run in a document. Chrome gets an offscreen document; Firefox does not implement
`chrome.offscreen`, but its MV3 background is an event page with a real DOM, so the same
host module is imported there directly. Write the model code once, behind an interface.

## What to build

**`src/offscreen/host.ts`** — the interface and its implementation:

```ts
interface InferenceHost {
  init(): Promise<{ backend: 'webgpu' | 'wasm'; f16: boolean; limits: Record<string, number> }>;
  run<T extends TaskName>(task: T, input: TaskInput<T>): Promise<TaskOutput<T>>;
  unload(task: TaskName): Promise<void>;
  stats(): HostStats; // backend, resident bytes per task, timing ring buffer
}
```

**`src/offscreen/adapters/chrome.ts`** — creates the offscreen document:

```ts
await chrome.offscreen.createDocument({
  url: 'offscreen.html',
  reasons: ['WORKERS'],
  justification:
    'Runs on-device vision and PII models; WebGPU is unavailable in MV3 service workers.',
});
```

**`src/offscreen/adapters/firefox.ts`** — imports the host into the background event page.
No branching outside these two files.

**`src/offscreen/sessions.ts`** — the session registry. Keyed by task name, holding the ORT
session, its resident byte count, a reference count and a last-used timestamp. An idle timer
unloads any session untouched for 60 seconds. Everything unloads when the last agent tab
closes. Idle CPU and idle GPU memory must both reach zero — verify this, do not assume it.

**Backend selection** at init: request a `GPUAdapter`, record whether `shader-f16` is
present, and fall back to WASM with SIMD and `numThreads = max(1, hardwareConcurrency - 1)`.
Record which backend won; the HUD displays it and the eval report records it. The fallback
must be a tested code path — run the whole suite once with the GPU disabled.

**Transformers.js configuration:**

```ts
import { env } from '@huggingface/transformers';
env.allowRemoteModels = false;
env.localModelPath = chrome.runtime.getURL('models/');
env.backends.onnx.wasm.numThreads = Math.max(1, navigator.hardwareConcurrency - 1);
```

**Timing.** Every `run()` records its wall time into a ring buffer tagged by task. That
buffer is the sole source for the latency waterfall (M10) and the p50/p95 figures in the
report (M11). Do not add a second timing mechanism later.

## First milestone, before anything else

Get one forward pass working on WebGPU inside the offscreen document and log the output
tensor shape. Use any small bundled ONNX model. Stop and report if this does not work —
do not spend a day working around it.

## Acceptance criteria

1. One forward pass completes on WebGPU inside the offscreen document; tensor shape logged.
2. The same call succeeds on the WASM path with the GPU disabled.
3. `stats()` returns backend, resident model bytes and per-task timings after one run.
4. A session unloads 60 seconds after last use, observable in `stats()`.
5. With the extension loaded and no task running, CPU sits at ~0% and no model is resident.
6. Works identically in Chrome and Firefox with no branching outside `adapters/`.

## Do not

- Do not load any model at startup. Everything is lazy.
- Do not fetch a model from the network. `allowRemoteModels` stays false, always.
- Do not put model-specific pre/post-processing in this module — that belongs in
  `offscreen/tasks/*`, added by M5.

Commit as `M2: inference host`.
