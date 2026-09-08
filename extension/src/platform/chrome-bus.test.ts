import { describe, it, expect, beforeEach } from 'vitest';
import { createChromeTransport, type MessagingApi } from './chrome-bus';
import type { Context, Envelope, Reply } from '../shared/messages';

/**
 * A fake extension hub: runtime.sendMessage fans out to every endpoint except the
 * sender, tabs.sendMessage goes to one tab, and a message nobody answers comes back
 * through `lastError` exactly the way Chrome does it. That last part is the whole
 * reason this test exists -- "the receiving end does not exist" is the failure the
 * popup hits every time the worker is asleep or the tab has no content script.
 */
type SendResponse = (reply?: unknown) => void;
type RuntimeListener = (
  message: unknown,
  sender: unknown,
  sendResponse: SendResponse,
) => boolean | undefined;

class Hub {
  private readonly pages = new Map<string, RuntimeListener[]>();
  private readonly tabs = new Map<number, RuntimeListener[]>();
  private error: { message?: string } | undefined;

  /** An extension page: worker, offscreen or popup. */
  pageApi(id: string): MessagingApi {
    this.pages.set(id, this.pages.get(id) ?? []);
    return this.api(id, undefined);
  }

  /** A content script in one tab. */
  tabApi(tabId: number): MessagingApi {
    this.tabs.set(tabId, this.tabs.get(tabId) ?? []);
    return this.api(`tab:${tabId}`, tabId);
  }

  private api(id: string, tabId: number | undefined): MessagingApi {
    const listeners = (): RuntimeListener[] =>
      tabId === undefined ? (this.pages.get(id) ?? []) : (this.tabs.get(tabId) ?? []);
    const currentError = (): { message?: string } | undefined => this.error;

    return {
      runtime: {
        sendMessage: (message, callback) => {
          const targets: RuntimeListener[] = [];
          for (const [pageId, ls] of this.pages) if (pageId !== id) targets.push(...ls);
          this.deliver(targets, message, callback);
        },
        onMessage: {
          addListener: (listener) => {
            listeners().push(listener);
          },
          removeListener: (listener) => {
            const ls = listeners();
            const at = ls.indexOf(listener);
            if (at >= 0) ls.splice(at, 1);
          },
        },
        get lastError() {
          return currentError();
        },
      },
      tabs: {
        sendMessage: (target, message, callback) => {
          this.deliver(this.tabs.get(target) ?? [], message, callback);
        },
      },
    };
  }

  private deliver(
    listeners: RuntimeListener[],
    message: unknown,
    callback: SendResponse,
  ): void {
    let answered = false;
    let kept = false;

    const sendResponse: SendResponse = (reply) => {
      if (answered) return;
      answered = true;
      this.error = undefined;
      callback(reply);
    };

    for (const listener of listeners) {
      if (listener(message, {}, sendResponse) === true) kept = true;
    }

    if (!kept && !answered) {
      queueMicrotask(() => {
        this.error = {
          message: 'Could not establish connection. Receiving end does not exist.',
        };
        callback(undefined);
        this.error = undefined;
      });
    }
  }
}

function envelope(to: Context, from: Context, tabId?: number): Envelope {
  return {
    id: `id-${to}-${Math.random().toString(36).slice(2, 6)}`,
    from,
    to,
    tabId,
    sentAt: Date.now(),
    type: 'PERCEIVE',
    payload: { reason: 'user' },
  };
}

function ok(e: Envelope): Reply {
  return { id: e.id, ok: true, result: { accepted: true, stepIndex: 0 } };
}

let hub: Hub;
beforeEach(() => {
  hub = new Hub();
});

describe('routing between extension pages', () => {
  it('delivers to the addressed page and nowhere else', async () => {
    const workerApi = hub.pageApi('worker');
    const offscreenApi = hub.pageApi('offscreen');
    const popupApi = hub.pageApi('popup');

    const worker = createChromeTransport('worker', { api: workerApi });
    const offscreen = createChromeTransport('offscreen', { api: offscreenApi });
    const popup = createChromeTransport('popup', { api: popupApi });

    const seen: Context[] = [];
    worker.listen(async (e) => {
      seen.push('worker');
      return ok(e);
    });
    offscreen.listen(async (e) => {
      seen.push('offscreen');
      return ok(e);
    });
    popup.listen(async () => {
      throw new Error('popup should not be asked');
    });

    await popup.post(envelope('worker', 'popup'));
    await popup.post(envelope('offscreen', 'popup'));

    expect(seen).toEqual(['worker', 'offscreen']);
  });

  it('reaches a content script only through tabs.sendMessage', async () => {
    const worker = createChromeTransport('worker', { api: hub.pageApi('worker') });
    const content = createChromeTransport('content', { api: hub.tabApi(42) });

    let sawTab = false;
    content.listen(async (e) => {
      sawTab = true;
      return ok(e);
    });

    const reply = await worker.post(envelope('content', 'worker', 42));
    expect(sawTab).toBe(true);
    expect(reply.ok).toBe(true);
  });

  it('fails clearly when a content envelope carries no tab', async () => {
    const worker = createChromeTransport('worker', { api: hub.pageApi('worker') });
    await expect(worker.post(envelope('content', 'worker'))).rejects.toThrow(
      /cannot reach a content script/,
    );
  });

  it('surfaces "receiving end does not exist" as a rejection', async () => {
    const popup = createChromeTransport('popup', { api: hub.pageApi('popup') });
    hub.pageApi('worker'); // exists, but never listens -- an asleep worker
    popup.listen(async (e) => ok(e));

    await expect(popup.post(envelope('worker', 'popup'))).rejects.toThrow(
      /Could not establish connection/,
    );
  });

  it('propagates a handler failure as a failed reply, not a dropped message', async () => {
    const worker = createChromeTransport('worker', { api: hub.pageApi('worker') });
    const popup = createChromeTransport('popup', { api: hub.pageApi('popup') });

    worker.listen(async () => {
      throw new Error('router exploded');
    });

    const reply = await popup.post(envelope('worker', 'popup'));
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.message).toMatch(/router exploded/);
  });
});

describe('accepts: the Firefox arrangement', () => {
  it('answers for a second context in-process instead of broadcasting', async () => {
    const api = hub.pageApi('worker');
    const background = createChromeTransport('worker', {
      api,
      accepts: ['worker', 'offscreen'],
    });

    const addressed: Context[] = [];
    background.listen(async (e) => {
      addressed.push(e.to);
      return ok(e);
    });

    // No offscreen document exists anywhere in this hub. It still resolves.
    const reply = await background.post(envelope('offscreen', 'worker'));
    expect(reply.ok).toBe(true);
    expect(addressed).toEqual(['offscreen']);
  });

  it('refuses to loop back before it is listening', async () => {
    const background = createChromeTransport('worker', {
      api: hub.pageApi('worker'),
      accepts: ['worker', 'offscreen'],
    });
    await expect(background.post(envelope('offscreen', 'worker'))).rejects.toThrow(
      /not listening yet/,
    );
  });
});
