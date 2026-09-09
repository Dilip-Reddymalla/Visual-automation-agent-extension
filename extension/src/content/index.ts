/**
 * Content-script entry point.
 *
 * Owns the DOM: walks it, decides what is interactive, measures occlusion, executes
 * actions, and draws the operator overlay. It never encodes pixels and never talks to
 * the network -- it hands raw material to the offscreen document through the bus.
 *
 * Two things stay in this file and go nowhere else: the handle map, which is the only
 * place a live DOM node is held, and the previous step's keys, which are what makes the
 * `*` marker mean "new since last step" rather than "new since the worker last woke".
 */

import { createChromeTransport } from '../platform/chrome-bus';
import { handle, notify, setBusTransport } from '../shared/messages';
import type { ExecutionOutcome, VerifyReason } from '../shared/messages';
import {
  execute,
  rehydrate,
  setNativeValue,
  shapeOf,
  StepEndingRejection,
  type ExecutorEnv,
} from './executor';
import { formatValue } from './format';
import { resolveThroughOffscreen } from './resolve';
import { currentToken, measure, windowEnv } from './capture';
import { browserEnv, perceive, survey } from './perceive';
import { createOverlay } from './overlay';
import { mutationSeq, observeSettle, type SettleWatch } from './settle';
import { tokensMatch } from '../shared/frames';
import type { ObservedElement } from '../shared/observed';
import type { DomEl } from './walker';

/** Stop watching a page the worker has shown no interest in for this long. */
const IDLE_DETACH_MS = 60_000;

/**
 * index -> live node, for the executor. This never crosses a message boundary: a DOM
 * node is not serialisable, and if it were, sending one would hand another process a
 * handle on the page.
 */
let handles = new Map<number, DomEl>();

/**
 * Stable key to live node, from the last survey. Separate from `handles` on purpose.
 *
 * `handles` is what the executor acts through and is only ever written by a real
 * in-viewport walk. This map is only ever read by `REVEAL`, which scrolls. Keeping them
 * apart is what stops a whole-document sweep from becoming a way to act on things the
 * agent cannot see.
 */
let surveyNodes = new Map<string, DomEl>();
let previousKeys: ReadonlySet<string> = new Set();
let lastObserved: ObservedElement[] = [];

/**
 * Which walk the current handle map came from.
 *
 * A plain counter is not enough, and the reason is measured rather than supposed. A
 * navigation replaces the content script along with the document, so a counter living
 * up here restarts at zero -- page A's snapshot 1 and page B's snapshot 1 would be
 * indistinguishable, across exactly the boundary where a stale index is most dangerous.
 * In demo/NAVIGATION.md, 7 of 12 indices came to mean a *different* element after one
 * load: [3] went from a button to a text field, [4] from Email to Aadhaar. Those are
 * silent failures, not errors.
 *
 * So the id carries a nonce minted once per document. Two walks in the same document
 * differ by the counter; two documents differ whatever the counters say.
 */
const DOCUMENT_NONCE = documentNonce();
let snapshotCount = 0;
let snapshotId = `${DOCUMENT_NONCE}.0`;

function documentNonce(): string {
  const buffer = new Uint32Array(2);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (n) => n.toString(36)).join('');
}

let overlay: ReturnType<typeof createOverlay> | null = null;
let overlayVisible = false;
let settleWatch: SettleWatch | null = null;
let lastWorkerContact = 0;

/**
 * The observer attaches only after the worker has spoken to this tab, and detaches
 * again when it goes quiet. A page the agent never visits pays nothing at all.
 */
function noteWorkerContact(): void {
  lastWorkerContact = Date.now();
  if (settleWatch) return;

  settleWatch = observeSettle(document, {
    onSettle: () => {
      if (Date.now() - lastWorkerContact > IDLE_DETACH_MS) {
        settleWatch?.stop();
        settleWatch = null;
        return;
      }
      void notify('PERCEIVE', { reason: 'settle' });
    },
  });
}

