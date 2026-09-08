import { describe, it, expect } from 'vitest';
import {
  classify,
  createCaptureQueue,
  MIN_CAPTURE_INTERVAL_MS,
  CaptureError,
  type CaptureDeps,
} from './capture';

const EXPECTED = { width: 2560, height: 1440, scale: 2 };

/**
 * A fake clock that also fakes sleeping: `sleep` advances the clock instead of waiting,
 * so a test about a 500 ms rate limit runs in microseconds and still exercises the real
 * arithmetic.
 */
function harness(
  behaviour: (attempt: number) => Promise<string>,
  options: { maxRetries?: number } = {},
) {
  let clock = 10_000;
  let attempt = 0;
  const sleeps: number[] = [];

  const deps: CaptureDeps = {
    capture: () => {
      attempt += 1;
      return behaviour(attempt);
    },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    maxRetries: options.maxRetries,
  };

  return {
    queue: createCaptureQueue(deps),
    sleeps,
    attempts: () => attempt,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const ok = async () => 'data:image/jpeg;base64,AAA';

describe('coalescing', () => {
  it('turns a burst of ten requests into one capture', async () => {
    const h = harness(ok);
    const frames = await Promise.all(
      Array.from({ length: 10 }, () => h.queue.request(EXPECTED)),
    );

    expect(h.attempts()).toBe(1);
    expect(h.queue.stats()).toMatchObject({ captures: 1, coalesced: 9 });
    // Everyone gets the same frame, which is the point: ten mutations in 300 ms are
    // one page state.
    expect(new Set(frames).size).toBe(1);
  });

  it('rejects nobody in a burst', async () => {
    const h = harness(ok);
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () => h.queue.request(EXPECTED)),
    );
    expect(settled.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('captures again once the burst is over', async () => {
    const h = harness(ok);
    await h.queue.request(EXPECTED);
    h.advance(MIN_CAPTURE_INTERVAL_MS + 1);
    await h.queue.request(EXPECTED);
    expect(h.queue.stats().captures).toBe(2);
  });
});

describe('the rate limit', () => {
  it('waits out the cooldown rather than calling too soon', async () => {
    const h = harness(ok);
    await h.queue.request(EXPECTED);
    h.advance(100);
    await h.queue.request(EXPECTED);

    // 400 ms of the 500 ms window was left.
    expect(h.sleeps).toEqual([MIN_CAPTURE_INTERVAL_MS - 100]);
  });

  it('does not wait when the window has already passed', async () => {
    const h = harness(ok);
    await h.queue.request(EXPECTED);
    h.advance(MIN_CAPTURE_INTERVAL_MS + 50);
    await h.queue.request(EXPECTED);
    expect(h.sleeps).toEqual([]);
  });

  it("absorbs Chrome's limiter when it fires anyway", async () => {
    // Another extension can spend the browser-wide budget; the cooldown here cannot
    // prevent that, so the retry has to.
    const h = harness(async (attempt) => {
      if (attempt === 1)
        throw new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota exceeded');
      return 'data:image/jpeg;base64,BBB';
    });

    await expect(h.queue.request(EXPECTED)).resolves.toMatchObject({ kind: 'capture-tab' });
    expect(h.queue.stats().rateLimitRetries).toBe(1);
  });

  /**
   * Chrome says this around a navigation with no tab being dragged and no user present.
   * It lasted a frame or two and ended the whole session -- one run in three, on the
   * demo's own page-A-to-page-B transition.
   */
  it('waits out a tab strip that is mid-change', async () => {
    const h = harness(async (attempt) => {
      if (attempt === 1) {
        throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
      }
      return 'data:image/jpeg;base64,BBB';
    });

    await expect(h.queue.request(EXPECTED)).resolves.toMatchObject({ kind: 'capture-tab' });
    expect(h.queue.stats().rateLimitRetries).toBe(1);
  });

  it('gives up rather than retrying forever', async () => {
    const h = harness(
      async () => {
        throw new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
      },
      { maxRetries: 2 },
    );
    await expect(h.queue.request(EXPECTED)).rejects.toThrow(CaptureError);
    expect(h.attempts()).toBe(3); // the first, plus two retries
  });
});

describe('failure modes', () => {
  it('tells them apart', () => {
    expect(classify('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')).toBe('rate-limited');
    expect(classify("The 'activeTab' permission is not in effect")).toBe('permission-lost');
    expect(classify('Extension has not been invoked for the current page')).toBe('unknown');
    expect(classify('No tab with id 42')).toBe('tab-gone');
    expect(classify('The tab was discarded')).toBe('tab-gone');
    expect(classify('Tabs cannot be edited right now (user may be dragging a tab).')).toBe(
      'busy',
    );
    expect(classify('something else entirely')).toBe('unknown');
  });

  it('surfaces a lost activeTab as its own kind, not a generic failure', async () => {
    const h = harness(async () => {
      throw new Error("The 'activeTab' permission is not in effect");
    });
    await expect(h.queue.request(EXPECTED)).rejects.toMatchObject({ kind: 'permission-lost' });
  });

  /**
   * The first run in a fresh tab, and every run after a page load the operator did not
   * start. Chrome's own sentence names no remedy, and the remedy is one click.
   */
  it('tells the operator how to get the permission back', async () => {
    const h = harness(async () => {
      throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
    });
    await expect(h.queue.request(EXPECTED)).rejects.toThrow(/toolbar/);
    // Chrome's own words are kept alongside, not replaced.
    await expect(h.queue.request(EXPECTED)).rejects.toThrow(/activeTab/);
  });

  it('does not retry a lost tab', async () => {
    const h = harness(async () => {
      throw new Error('No tab with id 7');
    });
    await expect(h.queue.request(EXPECTED)).rejects.toMatchObject({ kind: 'tab-gone' });
    expect(h.attempts()).toBe(1);
  });

  it('lets the next request try again after a failure', async () => {
    const h = harness(async (attempt) => {
      if (attempt === 1) throw new Error('No tab with id 7');
      return 'data:image/jpeg;base64,CCC';
    });
    await expect(h.queue.request(EXPECTED)).rejects.toThrow();
    await expect(h.queue.request(EXPECTED)).resolves.toBeDefined();
  });
});

describe('the frame it hands back', () => {
  it('carries the expected geometry and the one data URL we did not choose', async () => {
    const h = harness(ok);
    const frame = await h.queue.request(EXPECTED);
    expect(frame).toEqual({
      kind: 'capture-tab',
      dataUrl: 'data:image/jpeg;base64,AAA',
      width: 2560,
      height: 1440,
      scale: 2,
    });
  });
});
