import { describe, it, expect } from 'vitest';
import { createSessionRegistry, IDLE_UNLOAD_MS } from './sessions';
import { createFakeRuntime, createFakeScheduler } from './fake-runtime';
import { DEFAULT_MODEL_PATHS } from './host';
import type { Backend } from './host';

function registry(
  options: {
    failWebgpu?: boolean;
    manualLoads?: boolean;
    bytes?: Record<string, number>;
    backend?: Backend;
    onDowngrade?: (to: Backend) => void;
  } = {},
) {
  const runtime = createFakeRuntime({
    failWebgpu: options.failWebgpu,
    manualLoads: options.manualLoads,
    bytes: options.bytes,
  });
  const scheduler = createFakeScheduler(1_000);
  const sessions = createSessionRegistry({
    runtime,
    backend: options.backend ?? 'webgpu',
    models: DEFAULT_MODEL_PATHS,
    scheduler,
    onBackendDowngrade: (to) => options.onDowngrade?.(to),
  });
  return { runtime, scheduler, sessions };
}

describe('lazy loading', () => {
  it('loads nothing until something is acquired', async () => {
    const { runtime, scheduler } = registry();
    expect(runtime.loads).toHaveLength(0);
    expect(scheduler.pending()).toBe(0);
  });

  it('loads a model once and reuses it', async () => {
    const { runtime, sessions } = registry();
    const first = await sessions.acquire('ner');
    sessions.release('ner');
    const second = await sessions.acquire('ner');

    expect(first).toBe(second);
    expect(runtime.loads).toHaveLength(1);
    expect(runtime.loads[0]?.path).toBe(DEFAULT_MODEL_PATHS.ner);
  });

  it('makes two simultaneous callers share one load', async () => {
    const { runtime, sessions } = registry({ manualLoads: true });
    const a = sessions.acquire('ocr');
    const b = sessions.acquire('ocr');
    runtime.finishLoad(DEFAULT_MODEL_PATHS.ocr);

    expect(await a).toBe(await b);
    expect(runtime.loads).toHaveLength(1);
  });

  it('accounts for resident bytes per task', async () => {
    const { sessions } = registry({
      bytes: { [DEFAULT_MODEL_PATHS.ner]: 4_000, [DEFAULT_MODEL_PATHS.ocr]: 6_000 },
    });
    await sessions.acquire('ner');
    await sessions.acquire('ocr');

    expect(sessions.residentBytes()).toBe(10_000);
    expect(
      sessions
        .resident()
        .map((e) => e.task)
        .sort(),
    ).toEqual(['ner', 'ocr']);
  });
});

describe('the WASM fallback', () => {
  it('retries on WASM when a WebGPU session will not build', async () => {
    const downgrades: Backend[] = [];
    const { runtime, sessions } = registry({
      failWebgpu: true,
      onDowngrade: (to) => downgrades.push(to),
    });

    await expect(sessions.acquire('face')).resolves.toBeDefined();
    expect(runtime.loads.map((l) => l.backend)).toEqual(['webgpu', 'wasm']);
    expect(downgrades).toEqual(['wasm']);
    expect(sessions.resident()[0]?.backend).toBe('wasm');
  });

  it('stops trying the GPU once it has failed', async () => {
    const { runtime, sessions } = registry({ failWebgpu: true });
    await sessions.acquire('ner');
    await sessions.acquire('ocr');
    // One wasted WebGPU attempt in total, not one per model.
    expect(runtime.loads.filter((l) => l.backend === 'webgpu')).toHaveLength(1);
  });

  it(`propagates a failure that is not the GPU's fault`, async () => {
    const runtime = createFakeRuntime({ failAll: true });
    const sessions = createSessionRegistry({
      runtime,
      backend: 'wasm',
      models: DEFAULT_MODEL_PATHS,
      scheduler: createFakeScheduler(),
    });
    await expect(sessions.acquire('ner')).rejects.toThrow(/cannot load/);
    expect(sessions.residentBytes()).toBe(0);
  });
});

describe('the idle sweep', () => {
  it('unloads a session 60 seconds after its last use', async () => {
    const { runtime, scheduler, sessions } = registry();
    await sessions.acquire('ner');
    sessions.release('ner');

    scheduler.advance(IDLE_UNLOAD_MS - 1);
    expect(sessions.residentBytes()).toBeGreaterThan(0);

    scheduler.advance(2);
    await Promise.resolve();
    await Promise.resolve();

    expect(sessions.resident()).toHaveLength(0);
    expect(runtime.disposals).toEqual([DEFAULT_MODEL_PATHS.ner]);
    expect(runtime.live()).toBe(0);
  });

  it('does not unload a session someone is still holding', async () => {
    const { sessions, scheduler } = registry();
    await sessions.acquire('ner'); // acquired twice, released once
    await sessions.acquire('ner');
    sessions.release('ner');

    expect(await sessions.sweepIdle(scheduler.now() + IDLE_UNLOAD_MS * 2)).toEqual([]);
    expect(sessions.resident()).toHaveLength(1);
  });

  it('restarts the clock on every use', async () => {
    const { sessions, scheduler } = registry();
    await sessions.acquire('ner');
    sessions.release('ner');

    scheduler.advance(IDLE_UNLOAD_MS - 10);
    await sessions.acquire('ner'); // touched again
    sessions.release('ner');

    scheduler.advance(20);
    await Promise.resolve();
    expect(sessions.resident()).toHaveLength(1);
  });

  it('keeps no timer alive once nothing is resident -- idle really is idle', async () => {
    const { scheduler, sessions } = registry();
    await sessions.acquire('ner');
    sessions.release('ner');
    expect(scheduler.pending()).toBe(1);

    scheduler.advance(IDLE_UNLOAD_MS + 1);
    await Promise.resolve();
    await Promise.resolve();

    expect(sessions.resident()).toHaveLength(0);
    expect(scheduler.pending()).toBe(0);
  });
});

describe('unload', () => {
  it('drops one task and reports the bytes it freed', async () => {
    const { sessions } = registry({ bytes: { [DEFAULT_MODEL_PATHS.ner]: 2_048 } });
    await sessions.acquire('ner');
    await expect(sessions.unload('ner')).resolves.toBe(2_048);
    expect(sessions.residentBytes()).toBe(0);
  });

  it('drops everything when the tab closes', async () => {
    const { runtime, sessions, scheduler } = registry();
    await sessions.acquire('ner');
    await sessions.acquire('ocr');

    await sessions.unload('all');
    expect(sessions.resident()).toHaveLength(0);
    expect(runtime.live()).toBe(0);
    expect(scheduler.pending()).toBe(0);
  });

  it('is a no-op for a task that was never loaded', async () => {
    const { sessions } = registry();
    await expect(sessions.unload('face')).resolves.toBe(0);
  });
});