/** The handle map for the executor. Local call only. */
export function handleFor(index: number): DomEl | undefined {
  return handles.get(index);
}

/** Which walk the current handles came from. Local call only. */
/**
 * What this node holds right now, as text.
 *
 * A `<select>` answers with the option's own text rather than its value, because that is
 * what the user asked for and what they will see. Anything without a value property
 * answers with its text content, which is what makes a verified `click` on a toggle
 * meaningful rather than merely attempted.
 */
function readValue(node: DomEl): string {
  const el = node as unknown as {
    value?: unknown;
    selectedOptions?: ArrayLike<{ text?: string }>;
    textContent?: string | null;
    tagName?: string;
  };

  if (el.tagName?.toLowerCase() === 'select') {
    const chosen = el.selectedOptions?.[0];
    return (chosen?.text ?? String(el.value ?? '')).trim();
  }
  if (typeof el.value === 'string') return el.value.trim();
  return (el.textContent ?? '').trim();
}

/**
 * One field, checked.
 *
 * Comparison is trimmed and case-insensitive. A page that upper-cases a PAN as you type has
 * done what it was asked, and reporting that as a mismatch would train an operator to
 * ignore the check -- which costs more than the handful of real mismatches it would catch.
 * A page that reformats more aggressively than case shows up as `differs`, which is
 * correct: something is in the field, and it is not what we asked for.
 */
async function verifyOne(
  sessionId: string,
  check: { index: number; text: string },
  stale: boolean,
): Promise<{ fulfilled: boolean; reason: VerifyReason }> {
  if (stale) return { fulfilled: false, reason: 'missing' };

  const node = handleFor(check.index);
  if (!node) return { fulfilled: false, reason: 'missing' };

  let expected: string;
  try {
    const filled = await rehydrate(check.text, {
      resolve: (placeholder) => resolveThroughOffscreen(sessionId, placeholder),
    });
    if (!filled.ok) return { fulfilled: false, reason: 'unresolved' };
    expected = filled.text.trim();
  } catch {
    // StepEndingRejection: the session map is gone, so there is nothing to compare to.
    return { fulfilled: false, reason: 'unresolved' };
  }

  // Compared against what was actually typed, which is the value *after* the field's own
  // format was applied to it. Checking the raw value instead would report `differs` on
  // every date the executor correctly reshaped -- the check accusing the fix of failing.
  const wanted = formatValue(expected, shapeOf(node)).text;

  const actual = readValue(node);
  if (!actual) return { fulfilled: false, reason: 'empty' };
  if (actual.toLowerCase() === wanted.toLowerCase()) {
    return { fulfilled: true, reason: 'match' };
  }
  const el = node as unknown as { value?: unknown; tagName?: string };
  if (
    el.tagName?.toLowerCase() === 'select' &&
    typeof el.value === 'string' &&
    el.value.trim().toLowerCase() === wanted.toLowerCase()
  ) {
    return { fulfilled: true, reason: 'match' };
  }
  return { fulfilled: false, reason: 'differs' };
}

export function currentSnapshotId(): string {
  return snapshotId;
}

function runPerceive(): ObservedElement[] {
  const env = browserEnv(document, window, previousKeys);
  const result = perceive(env);

  // Every walk replaces the handle map, so every walk invalidates the indices anyone is
  // holding. Bumping here rather than only in DOM_SNAPSHOT means an overlay redraw
  // invalidates a plan too -- conservative, and cheap: the step ends and we look again.
  snapshotCount += 1;
  snapshotId = `${DOCUMENT_NONCE}.${snapshotCount}`;

  handles = result.handles;
  previousKeys = result.keys;
  lastObserved = result.observed;

  if (overlayVisible) overlay?.draw(result.observed);
  return result.observed;
}

function setOverlay(visible: boolean): boolean {
  overlayVisible = visible;
  if (visible) {
    overlay ??= createOverlay(document);
    overlay.draw(lastObserved.length > 0 ? lastObserved : runPerceive());
  } else {
    overlay?.destroy();
    overlay = null;
  }
  return overlayVisible;
}

