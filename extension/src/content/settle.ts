/**
 * "The page stopped changing." That is the only clock this project has.
 *
 * A MutationObserver plus a quiet timer, not a poll (CLAUDE.md invariant 7): between
 * mutations nothing runs, so a page the agent is not working on costs nothing. The
 * timer restarts on every mutation and fires once the DOM has been still for
 * `quietMs`; a page that mutates forever -- a ticker, a spinner -- never settles, which
 * is the correct answer rather than a reason to add a poll.
 */

export const SETTLE_QUIET_MS = 250;

/**
 * How many batches of mutations this page has seen.
 *
 * The capture token carries it (shared/frames.ts), which is how the worker notices
 * that the DOM changed between measuring the boxes and photographing the page --
 * a change that moves nothing measurable, like a lazy image swapping in at the same
 * size, still invalidates the element list.
 *
 * Module-level, because there is one document per content script.
 */
let mutations = 0;

export function mutationSeq(): number {
  return mutations;
}

/** Exported for tests; the observer is the only thing that should call this. */
export function bumpMutationSeq(): number {
  mutations += 1;
  return mutations;
}

export interface SettleOptions {
  quietMs?: number;
  onSettle: () => void;
}

export interface SettleWatch {
  /** Stop watching. Call it when the agent loses interest in this page. */
  stop(): void;
  /**
   * Start the quiet timer as though a mutation had just happened.
   *
   * This is what an action completing looks like from here, and it closes a hole the
   * observer cannot see. `type` sets `input.value`, which is a *property*: no attribute
   * changes, no node is added, and a MutationObserver watching childList, attributes and
   * characterData is told nothing at all. So the most common action in the project
   * produced no settle, no next step, and a session that sat at `running` for ever with
   * a log line saying the step had succeeded.
   *
   * Not a poll and not a second clock: it arms the same one-shot the observer arms, and
   * any mutation the action does provoke restarts it in the usual way -- so a click that
   * opens a dialog still perceives after the dialog is there rather than during it.
   */
  nudge(): void;
}

/** Start watching. */
export function observeSettle(target: Node, options: SettleOptions): SettleWatch {
  const quietMs = options.quietMs ?? SETTLE_QUIET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function arm(): void {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      options.onSettle();
    }, quietMs);
  }

  const observer = new MutationObserver(() => {
    // Every batch counts, not only the ones that settle: a page mutating continuously
    // never settles, and its token must still keep moving.
    bumpMutationSeq();
    arm();
  });

  observer.observe(target, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });

  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      observer.disconnect();
    },
    nudge: arm,
  };
}
