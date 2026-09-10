/**
 * Tier 1, and every way it is allowed to decline.
 *
 * Unavailable is a normal outcome, not a failure: Ollama not running, no model pulled, a
 * request that takes too long. All of them fall through to Tier 2 rather than throwing.
 *
 * They used to be indistinguishable -- every one returned `null`, on the reasoning that the
 * caller does the same thing with each. That reasoning was wrong, and it hid something for
 * months: Ollama answers a `chrome-extension://` origin with 403, so Tier 1 had never once
 * run in a real browser, and every step log said "tier 1 declined" as though a model had
 * looked at the question. The caller does still do the same thing with each; the *operator*
 * does not, and they are the one reading the log.
 */

import { describe, it, expect } from 'vitest';
import { describeLocalFailure, pickCandidate, readGoal, type LocalDeps } from './local';
import type { Candidate } from './resolve';

const CANDIDATES: Candidate[] = [
  { index: 3, score: 8, label: 'Alternate email', role: 'textbox' },
  { index: 5, score: 8, label: 'Work email', role: 'textbox' },
];

function reply(content: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    { status: 200 },
  );
}

function deps(over: Partial<LocalDeps> = {}): LocalDeps {
  return { fetch: async () => reply({ index: 5 }), ...over };
}

describe('breaking a tie', () => {
  it('returns the index the model picked', async () => {
    expect(await pickCandidate('fill my work email', CANDIDATES, deps())).toEqual({
      ok: true,
      value: 5,
      model: 'qwen2.5:1.5b',
    });
  });

  it('sends the sentence and the shortlist, and asks for one number', async () => {
    let body = '';
    await pickCandidate('fill my work email with x@y.in', CANDIDATES, {
      fetch: async (_url, init) => {
        body = String((init as RequestInit).body);
        return reply({ index: 3 });
      },
    });

    expect(body).toContain('fill my work email with x@y.in');
    expect(body).toContain('Alternate email');
    expect(body).toContain('Work email');
    // One index, enforced rather than requested: a model told to "reply with a number"
    // replies with a sentence containing one often enough to matter.
    expect(body).toContain('json_schema');
  });
});

describe('declining', () => {
  it('refuses an index it never offered', async () => {
    // A model answering with a number nobody put in front of it has not chosen, it has
    // invented -- and acting on that types into whatever element holds that index.
    expect(
      await pickCandidate('x', CANDIDATES, deps({ fetch: async () => reply({ index: 9 }) })),
    ).toEqual({ ok: false, why: 'bad-answer', model: 'qwen2.5:1.5b' });
  });

  it('gives up when nothing is listening', async () => {
    const dead: LocalDeps = {
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    };
    // Not merely "no": *which* no. This is the distinction that revealed Tier 1 had
    // never run in a browser, where the answer is 403 rather than a dead socket.
    expect(await pickCandidate('x', CANDIDATES, dead)).toEqual({
      ok: false,
      why: 'unreachable',
      model: 'qwen2.5:1.5b',
    });
  });

  it('gives up on an error status', async () => {
    const missing: LocalDeps = {
      fetch: async () => new Response('no such model', { status: 404 }),
    };
    expect(await pickCandidate('x', CANDIDATES, missing)).toEqual({
      ok: false,
      why: 'no-model',
      model: 'qwen2.5:1.5b',
    });
  });

  it('gives up on a reply that is not JSON', async () => {
    const prose: LocalDeps = {
      fetch: async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'the second one' } }] }),
          {
            status: 200,
          },
        ),
    };
    expect(await pickCandidate('x', CANDIDATES, prose)).toEqual({
      ok: false,
      why: 'unreachable',
      model: 'qwen2.5:1.5b',
    });
  });

  it('gives up rather than waiting, because a tie-break has a budget', async () => {
    const slow: LocalDeps = {
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    };
    expect(await pickCandidate('x', CANDIDATES, slow)).toEqual({
      ok: false,
      why: 'timeout',
      model: 'qwen2.5:1.5b',
    });
  });

  it('does not call out at all with nothing to choose between', async () => {
    let calls = 0;
    await pickCandidate('x', [], {
      fetch: async () => {
        calls += 1;
        return reply({ index: 1 });
      },
    });
    expect(calls).toBe(0);
  });
});

describe('the 403 nobody was seeing', () => {
  /**
   * Ollama's CORS allowlist does not include a browser-extension origin, so every call from
   * the service worker came back 403 and every one of them was reported as "tier 1
   * declined" -- a rung that had never run, described as a rung that had considered the
   * question and passed.
   */
  it('names a refused origin as its own kind of failure', async () => {
    const refused: LocalDeps = {
      fetch: (async () => new Response('', { status: 403 })) as unknown as typeof fetch,
    };
    expect(await pickCandidate('x', CANDIDATES, refused)).toEqual({
      ok: false,
      why: 'forbidden',
      model: 'qwen2.5:1.5b',
    });
    expect(describeLocalFailure('forbidden')).toContain('OLLAMA_ORIGINS');
  });

  it('has an operator-facing sentence for every failure', () => {
    for (const why of [
      'unreachable',
      'forbidden',
      'no-model',
      'timeout',
      'bad-answer',
    ] as const) {
      expect(describeLocalFailure(why).length).toBeGreaterThan(20);
    }
  });
});

describe('normalizing a goal', () => {
  it('returns rewritten standard clauses from the local model', async () => {
    const mock = {
      fetch: async () => reply({ normalized: 'fill first name with dilip, fill last name with reddymalla' }),
    };
    const outcome = await (await import('./local')).normalizeGoal('my first name is dilip and surname reddymalla', CANDIDATES, mock);
    expect(outcome).toEqual({
      ok: true,
      value: 'fill first name with dilip, fill last name with reddymalla',
      model: 'qwen2.5:1.5b',
    });
  });

  it('handles unreachable or malformed responses gracefully', async () => {
    const dead: LocalDeps = {
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    };
    const outcome = await (await import('./local')).normalizeGoal('my first name is dilip', CANDIDATES, dead);
    expect(outcome.ok).toBe(false);
  });
});

describe('what the reader is told is already done', () => {
  const FIELDS: Candidate[] = [
    { index: 1, score: 8, label: 'From station', role: 'searchbox' },
    { index: 2, score: 8, label: 'Flexible With Date', role: 'checkbox' },
  ];

  async function promptFor(done: string[]): Promise<string> {
    let body = '';
    await readGoal(
      'fill from with NEW DELHI, click flexible with date',
      FIELDS,
      {
        fetch: async (_url, init) => {
          body = String((init as RequestInit).body);
          return reply([]);
        },
      },
      undefined,
      done,
    );
    return body;
  }

  /**
   * The irctc.co.in defect: the same sentence, the same page, the same answer every step.
   * The origin was re-typed three steps running and a ticked checkbox was clicked again,
   * which unticked it.
   */
  it('lists the verified work and forbids repeating it', async () => {
    const body = await promptFor(['filled "from"', 'clicked "flexible with date"']);
    expect(body).toContain('Already done on this page');
    expect(body).toContain('filled ');
    expect(body).toContain('flexible with date');
    expect(body).toContain('Do not repeat anything listed as already done');
  });

  it('says nothing at all when nothing has been verified', async () => {
    expect(await promptFor([])).not.toContain('Already done');
  });
});
