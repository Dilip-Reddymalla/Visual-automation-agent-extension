import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ENDPOINT,
  MAX_ATTEMPTS,
  parseResponse,
  postStep,
  TransportError,
} from './transport';
import { encode, seal } from '../redaction/gate';
import { checkerboard, createFakeBitmap, createFakeCanvas } from '../testing/fake-canvas';
import {
  placeholderText,
  describeAction,
  PROTECTED_IN_GOAL,
  UNPROTECTED_IN_GOAL,
} from './goal';
import { auditTrace, formatTrace, phaseTotals, record, startStep } from './trace';
import { frameKey, memoryFrameStore } from '../platform/frame-store';
import { PlaceholderAllocator } from '../shared/placeholders';
import type { Finding, StepRequest, Viewport } from '../shared/contract';

const VIEWPORT: Viewport = { w: 400, h: 300 };

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    cls: 'AADHAAR',
    box: { x: 40, y: 40, w: 80, h: 20 },
    layer: 'L1',
    confidence: 0.98,
    mode: 'mask',
    reason: 'verhoeff-ok',
    origin: 'page' as const,
    ...over,
  };
}

/** A real seal and encode, so the receipt under test is a real one. */
async function sealedPayload(findings: Finding[] = [finding()]) {
  const raw = createFakeBitmap(checkerboard(VIEWPORT.w, VIEWPORT.h));
  const sealed = await seal(raw, findings, {
    viewport: VIEWPORT,
    scale: 1,
    createCanvas: (w, h) => createFakeCanvas(w, h),
    now: () => 1_700_000_000_000,
  });
  const encoded = await encode(sealed);
  return { manifest: sealed.manifest, bytes: encoded.bytes, sha256: encoded.sha256 };
}

async function request(over: Partial<StepRequest> = {}): Promise<{
  request: StepRequest;
  bytes: Uint8Array;
}> {
  const payload = await sealedPayload();
  return {
    bytes: payload.bytes,
    request: {
      protocolVersion: 1,
      sessionId: 's1',
      stepIndex: 0,
      goal: 'apply for the scholarship',
      intents: [],
      origin: 'http://localhost:8080',
      title: 'Application',
      viewport: VIEWPORT,
      capture: {
        mime: 'image/webp',
        width: 400,
        height: 300,
        scale: 1,
        sha256: payload.sha256,
      },
      elements: [],
      manifest: payload.manifest,
      history: [],
      ...over,
    },
  };
}

