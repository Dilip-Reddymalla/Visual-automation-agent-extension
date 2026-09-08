/**
 * The worker, minus the one thing that differs between browsers.
 *
 * Everything here runs at the top level, synchronously, on every wake. MV3 restarts
 * this bundle whenever a message arrives at a dead worker, and a listener registered
 * inside an async init is a listener that missed the message that did the waking.
 *
 * The worker routes. It does not infer -- neither WebGPU nor the ORT WASM backend
 * exists here (CLAUDE.md invariant 8) -- and it does not encode. What it will own is
 * the single network call and the independent receipt check in front of it (M7).
 *
 * Where the host lives is the whole difference between the two builds, so it arrives as
 * a `HostBinding` from the entry point rather than as a branch. That is not tidiness:
 * an `if` here would pull onnxruntime-web into Chrome's service worker bundle, half a
 * megabyte of parse on every wake for code that can never run there.
 */

import { createChromeTransport } from '../platform/chrome-bus';
import { chromeConfirmRelease, chromeVaultStore } from '../platform/vault-store';
import { chromeSessionStore } from '../platform/session-store';
import { chromeCaptureDeps, createCaptureQueue } from './capture';
import { createFrameStore } from '../platform/frame-store';
import { DEFAULT_ENDPOINT, postStep } from './transport';
import { pickCandidate, readGoal } from './local';
import { setBusTransport, type Context } from '../shared/messages';
import { abandon } from './loop';
import { installRoutes, wake, type RouterDeps } from './router';
import { updateState } from './state';

export interface HostBinding {
  /** Contexts this page answers for. Firefox's background page is also the host. */
  accepts: Context[];
  /** Install the inference handlers in this page, if this page is the host. */
  install(): void;
  /** Make sure the host exists and can be messaged. */
  ensure(): Promise<void>;
  /** Tear it down: no model resident, no GPU context, no timer. */
  release(): Promise<void>;
}

function newSessionId(): string {
  const rand =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `s-${Date.now().toString(36)}-${rand}`;
}

/**
 * Make sure a content script is alive in a tab before the router sends into it.
 *
 * The manifest auto-injects on http://localhost/* at document idle, so the demo path is
 * covered on its own. But "the operator runs the agent in some other tab" is the whole
 * first-load experience -- the extension ships, they run, and the step dies on "the
 * receiving end does not exist" -- so RUN_TASK and VAULT_FILL call this first.
 *
 * `executeScript` needs either host permission for the tab's origin (localhost is in
 * the manifest) or activeTab, which opening the popup grants. Re-injecting where the
 * manifest already did is harmless: content/index.ts guards its own initialisation
 * behind a flag on the isolated world, so the second copy no-ops instead of double-
 * registering the bus listener.
 */
async function ensureContent(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
}

/**
 * Which site a tab is on, as an origin.
 *
 * The panel docks beside every tab in the window while the session belongs to exactly
 * one, so it has to be able to say which -- and a tab id is no answer to a human. Origin
 * only: the full URL carries query strings, and this ends up in session storage where the
 * gate cannot reach it.
 *
 * A tab whose URL cannot be parsed -- `chrome://`, `about:blank`, a tab that closed
 * between the ask and the answer -- gets an empty label rather than an exception. The run
 * does not depend on this.
 */
async function tabOrigin(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url ? new URL(tab.url).origin : '';
  } catch {
    return '';
  }
}

