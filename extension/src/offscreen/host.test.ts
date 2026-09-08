import { describe, it, expect } from 'vitest';
import { createInferenceHost, DEFAULT_MODEL_PATHS } from './host';
import { createFakeRuntime, createFakeScheduler } from './fake-runtime';
import { IDLE_UNLOAD_MS } from './sessions';
import { runSmokeTest } from './smoke';
import type { SmokeFixture } from './smoke';

function host(options: Parameters<typeof createFakeRuntime>[0] = {}) {
  const runtime = createFakeRuntime(options);
  const scheduler = createFakeScheduler(1_000);
  return { runtime, scheduler, host: createInferenceHost({ runtime, scheduler }) };
}

describe('init', () => {
  it('probes the backend once, however many callers ask', async () => {
    let probes = 0;
    const runtime = createFakeRuntime();
    const wrapped = {
      ...runtime,
      async init() {
        probes += 1;
        return runtime.init();
      },
    };
    const h = createInferenceHost({ runtime: wrapped });

    const [a, b] = await Promise.all([h.init(), h.init()]);
    expect(a).toEqual(b);
    expect(probes).toBe(1);
  });

  it('reports what the probe found', async () => {
    const { host: h } = host({ info: { backend: 'wasm', f16: false, threads: 3 } });
    await expect(h.init()).resolves.toMatchObject({ backend: 'wasm', f16: false, threads: 3 });
  });
});

describe('stats', () => {
  it('says "none" before anything has run -- the honest pre-load answer', () => {
    const { host: h } = host();
    expect(h.stats()).toEqual({
      backend: 'none',
      residentBytes: 0,
      loaded: [],
      timings: {},
      residentByTask: {},
      threads: undefined,
    });
  });

  it('reports backend, resident bytes and per-task timings after one run', async () => {
    const { host: h } = host({ bytes: { [DEFAULT_MODEL_PATHS.ner]: 3_500 } });
    await h.withTask('ner', async (session) => session.run({}));

    const stats = h.stats();
    expect(stats.backend).toBe('webgpu');
    expect(stats.residentBytes).toBe(3_500);
    expect(stats.loaded).toEqual(['ner']);
    expect(stats.residentByTask).toEqual({ ner: 3_500 });
    expect(stats.timings.ner).toBeTypeOf('number');
    expect(stats.timings.ner).toBeGreaterThanOrEqual(0);
  });

  it('records the backend that actually ran, not the one that was hoped for', async () => {
    // A vision task: those are float and genuinely want the GPU, so they are the ones
    // that exercise the downgrade. NER never asks for it -- see below.
    const { host: h } = host({ failWebgpu: true });
    await h.withTask('ocr', async () => undefined);
    expect(h.stats().backend).toBe('wasm');
  });

  it('runs NER on WASM even when the GPU is available', async () => {
    // Not a preference. The checkpoint is int8, and WebGPU executes its integer graph
    // incorrectly: the session builds, inference returns, and every token comes back 'O'
    // with a confident logit. No error is raised anywhere, so the only symptom is a
    // layer that finds nothing while costing its full latency.
    const { host: h, runtime } = host();
    await h.withTask('ner', async () => undefined);
    expect(runtime.loads).toContainEqual({ path: 'models/ner.onnx', backend: 'wasm' });
  });
});

describe('withTask', () => {
  it('returns the borrowed session and gives it back', async () => {
    const { host: h, scheduler } = host();
    await h.withTask('ocr', async (session) => {
      expect(session.inputNames).toEqual(['input']);
    });
    // Released, so it is a sweep candidate and the timer is armed.
    expect(scheduler.pending()).toBe(1);
  });

  it('records a timing even when the task throws, and lets the error through', async () => {
    const { host: h } = host();
    await expect(
      h.withTask('face', async () => {
        throw new Error('bad tensor shape');
      }),
    ).rejects.toThrow(/bad tensor shape/);
    expect(h.timings().count('face')).toBe(1);
  });

  it('releases the session when the task throws', async () => {
    const { host: h, runtime, scheduler } = host();
    await h.withTask('ner', async () => undefined).catch(() => undefined);
    await h
      .withTask('ner', async () => {
        throw new Error('nope');
      })
      .catch(() => undefined);

    scheduler.advance(IDLE_UNLOAD_MS + 1);
    await Promise.resolve();
    await Promise.resolve();
    // A leaked refcount would have kept this resident forever.
    expect(runtime.live()).toBe(0);
  });
});

describe('unload and dispose', () => {
  it('frees bytes on demand', async () => {
    const { host: h } = host({ bytes: { [DEFAULT_MODEL_PATHS.ner]: 900 } });
    await h.withTask('ner', async () => undefined);
    await expect(h.unload('ner')).resolves.toBe(900);
    expect(h.residentBytes()).toBe(0);
  });

  it('unloads nothing when nothing was ever loaded', async () => {
    const { host: h } = host();
    await expect(h.unload('all')).resolves.toBe(0);
  });

  it('leaves no session and no timer behind', async () => {
    const { host: h, runtime, scheduler } = host();
    await h.withTask('ner', async () => undefined);
    await h.dispose();

    expect(runtime.live()).toBe(0);
    expect(scheduler.pending()).toBe(0);
    expect(h.stats().backend).toBe('none');
  });
});

describe('the smoke test', () => {
  const fixture: SmokeFixture = {
    model: 'smoke.onnx',
    bytes: 512,
    input: { name: 'input', dims: [1, 8], data: [0, 0, 0, 0, 0, 0, 0, 0] },
    output: { name: 'output', dims: [1, 8], data: [0, 0, 0, 0, 0, 0, 0, 0] },
  };

  function smokeRuntime(output: number[]) {
    const base = createFakeRuntime();
    return {
      ...base,
      async loadJson<T>(): Promise<T> {
        return fixture as unknown as T;
      },
      async loadModel(path: string, backend: 'webgpu' | 'wasm') {
        const loaded = await base.loadModel(path, backend);
        return {
          bytes: loaded.bytes,
          session: {
            ...loaded.session,
            async run() {
              return {
                output: { type: 'float32', dims: [1, 8], data: Float32Array.from(output) },
              };
            },
          },
        };
      },
    };
  }

  it('reports the shape and confirms the values', async () => {
    const runtime = smokeRuntime(fixture.output.data);
    const result = await runSmokeTest(createInferenceHost({ runtime }));

    expect(result.backend).toBe('webgpu');
    expect(result.dims).toEqual([1, 8]);
    expect(result.matchedFixture).toBe(true);
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it('fails a backend that runs but computes the wrong numbers', async () => {
    const wrong = [...fixture.output.data];
    wrong[0] = 42;
    const result = await runSmokeTest(createInferenceHost({ runtime: smokeRuntime(wrong) }));

    expect(result.matchedFixture).toBe(false);
    expect(result.note).toMatch(/expected/);
  });

  it('does not leave the probe model resident', async () => {
    const runtime = smokeRuntime(fixture.output.data);
    const h = createInferenceHost({ runtime });
    await runSmokeTest(h);
    expect(h.residentBytes()).toBe(0);
  });
});
