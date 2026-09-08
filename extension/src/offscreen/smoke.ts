/**
 * The backend probe: one forward pass through a 512-byte bundled model.
 *
 * This is the first milestone of M2 and the gating question for the whole project --
 * does WebGPU inference run inside an MV3 offscreen document on the machines this will
 * be demonstrated on? Run it on a machine nobody has tried yet, before anything else.
 *
 * It checks values, not just shapes. A backend that builds a session, runs, and returns
 * the wrong numbers is a real failure mode on immature GPU stacks, and a shape-only
 * assertion sails straight past it. The expected values come from
 * models/smoke.fixture.json, measured by scripts/make-smoke-model.py when the model was
 * generated -- so the fixture cannot drift from the weights.
 */

import type { SelfTestResult } from '../shared/messages';
import type { InferenceHost, ModelSession, OrtRuntime } from './host';

export const SMOKE_MODEL = 'models/smoke.onnx';
export const SMOKE_FIXTURE = 'models/smoke.fixture.json';

/** Absolute tolerance. f16 on some GPUs is good to about 1e-3; this is generous. */
const TOLERANCE = 5e-3;

export interface SmokeFixture {
  model: string;
  bytes: number;
  input: { name: string; dims: number[]; data: number[] };
  output: { name: string; dims: number[]; data: number[] };
}

export async function runSmokeTest(host: InferenceHost): Promise<SelfTestResult> {
  const info = await host.init();
  const runtime = host.runtime();
  const fixture = await runtime.loadJson<SmokeFixture>(SMOKE_FIXTURE);

  const { session, bytes } = await runtime.loadModel(SMOKE_MODEL, info.backend);
  const startedAt = performance.now();
  try {
    const output = await forward(runtime, session, fixture);
    const ms = performance.now() - startedAt;

    const dims = [...output.dims];
    const values = Array.from(output.data as ArrayLike<number> & Iterable<number>);
    const matchedFixture = closeEnough(values, fixture.output.data);

    // Acceptance criterion 1 is "tensor shape logged", so log it where a developer
    // opening the offscreen document's console will see it without asking.
    console.info(
      `[sih] smoke pass on ${info.backend}: ${fixture.input.dims.join('x')} -> ${dims.join('x')} ` +
        `in ${ms.toFixed(1)} ms (${bytes} B model, f16=${info.f16}, threads=${info.threads}, ` +
        `values ${matchedFixture ? 'match' : 'DO NOT match'} the fixture)`,
    );

    return {
      backend: info.backend,
      f16: info.f16,
      threads: info.threads,
      limits: info.limits,
      dims,
      ms: Math.round(ms * 100) / 100,
      matchedFixture,
      note: matchedFixture
        ? undefined
        : `expected [${fixture.output.data.join(', ')}], got [${values.map((v) => v.toFixed(4)).join(', ')}]`,
    };
  } finally {
    // The probe model is not left resident. Idle means idle.
    await session.dispose();
  }
}

async function forward(
  runtime: OrtRuntime,
  session: ModelSession,
  fixture: SmokeFixture,
): Promise<{ dims: readonly number[]; data: ArrayLike<number> }> {
  const input = runtime.tensor('float32', fixture.input.data, fixture.input.dims);
  const results = await session.run({ [fixture.input.name]: input });

  const output = results[fixture.output.name] ?? results[session.outputNames[0] ?? ''];
  if (!output) throw new Error('smoke: the model returned no output tensor');
  // The smoke model is float32 by construction; the int64 arm of TensorLike exists for
  // the transformer's token ids and cannot appear here.
  return { dims: output.dims, data: output.data as ArrayLike<number> };
}

function closeEnough(actual: number[], expected: number[]): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((value, i) => Math.abs(value - (expected[i] ?? NaN)) <= TOLERANCE);
}
