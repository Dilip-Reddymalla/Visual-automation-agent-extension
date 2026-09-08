import { describe, it, expect } from 'vitest';
import { memoryStore } from '../shared/store';
import {
  clearState,
  freshState,
  IDLE_STATE,
  loadState,
  saveState,
  STATE_KEY,
  updateState,
} from './state';

describe('loadState', () => {
  it('returns an idle state when there is nothing stored', async () => {
    expect(await loadState(memoryStore())).toEqual(IDLE_STATE);
  });

  it('does not hand out a shared log array', async () => {
    const a = await loadState(memoryStore());
    a.log.push({ stepIndex: 0, startedAt: 0, phase: 'idle' });
    expect((await loadState(memoryStore())).log).toEqual([]);
  });

  it('tolerates a record written by an older build', async () => {
    const store = memoryStore({ [STATE_KEY]: { sessionId: 's1', status: 'running' } });
    const state = await loadState(store);
    expect(state.sessionId).toBe('s1');
    expect(state.status).toBe('running');
    // Fields the old build never wrote come back with their defaults, not undefined.
    expect(state.log).toEqual([]);
    expect(state.stepIndex).toBe(0);
    expect(state.busy).toBe(false);
  });
});

describe('updateState', () => {
  it('reads, transforms and writes in one go', async () => {
    const store = memoryStore();
    await updateState(store, (s) => ({ ...s, goal: 'renew', status: 'running' }));
    expect((await loadState(store)).goal).toBe('renew');
  });

  it('always transforms what is actually stored, never a stale copy', async () => {
    const store = memoryStore();
    await saveState(store, { ...freshState(), stepIndex: 4 });
    const next = await updateState(store, (s) => ({ ...s, stepIndex: s.stepIndex + 1 }));
    expect(next.stepIndex).toBe(5);
  });
});

describe('watch', () => {
  it('fires on write, so the popup never has to poll', async () => {
    const store = memoryStore();
    const seen: number[] = [];
    const stop = store.watch<{ stepIndex: number }>(STATE_KEY, (v) => {
      if (v) seen.push(v.stepIndex);
    });

    await updateState(store, (s) => ({ ...s, stepIndex: 1 }));
    await updateState(store, (s) => ({ ...s, stepIndex: 2 }));
    stop();
    await updateState(store, (s) => ({ ...s, stepIndex: 3 }));

    expect(seen).toEqual([1, 2]);
  });
});

describe('clearState', () => {
  it('leaves nothing behind', async () => {
    const store = memoryStore();
    await saveState(store, { ...freshState(), goal: 'secret-ish goal' });
    await clearState(store);
    expect(await store.get(STATE_KEY)).toBeUndefined();
  });
});

/**
 * The race that left a session running on a page it had never looked at.
 *
 * `updateState` is a read-modify-write across two awaits. Two of them interleaving used
 * to lose one write completely -- and the pair that interleaved in practice were the
 * PERCEIVE a navigation raises and the `finish` of the step whose click caused it. The
 * result was `pendingPerceive: true` beside `busy: false`: the flag set by a handler that
 * had already been refused, and cleared-then-checked by a step that had already ended.
 * Neither side ran the next step.
 *
 * The store here delays its reads and writes, which is what a real storage area does and
 * what makes the interleaving certain rather than occasional.
 */
describe('concurrent mutations', () => {
  function slowStore() {
    const bag = new Map<string, unknown>();
    const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 1));
    return {
      async get<T>(key: string): Promise<T | undefined> {
        await tick();
        return bag.get(key) as T | undefined;
      },
      async set<T>(key: string, value: T): Promise<void> {
        await tick();
        bag.set(key, value);
      },
      async remove(key: string): Promise<void> {
        await tick();
        bag.delete(key);
      },
      watch(): () => void {
        return () => undefined;
      },
    };
  }

  it('does not lose a write made while another was in flight', async () => {
    const store = slowStore();
    await saveState(store, freshState());

    await Promise.all([
      updateState(store, (s) => ({ ...s, status: 'running' as const })),
      updateState(store, (s) => ({ ...s, pendingPerceive: true })),
    ]);

    const final = await loadState(store);
    expect(final.status).toBe('running');
    expect(final.pendingPerceive).toBe(true);
  });

  it('applies every mutation in a burst, not just the last one', async () => {
    const store = slowStore();
    await saveState(store, freshState());

    await Promise.all(
      Array.from({ length: 8 }, () =>
        updateState(store, (s) => ({ ...s, framesDiscarded: s.framesDiscarded + 1 })),
      ),
    );

    expect((await loadState(store)).framesDiscarded).toBe(8);
  });

  it('keeps serving later mutations after one throws', async () => {
    const store = slowStore();
    await saveState(store, freshState());

    await expect(
      updateState(store, () => {
        throw new Error('transform blew up');
      }),
    ).rejects.toThrow('transform blew up');

    await updateState(store, (s) => ({ ...s, goal: 'still works' }));
    expect((await loadState(store)).goal).toBe('still works');
  });
});