export function createDeps(binding: HostBinding): RouterDeps {
  // One queue for the whole worker: the rate limit is per browser, not per step, and a
  // queue per step would coalesce nothing.
  const captures = createCaptureQueue(chromeCaptureDeps());
  const frames = createFrameStore();

  return {
    store: chromeSessionStore(),
    now: () => Date.now(),
    newSessionId,
    captureFrame: (expected) => captures.request(expected),
    ensureContent,
    tabOrigin,

    async takeFrame(key) {
      const stored = await frames.take(key);
      if (!stored) return undefined;
      return { bytes: new Uint8Array(await stored.bytes.arrayBuffer()) };
    },

    // The one place in the extension that touches the network. Everything else takes
    // it as a parameter, so "who can send?" is answerable by reading this line.
    //
    // Bound, not bare. `fetch` detached from its global throws "Illegal invocation" in a
    // service worker -- it needs WorkerGlobalScope as its receiver. The unit tests inject
    // a fake fetch and so never exercised the binding; the first real browser load failed
    // the plan phase on it.
    post: (request, bytes) =>
      postStep(request, bytes, { fetch: globalThis.fetch.bind(globalThis) }),

    // Tier 1. A second thing that can leave this process, and it is here beside `post`
    // rather than anywhere else so that both are visible in one place: this one reaches
    // loopback only, and is the one tier allowed to see the sentence as the user typed it.
    askLocal: (sentence, candidates) =>
      pickCandidate(sentence, candidates, { fetch: globalThis.fetch.bind(globalThis) }),
    // The same model, the whole question. Reached only when the grammar read nothing --
    // never for a goal the grammar refused, which is a distinction `router.ts` makes and
    // this line depends on.
    readGoal: (sentence, candidates, correction) =>
      readGoal(sentence, candidates, { fetch: globalThis.fetch.bind(globalThis) }, correction),
    // What a step note calls the far end. The host only -- the path is a constant and
    // repeating it in every log line buys nothing.
    plannerName: () => {
      try {
        return new URL(DEFAULT_ENDPOINT).host;
      } catch {
        return 'the remote planner';
      }
    },
    ensureHost: () => binding.ensure(),
    releaseHost: () => binding.release(),
    vault: chromeVaultStore(),
    confirm: chromeConfirmRelease(),
  };
}

interface SidePanelApi {
  setPanelBehavior?(options: { openPanelOnActionClick: boolean }): Promise<void>;
  open?(options: { tabId: number }): Promise<void>;
}

/**
 * Make the toolbar icon open the docked panel -- by handling the click, not by asking
 * Chrome to handle it.
 *
 * The difference is `activeTab`, and it is the whole permission model of this extension.
 *
 * `setPanelBehavior({openPanelOnActionClick: true})` looks like the obvious way to do
 * this and is a trap. Chrome opens the panel itself and `action.onClicked` never fires,
 * so the click is not an *invocation* of the extension and `activeTab` is never granted.
 * Everything downstream then fails on a page outside `host_permissions`, starting with
 * the content-script injection:
 *
 *     Cannot access contents of url "https://www.w3schools.com/...".
 *     Extension manifest must request permission to access this host.
 *
 * Which reads as a manifest bug and is not one. The extension had been working on exactly
 * that page the day before, through the action popup -- opening a popup *is* an
 * invocation, and that is what had been granting the permission all along.
 *
 * Handling `onClicked` ourselves restores it: the listener only exists because there is no
 * `default_popup`, firing it is an invocation, `activeTab` is granted for that tab, and
 * the handler is a user-gesture context, which is what `sidePanel.open()` requires. One
 * click, same panel, permission intact.
 *
 * Guarded rather than assumed: `chrome.sidePanel` does not exist on Firefox, where the
 * same page is reached through `sidebar_action` and the browser's own sidebar control, and
 * it does not exist on a Chrome older than 114. Neither is a reason for the worker to fail
 * to start -- every other route into the extension still works.
 */
function openPanelOnToolbarClick(): void {
  const api = (chrome as unknown as { sidePanel?: SidePanelApi }).sidePanel;
  if (!api?.open || !chrome.action?.onClicked) return;

  // Explicitly off: if Chrome is opening the panel, the listener below never runs, and
  // the grant goes with it. Leaving it unset is not the same as setting it false -- the
  // preference persists across reloads of the extension.
  void api.setPanelBehavior?.({ openPanelOnActionClick: false })?.catch(() => undefined);

  chrome.action.onClicked.addListener((tab) => {
    if (tab.id === undefined) return;
    // Not awaited, and deliberately: `sidePanel.open` has to be called synchronously
    // inside the gesture, and an await before it would spend the gesture.
    void api.open?.({ tabId: tab.id })?.catch(() => undefined);
  });
}

export function startWorker(binding: HostBinding): void {
  const deps = createDeps(binding);

  setBusTransport(createChromeTransport('worker', { accepts: binding.accepts }), 'worker');
  installRoutes(deps);
  binding.install();

  openPanelOnToolbarClick();

  // Events, never timers (CLAUDE.md invariant 7). Idle cost is zero.
  chrome.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      const state = await updateState(deps.store, (s) =>
        s.tabId === tabId ? abandon(s, Date.now()) : s,
      );
      // The agent's tab is gone: everything unloads.
      if (state.tabId === tabId && state.status !== 'running') await deps.releaseHost();
    })();
  });

  chrome.runtime.onStartup.addListener(() => {
    void wake(deps);
  });

  console.debug('[sih] worker ready');
}