function reply(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

const PLAN = {
  protocolVersion: 1,
  stepIndex: 0,
  rationale: 'The Aadhaar field is filled, so it does not need filling again.',
  actions: [{ type: 'click', index: 3 }],
  done: false,
};

describe('nothing is sent until the bytes match the manifest', () => {
  it('sends when they do', async () => {
    const { request: req, bytes } = await request();
    let calls = 0;
    const result = await postStep(req, bytes, {
      fetch: async () => {
        calls += 1;
        return reply(PLAN);
      },
    });

    expect(calls).toBe(1);
    expect(result.response.actions[0]).toEqual({ type: 'click', index: 3 });
  });

  it('refuses when the bytes are not the ones that were sealed', async () => {
    const { request: req } = await request();
    let calls = 0;

    await expect(
      postStep(req, new Uint8Array([9, 9, 9]), {
        fetch: async () => {
          calls += 1;
          return reply(PLAN);
        },
      }),
    ).rejects.toMatchObject({ kind: 'receipt-mismatch', retryable: false });

    // The point of the check is that it happens *before* the fetch.
    expect(calls).toBe(0);
  });

  it('refuses when the manifest was edited after sealing', async () => {
    const { request: req, bytes } = await request();
    const tampered = {
      ...req,
      manifest: {
        ...req.manifest,
        findings: req.manifest.findings.map((f) => ({ ...f, box: { ...f.box, w: 1 } })),
      },
    };

    let calls = 0;
    await expect(
      postStep(tampered, bytes, {
        fetch: async () => {
          calls += 1;
          return reply(PLAN);
        },
      }),
    ).rejects.toMatchObject({ kind: 'receipt-mismatch' });
    expect(calls).toBe(0);
  });
});

describe('validation', () => {
  it('refuses to send a body that fails our own schema', async () => {
    const { request: req, bytes } = await request();
    const broken = { ...req, sessionId: '' };
    let calls = 0;

    await expect(
      postStep(broken as StepRequest, bytes, {
        fetch: async () => {
          calls += 1;
          return reply(PLAN);
        },
      }),
    ).rejects.toMatchObject({ kind: 'invalid-request', retryable: false });
    expect(calls).toBe(0);
  });

  it('treats a malformed reply as retryable, not as a crash', async () => {
    // A model returning something that is nearly JSON is an ordinary Tuesday.
    const { request: req, bytes } = await request();
    let calls = 0;

    await expect(
      postStep(req, bytes, {
        fetch: async () => {
          calls += 1;
          return reply('{"actions": [', 200);
        },
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ kind: 'invalid-response', retryable: true });
    expect(calls).toBe(MAX_ATTEMPTS);
  });

  it('rejects a reply that is JSON but not a plan', async () => {
    expect(() => parseResponse('{"hello":"world"}')).toThrow(TransportError);
    expect(() => parseResponse('{"hello":"world"}')).toThrow(/failed validation/);
  });

  it('rejects a plan with no actions -- a step with nothing to do is a bug', () => {
    expect(() => parseResponse(JSON.stringify({ ...PLAN, actions: [] }))).toThrow(/validation/);
  });

  it('fills the defaults the schema declares', () => {
    const parsed = parseResponse(
      JSON.stringify({
        protocolVersion: 1,
        stepIndex: 0,
        actions: [{ type: 'click', index: 1 }],
      }),
    );
    expect(parsed.done).toBe(false);
    expect(parsed.rationale).toBe('');
  });
});

describe('retrying', () => {
  it('retries once on a network failure, then gives up', async () => {
    const { request: req, bytes } = await request();
    let calls = 0;
    const sleeps: number[] = [];

    await expect(
      postStep(req, bytes, {
        fetch: async () => {
          calls += 1;
          throw new Error('connection refused');
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toMatchObject({ kind: 'network' });

    expect(calls).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  it('names the endpoint in a network failure, so "Failed to fetch" is diagnosable', async () => {
    const { request: req, bytes } = await request();

    // What the browser actually throws when nothing is listening on the port. On its own
    // it says neither which address was tried nor that the server might be down, which is
    // exactly the dead end the first end-to-end run hit.
    await expect(
      postStep(req, bytes, {
        fetch: async () => {
          throw new TypeError('Failed to fetch');
        },
        endpoint: 'http://localhost:8000/v1/step',
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({
      kind: 'network',
      retryable: true,
      message: expect.stringContaining('http://localhost:8000/v1/step'),
      detail: { endpoint: 'http://localhost:8000/v1/step' },
    });
  });

  it('succeeds on the second attempt', async () => {
    const { request: req, bytes } = await request();
    let calls = 0;

    const result = await postStep(req, bytes, {
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new Error('connection refused');
        return reply(PLAN);
      },
      sleep: async () => undefined,
    });

    expect(result.attempts).toBe(2);
  });

  it('does not retry a 4xx -- the request is wrong, and will be wrong again', async () => {
    const { request: req, bytes } = await request();
    let calls = 0;

    await expect(
      postStep(req, bytes, {
        fetch: async () => {
          calls += 1;
          return reply('bad request', 400);
        },
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ kind: 'http-error', retryable: false });
    expect(calls).toBe(1);
  });

  it('does retry a 5xx', async () => {
    const { request: req, bytes } = await request();
    let calls = 0;

    await expect(
      postStep(req, bytes, {
        fetch: async () => {
          calls += 1;
          return reply('upstream died', 503);
        },
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ kind: 'http-error' });
    expect(calls).toBe(2);
  });

  it('stops immediately when the operator stopped the run', async () => {
    const { request: req, bytes } = await request();
    const stop = new AbortController();
    stop.abort();

    await expect(
      postStep(req, bytes, {
        signal: stop.signal,
        fetch: async () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        },
      }),
    ).rejects.toMatchObject({ kind: 'aborted', retryable: false });
  });

  /**
   * The two aborts are different events and must not be collapsed. Without the deadline
   * a planner that accepts the connection and never answers holds the plan phase open
   * for as long as the browser keeps the socket, which reads from the popup as a step
   * still working.
   */
  it('gives up on a planner that accepts the request and never answers', async () => {
    const { request: req, bytes } = await request();
    let calls = 0;

    await expect(
      postStep(req, bytes, {
        timeoutMs: 30,
        sleep: async () => undefined,
        fetch: (_url, init) => {
          calls += 1;
          return new Promise((_resolve, reject) => {
            const signal = (init as RequestInit).signal;
            signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          });
        },
      }),
    ).rejects.toMatchObject({ kind: 'network', retryable: true });

    // One attempt, not two: the budget covers the whole call, so an expired deadline is
    // not something a retry can be inside.
    expect(calls).toBe(1);
  });

  it('does not abort a planner that answers inside the budget', async () => {
    const { request: req, bytes } = await request();
    const result = await postStep(req, bytes, {
      timeoutMs: 5_000,
      fetch: async () => reply(PLAN),
    });
    expect(result.response.actions).toHaveLength(1);
  });

  it('posts to the local planner by default', () => {
    expect(DEFAULT_ENDPOINT).toMatch(/^http:\/\/localhost/);
  });
});

// ── The goal ──────────────────────────────────────────────────────────────────

describe('placeholdering the goal', () => {
  function allocator() {
    const a = new PlaceholderAllocator('s1');
    return (cls: Parameters<typeof a.allocate>[0], value: string) => a.allocate(cls, value);
  }

  it('replaces an identifier the operator typed', () => {
    // Without this, the picture is redacted and the sentence beside it is not.
    const result = placeholderText('apply using Aadhaar 7237 2429 6561 please', allocator());
    expect(result.text).toBe('apply using Aadhaar «AADHAAR_1» please');
    expect(result.substitutions[0]?.value).toBe('7237 2429 6561');
  });

  it('replaces several, without the offsets shifting under each other', () => {
    const result = placeholderText(
      'mail asha.menon@example.in or ring 9845012345',
      allocator(),
    );
    expect(result.text).toBe('mail «EMAIL_1» or ring «PHONE_1»');
  });

  it('gives the same value the same token', () => {
    const allocate = allocator();
    const a = placeholderText('card 4111111111111111', allocate);
    const b = placeholderText('the card 4111111111111111 again', allocate);
    expect(a.substitutions[0]?.placeholder).toBe(b.substitutions[0]?.placeholder);
  });

  it('leaves an ordinary goal alone', () => {
    const result = placeholderText('complete the scholarship application', allocator());
    expect(result.text).toBe('complete the scholarship application');
    expect(result.substitutions).toEqual([]);
  });

  /**
   * The claim in the panel has to match the mechanism, and the mechanism changed.
   *
   * A name in the task box is now caught -- not by shape, which a name does not have, but
   * by the field the sentence names: "fill first name with leo" says what "leo" is. What
   * is still not caught is a name mentioned in passing, and `placeholderText` alone is
   * exactly that path: shape rules only, no sentence parsed.
   */
  it('is honest about what it covers', () => {
    expect(PROTECTED_IN_GOAL).toContain('AADHAAR');
    // Listed, because the parser catches it when the sentence names the field.
    expect(PROTECTED_IN_GOAL).toContain('PERSON');
    // Not listed, because nothing catches an organisation in a sentence.
    expect(UNPROTECTED_IN_GOAL).toContain('ORG');

    // Shape rules alone cannot find a name, which is why the parser exists.
    const result = placeholderText('apply on behalf of Asha Menon', allocator());
    expect(result.text).toContain('Asha Menon');
  });
});

describe('history lines', () => {
  it('records a placeholder verbatim, because it is safe to', () => {
    expect(describeAction({ type: 'type', index: 6, text: '«EMAIL_1»' })).toBe(
      'type [6] «EMAIL_1»',
    );
  });

  it('describes anything else by shape, never by content', () => {
    expect(describeAction({ type: 'type', index: 6, text: 'hunter2' })).toBe(
      'type [6] 7 characters',
    );
  });

  it('summarises the other actions', () => {
    expect(describeAction({ type: 'click', index: 3 })).toBe('click [3]');
    expect(describeAction({ type: 'select', index: 2 })).toBe('select [2] an option');
    expect(describeAction({ type: 'key', key: 'Enter' })).toBe('key Enter');
  });
});

// ── The trace ─────────────────────────────────────────────────────────────────

describe('the trace line', () => {
  it('is one JSON object per step', () => {
    const trace = startStep('s1', 4, 1000);
    record(trace, 'perceive', 12);
    record(trace, 'capture', 40);

    const line = formatTrace(trace);
    expect(line).not.toContain('\n');
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.sessionId).toBe('s1');
    expect(parsed.stepIndex).toBe(4);
    expect(parsed.totalMs).toBe(52);
  });

  it('totals by phase, for the waterfall', () => {
    const trace = startStep('s1', 0);
    record(trace, 'perceive', 10);
    record(trace, 'perceive', 5);
    record(trace, 'seal', 30);
    expect(phaseTotals(trace)).toEqual({ perceive: 15, seal: 30 });
  });

  it('carries counts, not content', () => {
    const trace = startStep('s1', 0);
    trace.findings = {
      total: 3,
      byClass: { AADHAAR: 1, EMAIL: 2 },
      byLayer: { L0: 1, L1: 2 },
      byOrigin: { page: 2, agent: 1 },
    };
    trace.redaction = { redactedFraction: 0.12, overRedactedFraction: 0.03, ops: 3, kept: 1 };

    const line = formatTrace(trace);
    expect(line).toContain('"AADHAAR":1');
    expect(line).toContain('"overRedactedFraction":0.03');
  });

  it('catches a value that leaked into it', () => {
    // The trace ends up in screenshots. This is the last check before it is written.
    const trace = startStep('s1', 0);
    trace.error = 'failed on 7237 2429 6561';
    expect(auditTrace(trace, ['7237 2429 6561'])).toEqual(['7237 2429 6561']);
    expect(auditTrace(startStep('s1', 0), ['7237 2429 6561'])).toEqual([]);
  });
});

// ── The handoff ───────────────────────────────────────────────────────────────

describe('the frame handoff', () => {
  it('hands the bytes over once and then forgets them', async () => {
    const store = memoryFrameStore();
    const frame = {
      bytes: new Blob([new Uint8Array([1, 2, 3])]),
      sha256: 'a'.repeat(64),
      mime: 'image/webp',
      width: 10,
      height: 10,
      storedAt: 1000,
    };

    await store.put(frameKey('s1', 4), frame);
    expect(await store.take(frameKey('s1', 4))).toBeDefined();
    // A redacted frame is still a picture of the user's screen; it does not linger.
    expect(await store.take(frameKey('s1', 4))).toBeUndefined();
  });

  it('keys per step, so a retry cannot collide with what it is retrying', () => {
    expect(frameKey('s1', 4)).not.toBe(frameKey('s1', 5));
  });

  it('sweeps what a dead step left behind', async () => {
    const store = memoryFrameStore();
    const stale = {
      bytes: new Blob([]),
      sha256: 'a'.repeat(64),
      mime: 'image/webp',
      width: 1,
      height: 1,
      storedAt: 1000,
    };
    await store.put('old', stale);
    await store.put('new', { ...stale, storedAt: 9000 });

    expect(await store.sweep(5000)).toBe(1);
    expect(await store.take('new')).toBeDefined();
  });
});
