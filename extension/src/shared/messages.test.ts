import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_TIMEOUT_MS,
  dispatch,
  handle,
  isEnvelope,
  notify,
  resetBus,
  send,
  setBusTransport,
  timeoutFor,
  type BusTransport,
  type Envelope,
  type Reply,
} from './messages';

/**
 * A loopback transport: whatever this context sends comes straight back to its own
 * handlers. Enough to exercise the envelope, the reply shape, the timeouts and the
 * error paths without a browser. The real chrome routing is tested separately, in
 * platform/chrome-bus.test.ts.
 */
function loopback(): BusTransport {
  let handler: ((e: Envelope) => Promise<Reply>) | null = null;
  return {
    async post(envelope) {
      if (!handler) throw new Error('loopback: nobody listening');
      return handler(envelope);
    },
    listen(h) {
      handler = h;
      return () => {
        handler = null;
      };
    },
  };
}

beforeEach(() => setBusTransport(loopback(), 'worker'));
afterEach(() => resetBus());

describe('send / handle', () => {
  it('round-trips a typed request and reply', async () => {
    handle('OVERLAY_TOGGLE', ({ show }) => ({ visible: show ?? true }));
    await expect(
      send('OVERLAY_TOGGLE', { show: true }, { to: 'content', tabId: 1 }),
    ).resolves.toEqual({ visible: true });
  });

  it('awaits async handlers', async () => {
    handle('RUN_TASK', async ({ goal }) => {
      await Promise.resolve();
      return { sessionId: `s-${goal.length}`, stepIndex: 0 };
    });
    await expect(send('RUN_TASK', { goal: 'renew', tabId: 3 })).resolves.toEqual({
      sessionId: 's-5',
      stepIndex: 0,
    });
  });

  it('rejects when no handler is registered', async () => {
    await expect(send('STOP', {})).rejects.toThrow(/no handler/);
  });

  it('turns a handler throw into a rejection, keeping the message', async () => {
    handle('CAPTURE', () => {
      throw new Error('tab is not capturable');
    });
    await expect(
      send('CAPTURE', { sessionId: 's' }, { to: 'content', tabId: 1 }),
    ).rejects.toThrow(/tab is not capturable/);
  });

  it('refuses a second handler for the same type', () => {
    handle('PERCEIVE', () => ({ accepted: false, stepIndex: 0 }));
    expect(() => handle('PERCEIVE', () => ({ accepted: false, stepIndex: 0 }))).toThrow(
      /already has a handler/,
    );
  });

  it('rejects when no transport is installed', async () => {
    resetBus();
    await expect(send('PERCEIVE', { reason: 'user' })).rejects.toThrow(/no transport/);
  });

  it('refuses to address a content script without a tab', async () => {
    handle('DOM_SNAPSHOT', () => {
      throw new Error('should never run');
    });
    await expect(send('DOM_SNAPSHOT', { sessionId: 's' }, { to: 'content' })).rejects.toThrow(
      /needs a tabId/,
    );
  });
});

describe('timeouts', () => {
  it('defaults to 5 s, and gives inference 30 s', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(5_000);
    expect(timeoutFor('PERCEIVE')).toBe(5_000);
    expect(timeoutFor('STOP')).toBe(5_000);
    expect(timeoutFor('INFER')).toBe(30_000);
    expect(timeoutFor('SEAL_AND_ENCODE')).toBe(30_000);
    expect(timeoutFor('DOM_SNAPSHOT')).toBe(10_000);
  });

  it('rejects rather than hanging', async () => {
    handle('HOST_STATS', () => new Promise(() => undefined) as never);
    await expect(send('HOST_STATS', {}, { to: 'offscreen', timeoutMs: 20 })).rejects.toThrow(
      /timed out after 20ms/,
    );
  });

  it('can be disabled per call', async () => {
    handle('HOST_STATS', async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { backend: 'none' as const, residentBytes: 0, loaded: [], timings: {} };
    });
    await expect(
      send('HOST_STATS', {}, { to: 'offscreen', timeoutMs: 0 }),
    ).resolves.toMatchObject({ backend: 'none' });
  });
});

describe('notify', () => {
  it('reports true when it lands', async () => {
    handle('STEP_EVENT', () => ({ ok: true as const }));
    await expect(
      notify(
        'STEP_EVENT',
        { sessionId: 's', stepIndex: 0, at: 1, kind: 'status' },
        { to: 'popup' },
      ),
    ).resolves.toBe(true);
  });

  it('swallows a missing receiver -- a closed popup is not an error', async () => {
    await expect(
      notify(
        'STEP_EVENT',
        { sessionId: 's', stepIndex: 0, at: 1, kind: 'status' },
        { to: 'popup' },
      ),
    ).resolves.toBe(false);
  });
});

describe('the envelope', () => {
  it('carries a unique id, a sender, a target and a timestamp', async () => {
    const seen: Envelope[] = [];
    handle('PERCEIVE', (_payload, envelope) => {
      seen.push(envelope);
      return { accepted: true, stepIndex: 0 };
    });

    await send('PERCEIVE', { reason: 'settle' });
    await send('PERCEIVE', { reason: 'user' }, { to: 'content', tabId: 7 });

    expect(seen).toHaveLength(2);
    const first = seen[0];
    const second = seen[1];
    if (!first || !second) throw new Error('missing envelope');

    expect(first.id).not.toBe(second.id);
    expect(first.from).toBe('worker');
    expect(first.to).toBe('worker');
    expect(first.type).toBe('PERCEIVE');
    expect(first.sentAt).toBeGreaterThan(0);
    expect(second.to).toBe('content');
    expect(second.tabId).toBe(7);
  });

  it('echoes the request id on the reply', async () => {
    handle('STOP', () => ({ stopped: true }));
    const reply = await dispatch({
      id: 'abc-123',
      from: 'popup',
      to: 'worker',
      sentAt: Date.now(),
      type: 'STOP',
      payload: {},
    });
    expect(reply.id).toBe('abc-123');
    expect(reply.ok).toBe(true);
  });

  it('reports an unhandled type as a failed reply, not a throw', async () => {
    const reply = await dispatch({
      id: 'z',
      from: 'popup',
      to: 'worker',
      sentAt: Date.now(),
      type: 'HOST_STATS',
      payload: {},
    });
    expect(reply.ok).toBe(false);
  });

  it('recognises its own envelopes and nothing else', () => {
    expect(isEnvelope({ id: 'a', type: 'STOP', from: 'popup' })).toBe(true);
    expect(isEnvelope({ hello: 'world' })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope('STOP')).toBe(false);
  });
});
