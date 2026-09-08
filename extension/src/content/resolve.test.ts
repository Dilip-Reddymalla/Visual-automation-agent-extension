/**
 * The session-lost boundary.
 *
 * Every case here is about one question: when the executor asks what a token stands for
 * and does not get a value, does it learn whose fault that was? The answer decides
 * whether one action is refused or the whole step ends, and before the catch in
 * resolve.ts the absent-host case gave neither answer -- it threw.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resetBus,
  setBusTransport,
  type BusTransport,
  type Envelope,
  type Reply,
} from '../shared/messages';
import { resolveThroughOffscreen } from './resolve';

/** What each message type does this time. A function per type, called in order. */
type Script = Partial<Record<string, Array<() => Reply | Promise<Reply>>>>;

function install(script: Script): { sent: string[] } {
  const sent: string[] = [];
  const cursor = new Map<string, number>();

  const transport: BusTransport = {
    async post(envelope: Envelope): Promise<Reply> {
      sent.push(envelope.type);
      const steps = script[envelope.type];
      if (!steps) throw new Error(`no script for ${envelope.type}`);
      const at = cursor.get(envelope.type) ?? 0;
      cursor.set(envelope.type, at + 1);
      const step = steps[Math.min(at, steps.length - 1)];
      if (!step) throw new Error(`script for ${envelope.type} ran out`);
      return await step();
    },
    listen() {
      return () => undefined;
    },
  };

  setBusTransport(transport, 'content');
  return { sent };
}

const ok = (result: unknown) => (): Reply =>
  ({ id: 'r', ok: true, result }) as unknown as Reply;

/** What an absent offscreen document actually looks like: the post never resolves. */
const transportFailure = () => (): Promise<Reply> =>
  Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));

afterEach(() => {
  resetBus();
  vi.restoreAllMocks();
});

describe('resolveThroughOffscreen', () => {
  it('returns the value when the host answers', async () => {
    install({ PLACEHOLDER_RESOLVE: [ok({ value: 'asha.menon@example.in' })] });

    await expect(resolveThroughOffscreen('s1', '«EMAIL_1»')).resolves.toEqual({
      ok: true,
      value: 'asha.menon@example.in',
    });
  });

  it('reports an invented token as the planner’s fault, and does not touch the host', async () => {
    const { sent } = install({
      PLACEHOLDER_RESOLVE: [ok({ reason: 'unknown-placeholder' })],
    });

    await expect(resolveThroughOffscreen('s1', '«PERSON_9»')).resolves.toEqual({
      ok: false,
      reason: 'unknown-placeholder',
    });
    // A live host that says "I never issued that" is an answer. Resurrecting it would
    // throw away the very map that just gave the answer.
    expect(sent).toEqual(['PLACEHOLDER_RESOLVE']);
  });

  it('passes through a session-lost the host reports itself', async () => {
    install({ PLACEHOLDER_RESOLVE: [ok({ reason: 'session-lost' })] });

    await expect(resolveThroughOffscreen('s1', '«EMAIL_1»')).resolves.toEqual({
      ok: false,
      reason: 'session-lost',
    });
  });

  it('does not throw when the offscreen document is absent -- it says session-lost', async () => {
    install({
      PLACEHOLDER_RESOLVE: [transportFailure(), transportFailure()],
      HOST_ENSURE: [ok({ ready: true })],
    });

    // The regression. Before the catch this rejected with a bus transport error, so the
    // executor never raised StepEndingRejection and the distinction was lost at exactly
    // the boundary it exists for.
    await expect(resolveThroughOffscreen('s1', '«EMAIL_1»')).resolves.toEqual({
      ok: false,
      reason: 'session-lost',
    });
  });

  it('brings the host up and retries once, succeeding on the second ask', async () => {
    const { sent } = install({
      PLACEHOLDER_RESOLVE: [transportFailure(), ok({ value: '9845012345' })],
      HOST_ENSURE: [ok({ ready: true })],
    });

    await expect(resolveThroughOffscreen('s1', '«PHONE_1»')).resolves.toEqual({
      ok: true,
      value: '9845012345',
    });
    expect(sent).toEqual(['PLACEHOLDER_RESOLVE', 'HOST_ENSURE', 'PLACEHOLDER_RESOLVE']);
  });

  it('retries exactly once, never twice', async () => {
    const { sent } = install({
      PLACEHOLDER_RESOLVE: [transportFailure(), transportFailure(), transportFailure()],
      HOST_ENSURE: [ok({ ready: true })],
    });

    await resolveThroughOffscreen('s1', '«EMAIL_1»');
    expect(sent.filter((t) => t === 'PLACEHOLDER_RESOLVE')).toHaveLength(2);
    expect(sent.filter((t) => t === 'HOST_ENSURE')).toHaveLength(1);
  });

  it('reports session-lost when the host cannot be brought up at all', async () => {
    const { sent } = install({
      PLACEHOLDER_RESOLVE: [transportFailure()],
      HOST_ENSURE: [transportFailure()],
    });

    await expect(resolveThroughOffscreen('s1', '«EMAIL_1»')).resolves.toEqual({
      ok: false,
      reason: 'session-lost',
    });
    // No second ask: there is nothing to ask.
    expect(sent).toEqual(['PLACEHOLDER_RESOLVE', 'HOST_ENSURE']);
  });

  it('calls a resurrected host’s empty map session-lost, not an invented token', async () => {
    install({
      PLACEHOLDER_RESOLVE: [transportFailure(), ok({ reason: 'unknown-placeholder' })],
      HOST_ENSURE: [ok({ ready: true })],
    });

    // A host we had to create has an empty allocator, so every token looks invented to
    // it. Blaming the planner for our own restart is the failure this guards.
    await expect(resolveThroughOffscreen('s1', '«AADHAAR_1»')).resolves.toEqual({
      ok: false,
      reason: 'session-lost',
    });
  });
});