export function installHandlers(): void {
  handle('DOM_SNAPSHOT', () => {
    noteWorkerContact();
    const observed = runPerceive();
    return {
      elements: observed,
      snapshotId,
      viewport: {
        w: window.visualViewport?.width ?? window.innerWidth,
        h: window.visualViewport?.height ?? window.innerHeight,
      },
      origin: location.origin,
      title: document.title,
    };
  });

  handle('CAPTURE', () => {
    noteWorkerContact();
    return measure(windowEnv(window, document, mutationSeq()));
  });

  handle('GEOMETRY_CHECK', ({ token }) => {
    const current = currentToken(windowEnv(window, document, mutationSeq()));
    return { valid: tokensMatch(token, current), current };
  });

  handle('EXECUTE', async ({ sessionId, actions, snapshotId: planSnapshotId }) => {
    noteWorkerContact();

    const env: ExecutorEnv = {
      doc: document,
      handleFor,
      snapshotId: currentSnapshotId,
      resolve: (placeholder) => resolveThroughOffscreen(sessionId, placeholder),
      window,
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    };

    const results: ExecutionOutcome[] = [];
    for (const action of actions) {
      try {
        const seqBefore = mutationSeq();
        const urlBefore = window.location.href;
        const activeBefore = document.activeElement;
        const actionIndex = 'index' in action ? action.index : undefined;
        const targetNode = actionIndex !== undefined ? handleFor(actionIndex) : undefined;
        const checkedBefore = (targetNode as HTMLInputElement)?.checked;

        const result = await execute(action, env, planSnapshotId);

        const seqAfter = mutationSeq();
        const urlAfter = window.location.href;
        const activeAfter = document.activeElement;
        const checkedAfter = (targetNode as HTMLInputElement)?.checked;

        if (action.type === 'click' && result.outcome === 'ok') {
          if (urlBefore !== urlAfter) {
            result.note = `${result.note} (navigation)`;
          } else if (
            seqAfter > seqBefore ||
            activeBefore !== activeAfter ||
            (checkedBefore !== undefined && checkedBefore !== checkedAfter)
          ) {
            result.note = `${result.note} (dom-change)`;
          } else {
            result.note = `${result.note} (no-change)`;
          }
        }

        results.push(result);
      } catch (err) {
        // A step-ending rejection stops the batch: the remaining actions were built on
        // the same state that has just gone missing, so running them is worse than not.
        if (err instanceof StepEndingRejection) {
          results.push({ outcome: 'failed', note: err.reason });
          break;
        }
        throw err;
      }
    }

    // Invariant 7 names four events the loop advances on, and *action completion* is the
    // first of them. It was the one nothing raised: the loop leaned entirely on
    // mutation-settle, which never fires for the commonest action there is, because
    // typing sets a property rather than mutating the DOM. A successful `type` therefore
    // ended with the session at `running`, the log saying `ok`, and nothing ever
    // happening again -- indistinguishable, from the popup, from a step still in flight.
    //
    // Nudging rather than notifying directly is what keeps the other three events
    // correct: an action that does change the page restarts the same quiet timer, so a
    // click that opens a dialog is still perceived after the dialog exists.
    settleWatch?.nudge();
    return { results };
  });

  /**
   * Every control in the document, for the worker to score a sentence against.
   *
   * Deliberately does not touch the handle map. Those indices belong to the last real
   * walk, and an element located here is acted on only after `REVEAL` has brought it on
   * screen and a normal `DOM_SNAPSHOT` has given it a real index. Overwriting the handles
   * from a whole-document sweep would hand the executor coordinates for elements that are
   * not on screen, which is the opposite of the fix.
   */
  handle('SURVEY', () => {
    noteWorkerContact();
    const result = survey(browserEnv(document, window, previousKeys));
    surveyNodes = result.nodes;
    return { elements: result.elements, total: result.elements.length };
  });

  /**
   * Scroll one element into view, by the key the survey reported it under.
   *
   * `block: 'center'` rather than `'nearest'`: a field flush against the top of the
   * viewport is technically visible and practically under a sticky header, and the walk
   * that follows would then find it occluded and drop it again -- the same failure one
   * scroll further on.
   */
  handle('REVEAL', ({ key }) => {
    noteWorkerContact();
    const node = surveyNodes.get(key);
    if (!node) return { found: false };
    node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    return { found: true };
  });

  /**
   * Read the field back and say whether it holds what it was asked to hold.
   *
   * The whole point is that this reads the *document*, not the executor's memory of what it
   * did. `handleFor` returns the live node from the current walk, and `readValue` asks that
   * node what it holds now -- after whatever the page's own scripts made of the keystroke.
   *
   * Rehydration happens here and the comparison happens here, so the worker learns only
   * whether two strings matched. That is the same boundary the executor keeps, for the same
   * reason: the placeholder is the value's only representation on the other side.
   */
  handle('VERIFY_FILLED', async ({ sessionId, snapshotId: planSnapshotId, checks }) => {
    noteWorkerContact();

    // A stale walk means the indices no longer name the same elements. Reporting `missing`
    // rather than reading whatever now sits at that index is the difference between "we
    // could not check" and a confident answer about the wrong field.
    const stale = planSnapshotId !== currentSnapshotId();

    const results = [];
    for (const check of checks) {
      results.push({
        index: check.index,
        ...(await verifyOne(sessionId, check, stale)),
      });
    }
    return { results };
  });

  /**
   * The one path by which a credential reaches the page.
   *
   * Not an Action, and not reachable from a plan: the worker calls this only after the
   * operator has confirmed a release in a visible window. It still checks the snapshot,
   * because a field that has moved is exactly as wrong here as anywhere else -- more so,
   * given what is being typed into it.
   */
  handle('FILL_SECRET', ({ index, value, snapshotId: planSnapshotId }) => {
    noteWorkerContact();
    if (planSnapshotId !== currentSnapshotId()) {
      return { outcome: 'failed' as const, note: 'stale-snapshot' };
    }

    const el = handleFor(index);
    if (!el) return { outcome: 'failed' as const, note: 'unknown-index' };
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      return { outcome: 'failed' as const, note: 'not a text field' };
    }

    el.focus({ preventScroll: true });
    setNativeValue(el, value);
    // The note names the field, never the value. Nothing else about this is recorded.
    return { outcome: 'ok' as const, note: `filled [${index}] from the vault` };
  });

  handle('OVERLAY_TOGGLE', ({ show }) => {
    return { visible: setOverlay(show ?? !overlayVisible) };
  });
}

export function main(): void {
  setBusTransport(createChromeTransport('content'), 'content');
  installHandlers();

  // A fresh document is a reason to look, if a session is running. The worker says no
  // cheaply when it is not.
  void notify('PERCEIVE', { reason: 'navigation' });

  console.debug('[sih] content script ready');
}

/**
 * The content script can arrive twice in one document: the manifest injects it on
 * http://localhost/* at document idle, and the worker additionally injects it on demand
 * (worker/main.ts, chrome.scripting) for tabs the manifest's matches never covered --
 * which is any tab, on first load, that is not a localhost page. Both injections land in
 * the same isolated world, so a flag set *there* is what makes the second a no-op.
 *
 * Without this, a second copy registers its own bus listener and both respond to every
 * message, which reads as the same failure this file exists to prevent.
 */
const CONTENT_LIVE_FLAG = '__sih26171_content_live';
const contentGlobals = globalThis as unknown as Record<string, unknown>;
if (contentGlobals[CONTENT_LIVE_FLAG] === true) {
  console.debug('[sih] content script already live in this document');
} else {
  contentGlobals[CONTENT_LIVE_FLAG] = true;
  main();
}
