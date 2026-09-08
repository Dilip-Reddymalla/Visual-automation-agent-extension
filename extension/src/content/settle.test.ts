/**
 * The settle watcher, and the hole that made the agent look broken.
 *
 * `observeSettle` is the loop's only clock. Invariant 7 names four events the loop may
 * advance on -- action completion, mutation-settle, navigation, a user command -- and
 * three of them were wired. Action completion was not, and the consequence was specific
 * rather than theoretical: `type` sets `input.value`, a property, so a MutationObserver
 * watching childList, attributes and characterData sees *nothing*. The most common
 * action in the project produced no settle, the loop never took another step, and the
 * popup showed a session at `running` whose last log line said `ok`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { observeSettle, SETTLE_QUIET_MS } from './settle';

let dom: JSDOM;

beforeEach(() => {
  vi.useFakeTimers();
  dom = new JSDOM('<!doctype html><body><input id="f" /><div id="host"></div></body>');
  // MutationObserver is on the JSDOM window, not on Node's global.
  globalThis.MutationObserver = dom.window.MutationObserver;
});

afterEach(() => {
  vi.useRealTimers();
});

/** The two nodes every test reaches for, without a non-null assertion each time. */
function host(): HTMLElement {
  return dom.window.document.getElementById('host') as HTMLElement;
}

function field(): HTMLInputElement {
  return dom.window.document.getElementById('f') as HTMLInputElement;
}

function watch() {
  const onSettle = vi.fn();
  const watcher = observeSettle(dom.window.document, { onSettle });
  return { onSettle, watcher };
}

describe('mutations', () => {
  it('settles once the DOM has been quiet for the window', async () => {
    const { onSettle } = watch();

    host().append(dom.window.document.createElement('p'));
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS + 10);

    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it('does not settle while the page keeps changing', async () => {
    const { onSettle } = watch();

    for (let i = 0; i < 5; i += 1) {
      host().append(dom.window.document.createElement('p'));
      await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS - 50);
    }

    expect(onSettle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS + 10);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });
});

describe('typing, which mutates nothing', () => {
  it('is invisible to the observer -- this is the bug, stated as a test', async () => {
    const { onSettle } = watch();

    field().value = 'asha.menon@example.in';
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS * 4);

    expect(onSettle).not.toHaveBeenCalled();
  });

  it('settles when the executor reports the action instead', async () => {
    const { onSettle, watcher } = watch();

    field().value = 'asha.menon@example.in';
    watcher.nudge();
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS + 10);

    expect(onSettle).toHaveBeenCalledTimes(1);
  });
});

describe('nudge is not a second clock', () => {
  it('yields to a page that does react, rather than perceiving mid-change', async () => {
    const { onSettle, watcher } = watch();

    // A click that opens a dialog: the action completes, then the page moves.
    watcher.nudge();
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS - 50);
    host().append(dom.window.document.createElement('dialog'));

    await vi.advanceTimersByTimeAsync(60);
    expect(onSettle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it('fires once for a burst of actions, not once each', async () => {
    const { onSettle, watcher } = watch();

    watcher.nudge();
    watcher.nudge();
    watcher.nudge();
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS + 10);

    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it('is inert after stop, so a detached page cannot wake the loop', async () => {
    const { onSettle, watcher } = watch();

    watcher.stop();
    watcher.nudge();
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS * 4);

    expect(onSettle).not.toHaveBeenCalled();
  });
});
