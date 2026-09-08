import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StepEvent } from '../shared/agent';
import type { ObservedElement } from '../shared/observed';
import { tokensMatch, type GeometryToken } from '../shared/frames';
import {
  handle,
  resetBus,
  send,
  setBusTransport,
  type BusTransport,
  type Envelope,
  type Reply,
} from '../shared/messages';
import { memoryStore, type KeyValueStore } from '../shared/store';
import { installRoutes, wake, type RouterDeps } from './router';
import { loadState, saveState, STATE_KEY, type AgentState } from './state';
import { beginStep, startTask } from './loop';
import { freshState } from './state';

/**
 * The router driven end to end in Node.
 *
 * The bus is a loopback, so the handlers that would live in the content script and the
 * offscreen document are registered here instead. That is the whole point of the
 * transport seam: the routing itself is covered by platform/chrome-bus.test.ts, and
 * this file is free to be about the loop.
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

let store: KeyValueStore;
let clock: number;
let events: StepEvent[];
let hostCalls: number;
let releaseCalls: number;
let captureCalls: number;
let snapshotCalls: number;
let ensureContentCalls: number;
let contentInjectionFails: boolean;
let posted: Array<{ request: unknown; bytes: number }>;
let traceLines: string[];
let currentToken: GeometryToken;
let tokenAfterCapture: GeometryToken | null;
let moveOnCapture: (() => GeometryToken) | null;

function deps(): RouterDeps {
  return {
    store,
    now: () => (clock += 10),
    newSessionId: () => 's-test',
    vault: testVault,
    // Declines by default. A test that wants a release says so, which means no test
    // gets one by accident.
    confirm: async () => confirmAnswer,
    ensureHost: async () => {
      hostCalls += 1;
    },
    releaseHost: async () => {
      releaseCalls += 1;
    },
    tabOrigin: async (tabId) => `http://tab-${tabId}.test`,
    ensureContent: async (tabId) => {
      ensureContentCalls += 1;
      void tabId;
      // What chrome.scripting.executeScript throws on a page the extension may not
      // drive -- chrome://newtab, the web store, a permission it never had.
      if (contentInjectionFails) throw new Error(contentInjectionFailure);
    },
    captureFrame: async (expected) => {
      captureCalls += 1;
      // The page moves *during* the capture, which is the whole problem this exists for.
      if (moveOnCapture) currentToken = moveOnCapture();
      else if (tokenAfterCapture) currentToken = tokenAfterCapture;
      return {
        kind: 'capture-tab' as const,
        dataUrl: 'data:image/jpeg;base64,AAAA',
        width: expected.width,
        height: expected.height,
        scale: expected.scale,
      };
    },
    takeFrame: async () => ({ bytes: new Uint8Array([1, 2, 3, 4]) }),
    post: async (request, bytes) => {
      posted.push({ request, bytes: bytes.byteLength });
      return {
        response: {
          protocolVersion: 1 as const,
          stepIndex: 0,
          rationale: '',
          actions: plannedActions,
          done: plannedDone,
        },
        requestBytes: 100,
        responseBytes: 50,
        attempts: 1,
      };
    },
    trace: (line) => traceLines.push(line),
  };
}

const STILL: GeometryToken = {
  scrollX: 0,
  scrollY: 0,
  vvOffsetX: 0,
  vvOffsetY: 0,
  vvScale: 1,
  dpr: 2,
  mutationSeq: 4,
  docHeight: 3000,
};

/** A field with something in it, so the privacy test below has something to look for. */
const SECRET_VALUE = 'Asha Menon';

const OBSERVED: ObservedElement[] = [
  {
    index: 1,
    role: 'textbox',
    box: { x: 10, y: 10, w: 200, h: 30 },
    state: { visible: true, enabled: true, focused: false, filled: false },
    occluded: 0,
    isNew: true,
    tag: 'input',
    inputType: 'text',
    nameAttr: 'full_name',
    ariaLabel: 'Full name',
    rawValue: SECRET_VALUE,
    textRuns: [],
    key: '|input|textbox|Full name|html/body/input',
    name: 'Full name',
  },
];

/** The vault, and what the operator says when asked. */
let testVault: import('./vault').VaultStore;
let confirmAnswer = false;

/** What EXECUTE was asked to run, per call. */
let executed: { snapshotId: string; actions: { type: string }[] }[] = [];

/** What the stub planner returns. A test that cares about the plan sets this. */
let plannedActions: import('../shared/contract').Action[] = [{ type: 'click', index: 1 }];
let plannedDone = false;
/** What chrome.scripting.executeScript threw. The wording decides the remedy offered. */
let contentInjectionFailure = 'Cannot access a chrome:// page';

function memoryVault(): import('./vault').VaultStore {
  const map = new Map<string, import('./vault').VaultEntry>();
  return {
    get: async (k) => map.get(k),
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
    keys: async () => [...map.keys()],
  };
}

/** Stand in for the content script, which lands in M4. */
function contentAnswers(
  onExecute?: (payload: { actions: import('../shared/contract').Action[] }) => {
    results: { outcome: 'ok' | 'failed' | 'no-op'; note?: string }[];
  },
): void {
  handle('DOM_SNAPSHOT', () => {
    snapshotCalls += 1;
    return {
      elements: OBSERVED,
      viewport: { w: 1280, h: 720 },
      origin: 'http://localhost:8080',
      title: 'demo',
      snapshotId: `snap.${snapshotCalls}`,
    };
  });
  // The whole-document sweep. Same elements as the viewport walk in this fixture: the
  // point being exercised here is the routing, not the scrolling, which reveal.test.ts
  // covers against a real jsdom layout.
  handle('SURVEY', () => ({ elements: OBSERVED, total: OBSERVED.length }));
  handle('REVEAL', () => ({ found: false }));

  handle('CAPTURE', () => ({
    viewport: { w: 1280, h: 720 },
    scale: 2,
    offsetX: 0,
    offsetY: 0,
    token: currentToken,
  }));

  handle('GEOMETRY_CHECK', ({ token }) => ({
    valid: tokensMatch(token, currentToken),
    current: currentToken,
  }));

  handle('EXECUTE', (payload) => {
    executed.push(payload);
    if (onExecute) return onExecute(payload);
    return { results: payload.actions.map(() => ({ outcome: 'ok' as const })) };
  });
}

/** A page that moves again on every capture. */
function handleAlwaysMoving(next: () => GeometryToken): void {
  tokenAfterCapture = null;
  moveOnCapture = next;
}

/** Stand in for the offscreen document: allocation and sealing. */
function offscreenAnswers(): void {
  handle('PLACEHOLDER_ALLOCATE', ({ items }) => ({
    placeholders: Object.fromEntries(
      items.map((item, i) => [item.id, `\u00ab${item.cls}_${i + 1}\u00bb`]),
    ),
  }));

  handle('SEAL_AND_ENCODE', ({ sessionId, stepIndex, findings, placeholders }) => ({
    handoffKey: `${sessionId}#${stepIndex}`,
    manifest: {
      findings,
      counts: {},
      marks: 0,
      redactedFraction: 0.1,
      overRedactedFraction: 0.02,
      policyVersion: 'p1',
      receipt: {
        algo: 'SHA-256' as const,
        hash: 'a'.repeat(64),
        manifestHash: 'b',
        sealedAt: 1,
      },
    },
    capture: {
      mime: 'image/webp',
      width: 1024,
      height: 576,
      scale: 0.8,
      sha256: 'c'.repeat(64),
    },
    placeholders,
  }));
}

function collectEvents(): void {
  handle('STEP_EVENT', (event) => {
    events.push(event);
    return { ok: true as const };
  });
}

async function settled(): Promise<AgentState> {
  // The step runs behind the reply, so wait for it to finish rather than sleeping.
  return vi.waitFor(async () => {
    const state = await loadState(store);
    if (state.busy) throw new Error('still busy');
    return state;
  });
}

beforeEach(() => {
  store = memoryStore();
  // Comfortably past STALE_STEP_MS so a fixture with updatedAt 0 reads as interrupted.
  clock = 1_000_000;
  events = [];
  hostCalls = 0;
  releaseCalls = 0;
  captureCalls = 0;
  snapshotCalls = 0;
  ensureContentCalls = 0;
  contentInjectionFails = false;
  executed = [];
  confirmAnswer = false;
  testVault = memoryVault();
  plannedActions = [{ type: 'click', index: 1 }];
  plannedDone = false;
  contentInjectionFailure = 'Cannot access a chrome:// page';
  posted = [];
  traceLines = [];
  currentToken = { ...STILL };
  tokenAfterCapture = null;
  moveOnCapture = null;
  setBusTransport(loopback(), 'worker');
  collectEvents();
  installRoutes(deps());
});

afterEach(() => resetBus());

describe('RUN_TASK', () => {
  it('opens a session and answers before the step finishes', async () => {
    contentAnswers();
    const reply = await send('RUN_TASK', { goal: 'renew the licence', tabId: 7 });
    expect(reply).toEqual({ sessionId: 's-test', stepIndex: 0 });

    const state = await settled();
    expect(state.goal).toBe('renew the licence');
    expect(state.tabId).toBe(7);
  });

  it('runs every phase in order, end to end', async () => {
    contentAnswers();
    offscreenAnswers();
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    const state = await settled();

    expect(state.log[0]?.outcome).toBe('ok');

    const phases = events.filter((e) => e.kind === 'phase').map((e) => e.phase);
    expect(phases.slice(0, 3)).toEqual(['perceive', 'perceive', 'capture']);
  });

  it('sends the actions with the snapshot they were planned against', async () => {
    // The whole of the staleness guard rests on this being the id from the walk that
    // produced the indices, not a fresh one read at execute time.
    contentAnswers();
    offscreenAnswers();

    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    await settled();

    expect(executed).toHaveLength(1);
    expect(executed[0]?.snapshotId).toBe('snap.1');
  });

  it('sends one request, with the sealed bytes', async () => {
    contentAnswers();
    offscreenAnswers();
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    await settled();

    expect(posted).toHaveLength(1);
    expect(posted[0]?.bytes).toBeGreaterThan(0);
  });

  it('writes exactly one trace line per step', async () => {
    contentAnswers();
    offscreenAnswers();
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    await settled();

    expect(traceLines).toHaveLength(1);
    const trace = JSON.parse(traceLines[0] ?? '{}') as Record<string, unknown>;
    expect(trace.stepIndex).toBe(0);
    expect(trace.outcome).toBe('ok');
    expect(Array.isArray(trace.events)).toBe(true);
  });

  it('keeps raw values out of the trace line', async () => {
    contentAnswers();
    offscreenAnswers();
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    await settled();

    // The trace is the artefact most likely to be enlarged on a slide.
    expect(traceLines[0]).not.toContain(SECRET_VALUE);
  });

  it('fails the step, not the extension, when the content script is not there', async () => {
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    const state = await settled();
    expect(state.status).toBe('failed');
    expect(state.log[0]?.phase).toBe('perceive');
    expect(state.log[0]?.note).toMatch(/DOM_SNAPSHOT/);
  });

  it('injects the content script before the step starts', async () => {
    contentAnswers();
    offscreenAnswers();
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    // Injection happened before anything else -- the step then walked the DOM it was
    // injected into. This is the regression that "Receiving end does not exist" was.
    expect(ensureContentCalls).toBeGreaterThanOrEqual(1);
    const state = await settled();
    expect(state.log[0]?.outcome).toBe('ok');
  });

  it('refuses to start when the tab cannot host a content script', async () => {
    // chrome://newtab, the web store: no permission reaches these, so the message says
    // what happened and offers nothing, because there is nothing to offer.
    contentInjectionFails = true;
    await expect(send('RUN_TASK', { goal: 'g', tabId: 7 })).rejects.toThrow(
      /cannot run the agent in this tab/,
    );

    // No session was ever opened and no step ever left the ground.
    const state = await loadState(store);
    expect(state.sessionId).toBeNull();
    expect(state.log).toEqual([]);
  });

  /**
   * The regression the side panel introduced, as a test.
   *
   * `openPanelOnActionClick` opens the panel without firing `action.onClicked`, so the
   * click is not an invocation and `activeTab` is never granted -- and every page outside
   * `host_permissions` then fails at injection with a sentence about the manifest. The
   * worker cannot fix the permission, but it can stop describing a button the operator has
   * not pressed as though it were a build defect.
   */
  it('names the remedy when the site is one a grant would reach', async () => {
    contentInjectionFailure =
      'Cannot access contents of url "https://www.w3schools.com/howto/x.asp". ' +
      'Extension manifest must request permission to access this host.';
    contentInjectionFails = true;

    await expect(send('RUN_TASK', { goal: 'g', tabId: 7 })).rejects.toThrow(
      /no access to this site yet .* Allow any site/s,
    );
  });

  it('offers no remedy for a page no grant can reach', async () => {
    contentInjectionFailure =
      'Cannot access contents of url "chrome://settings/". ' +
      'Extension manifest must request permission to access this host.';
    contentInjectionFails = true;

    await expect(send('RUN_TASK', { goal: 'g', tabId: 7 })).rejects.toThrow(
      /cannot run the agent in this tab/,
    );
  });

  it('tells the popup what happened', async () => {
    contentAnswers();
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    await settled();

    expect(events.some((e) => e.kind === 'status' && e.status === 'running')).toBe(true);
    expect(events.some((e) => e.kind === 'step-start')).toBe(true);
    expect(events.some((e) => e.kind === 'step-end' && e.outcome === 'failed')).toBe(true);
  });
});

describe('PERCEIVE', () => {
  it('is refused when no session is running', async () => {
    await expect(send('PERCEIVE', { reason: 'settle' })).resolves.toEqual({
      accepted: false,
      stepIndex: 0,
    });
  });

  it('is accepted once a session is running', async () => {
    contentAnswers();
    await saveState(
      store,
      startTask(freshState(), { sessionId: 's1', goal: 'g', tabId: 7, now: 1 }),
    );
    await expect(send('PERCEIVE', { reason: 'settle' })).resolves.toMatchObject({
      accepted: true,
    });
    await settled();
  });

  it('is refused while a step is already in flight', async () => {
    const busy = beginStep(
      startTask(freshState(), { sessionId: 's1', goal: 'g', tabId: 7, now: 1 }),
      2,
    );
    // Fresh enough that it is a real step, not an interrupted one.
    await saveState(store, { ...busy, updatedAt: clock });
    await expect(send('PERCEIVE', { reason: 'settle' })).resolves.toMatchObject({
      accepted: false,
    });
  });

  /**
   * The event that made this necessary is a navigation. The click that submits a form is
   * the last thing a step does, and the new document's content script announces itself
   * while that step is still ending -- so the one event that says "you are looking at a
   * different page now" arrives at precisely the moment the loop cannot take it.
   */
  it('remembers a refusal made only because a step was in flight', async () => {
    const busy = beginStep(
      startTask(freshState(), { sessionId: 's1', goal: 'g', tabId: 7, now: 1 }),
      2,
    );
    await saveState(store, { ...busy, updatedAt: clock });

    await send('PERCEIVE', { reason: 'navigation' });
    expect((await loadState(store)).pendingPerceive).toBe(true);
  });

  it('remembers nothing for a session that is stopping', async () => {
    const stopping = beginStep(
      startTask(freshState(), { sessionId: 's1', goal: 'g', tabId: 7, now: 1 }),
      2,
    );
    await saveState(store, { ...stopping, status: 'stopping', updatedAt: clock });

    await send('PERCEIVE', { reason: 'navigation' });
    expect((await loadState(store)).pendingPerceive).toBe(false);
  });

  /**
   * The real thing, at the real moment: a page event raised from inside the execute
   * phase, which is where a navigation's arrives.
   *
   * It is also the regression test for `finish`. That used to save a state read before
   * the step's last phase, which put the flag back to false and lost the navigation
   * entirely -- leaving the session at `running`, idle, on a page nobody had perceived.
   */
  it('takes the step it deferred once the step that refused it ends', async () => {
    let navigated = false;
    offscreenAnswers();
    contentAnswers(() => {
      if (!navigated) {
        navigated = true;
        // Fire and forget, exactly as content/index.ts does after a document load.
        void send('PERCEIVE', { reason: 'navigation' });
      }
      return { results: [{ outcome: 'ok' as const }] };
    });

    await send('RUN_TASK', { goal: 'g', tabId: 7 });

    await vi.waitFor(async () => {
      const state = await loadState(store);
      if (state.stepIndex < 2 || state.busy) throw new Error('not there yet');
      return state;
    });

    expect((await loadState(store)).pendingPerceive).toBe(false);
  });
});

/**
 * A plan can say it is finished two ways and both have to be honoured.
 *
 * The stub planner always pairs `done: true` with a `finish` action, so nothing noticed
 * that only the action was being read. A real model does not: qwen3:0.6b set `done: true`
 * on four separate steps of one demo run while the agent carried on regardless, re-typing
 * into a field it had already filled. Honouring one signal and silently dropping the other
 * makes the planner's clearest statement about its own work depend on which of two
 * equivalent forms it happened to pick.
 */
describe('the plan says it is done', () => {
  it('ends the session on a finish action', async () => {
    contentAnswers();
    offscreenAnswers();
    plannedActions = [{ type: 'finish', status: 'success', summary: 'all done' }];

    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    const state = await settled();

    expect(state.status).toBe('stopped');
  });

  it('ends the session on the done flag alone', async () => {
    contentAnswers();
    offscreenAnswers();
    plannedActions = [{ type: 'click', index: 1 }];
    plannedDone = true;

    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    const state = await settled();

    expect(state.status).toBe('stopped');
    expect(state.log.at(-1)?.note).toContain('done');
  });

  it('keeps going when the plan claims neither', async () => {
    contentAnswers();
    offscreenAnswers();
    plannedActions = [{ type: 'click', index: 1 }];
    plannedDone = false;

    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    const state = await settled();

    expect(state.status).toBe('running');
  });
});

/**
 * A session belongs to one tab, and the panel docks beside all of them.
 *
 * The panel is window-scoped: start a task on one tab, switch to another, and the same
 * panel is still there reading `running - step 4`. Pressing Run there would not start a
 * second agent -- the state is one record -- it would replace the first mid-step, taking
 * the evidence for a run in progress with it. The panel disables the button, but a view
 * is not where an invariant lives.
 */
describe('one tab at a time', () => {
  it('refuses a run on another tab while one is live, and names where', async () => {
    contentAnswers();
    offscreenAnswers();
    await send('RUN_TASK', { goal: 'first', tabId: 7 });
    await saveState(store, { ...(await loadState(store)), status: 'running' });

    await expect(send('RUN_TASK', { goal: 'second', tabId: 9 })).rejects.toThrow(
      /already running on http:\/\/tab-7\.test/,
    );

    // The first session is untouched: same tab, same goal.
    const state = await loadState(store);
    expect(state.tabId).toBe(7);
    expect(state.goal).toBe('first');
  });

  it('allows a re-run on the same tab, where the operator can see what they replace', async () => {
    contentAnswers();
    offscreenAnswers();
    await send('RUN_TASK', { goal: 'first', tabId: 7 });
    await saveState(store, { ...(await loadState(store)), status: 'running' });

    await expect(send('RUN_TASK', { goal: 'second', tabId: 7 })).resolves.toMatchObject({
      stepIndex: 0,
    });
    expect((await loadState(store)).goal).toBe('second');
  });

  it('allows a run elsewhere once the first session has stopped', async () => {
    contentAnswers();
    offscreenAnswers();
    await send('RUN_TASK', { goal: 'first', tabId: 7 });
    await settled();
    await send('STOP', {});

    await expect(send('RUN_TASK', { goal: 'second', tabId: 9 })).resolves.toBeTruthy();
    expect((await loadState(store)).tabId).toBe(9);
  });

  /** The label the panel shows, so it can name the site rather than a tab id. */
  it('records the origin of the tab it was started on', async () => {
    contentAnswers();
    offscreenAnswers();
    await send('RUN_TASK', { goal: 'g', tabId: 7 });

    expect((await loadState(store)).tabOrigin).toBe('http://tab-7.test');
  });
});

describe('STOP', () => {
  it('stops an idle session immediately', async () => {
    contentAnswers();
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    await settled();
    await saveState(store, { ...(await loadState(store)), status: 'running' });

    await expect(send('STOP', {})).resolves.toEqual({ stopped: true });
    expect((await loadState(store)).status).toBe('stopped');
  });

  it('is safe to call when nothing is running', async () => {
    await expect(send('STOP', {})).resolves.toEqual({ stopped: false });
  });
});

describe('surviving the service worker being killed', () => {
  it('repairs a stale in-flight step on the next message and carries on', async () => {
    contentAnswers();

    // What storage looks like after MV3 terminated the worker mid-step.
    const killed = beginStep(
      startTask(freshState(), { sessionId: 's1', goal: 'g', tabId: 7, now: 0 }),
      0,
    );
    await saveState(store, { ...killed, updatedAt: 0 });

    const reply = await send('PERCEIVE', { reason: 'navigation' });
    expect(reply.accepted).toBe(true);

    const state = await settled();
    expect(state.log[0]?.outcome).toBe('interrupted');
    expect(state.sessionId).toBe('s1');
    expect(state.goal).toBe('g');
  });

  it('rebuilds everything it knows from storage alone', async () => {
    contentAnswers();
    await send('RUN_TASK', { goal: 'the goal', tabId: 7 });
    await settled();

    // A new worker generation: nothing but the store survives.
    resetBus();
    setBusTransport(loopback(), 'worker');
    collectEvents();
    contentAnswers();
    const fresh = deps();
    installRoutes(fresh);

    const state = await wake(fresh);
    expect(state.goal).toBe('the goal');
    expect(state.tabId).toBe(7);
    expect(state.log.length).toBeGreaterThan(0);
  });

  it('keeps its state under one key, so a wake is one read', async () => {
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    await settled();
    expect(await store.get(STATE_KEY)).toBeDefined();
  });
});

describe('what the worker persists', () => {
  /**
   * The worker routes raw values -- it is the only context that can talk to both the
   * page and the host -- but chrome.storage.session outlives the step, and the gate
   * cannot reach into it. So: nothing raw is allowed to land there.
   */
  it('never writes a field value to storage', async () => {
    contentAnswers();
    await send('RUN_TASK', { goal: 'renew the licence', tabId: 7 });
    await settled();

    const stored = JSON.stringify(await store.get(STATE_KEY));
    expect(stored).not.toContain(SECRET_VALUE);
    expect(stored).not.toContain('full_name');
    expect(stored).not.toContain('rawValue');
  });

  it('keeps no element in the step log either', async () => {
    contentAnswers();
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    const state = await settled();

    for (const entry of state.log) {
      expect(JSON.stringify(entry)).not.toContain(SECRET_VALUE);
    }
  });

  it('does not put page content in what it tells the popup', async () => {
    contentAnswers();
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    await settled();

    expect(JSON.stringify(events)).not.toContain(SECRET_VALUE);
  });
});

describe('binding the frame to the boxes', () => {
  it('captures and keeps the frame when the page holds still', async () => {
    contentAnswers();
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    const state = await settled();

    expect(captureCalls).toBe(1);
    expect(state.framesDiscarded).toBe(0);
    // The step still dies at detect (M5); capture succeeded on the way there.
    expect(state.log[0]?.phase).toBe('detect');
  });

  it('discards a frame the page moved out from under, and tries again', async () => {
    contentAnswers();
    // The page scrolls during the first capture, then settles.
    tokenAfterCapture = { ...STILL, scrollY: 240 };
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    const state = await settled();

    // First frame thrown away; the retry photographs the page as it now is.
    expect(state.framesDiscarded).toBe(1);
    expect(captureCalls).toBe(2);
    expect(state.log[0]?.phase).toBe('detect');
  });

  it('says what moved, so a flaky page is diagnosable', async () => {
    contentAnswers();
    tokenAfterCapture = { ...STILL, scrollY: 240 };
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    await settled();

    const discard = events.find((e) => e.note?.includes('frame discarded'));
    expect(discard?.note).toContain('scrollY 0 -> 240');
  });

  it('fails the step rather than looping on a page that never holds still', async () => {
    contentAnswers();
    // Every capture moves the page again: an animation, a carousel, a live ticker.
    let seq = STILL.mutationSeq;
    handleAlwaysMoving(() => {
      seq += 1;
      return { ...STILL, mutationSeq: seq };
    });

    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    const state = await settled();

    expect(state.status).toBe('failed');
    expect(state.log[0]?.note).toMatch(/page would not hold still/);
    expect(state.log[0]?.phase).toBe('capture');
    expect(state.framesDiscarded).toBe(2);
  });

  it('re-perceives before the retry -- the boxes belonged to the old page', async () => {
    contentAnswers();
    tokenAfterCapture = { ...STILL, scrollY: 240 };
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    await settled();

    // perceive phase, then a second DOM_SNAPSHOT inside the capture retry.
    expect(snapshotCalls).toBe(2);
  });

  it('does not persist the frame or the elements it routed', async () => {
    contentAnswers();
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    await settled();

    const stored = JSON.stringify(await store.get(STATE_KEY));
    expect(stored).not.toContain('data:image');
    expect(stored).not.toContain(SECRET_VALUE);
  });
});

describe('the inference host', () => {
  it('is not started before a session runs', async () => {
    expect(hostCalls).toBe(0);
  });

  it('is started by the detect phase, which needs the allocator', async () => {
    // The placeholder map lives in the offscreen document, so detection needs it up
    // before it can turn values into stable tokens.
    contentAnswers();
    offscreenAnswers();
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    await settled();
    expect(hostCalls).toBeGreaterThan(0);
  });

  it('is released when the session stops running', async () => {
    contentAnswers();
    await send('RUN_TASK', { goal: 'g', tabId: 7 });
    await settled();
    // The step failed, so the session is no longer running and nothing should stay up.
    await vi.waitFor(() => expect(releaseCalls).toBeGreaterThan(0));
  });

  it('comes up on demand for a self-test', async () => {
    await expect(send('HOST_ENSURE', {})).resolves.toEqual({ ready: true });
    expect(hostCalls).toBe(1);
  });
});

/**
 * The sweep.
 *
 * The tests above each check one surface. This one checks all of them at once against a
 * session that actually rehydrates a value, because M9 is the first module where a raw
 * string is produced *after* the redaction gate has run -- the executor turns «EMAIL_1»
 * back into an address in order to type it, and every note, log line, trace and event
 * emitted from that point on is a chance to carry it back out.
 */
describe('a whole session, swept for the values it handled', () => {
  const REHYDRATED = 'asha.menon@example.in';

  beforeEach(() => {
    plannedActions = [
      { type: 'type', index: 1, text: '«EMAIL_1»', submit: false },
      { type: 'click', index: 1 },
    ];
  });

  it('leaks nothing into the trace, the step log or the event stream', async () => {
    // Stand in for a content script that really did the substitution: it reports what
    // it typed the way the executor does -- by token, never by value.
    contentAnswers(({ actions }) => ({
      results: actions.map((action) =>
        action.type === 'type'
          ? { outcome: 'ok' as const, note: `typed «EMAIL_1» into [${action.index}]` }
          : { outcome: 'ok' as const },
      ),
    }));
    offscreenAnswers();

    await send('RUN_TASK', { goal: `apply with ${REHYDRATED}`, tabId: 7 });
    const state = await settled();

    const surfaces: Record<string, string> = {
      trace: traceLines.join('\n'),
      'step log': JSON.stringify(state.log),
      'stored state': JSON.stringify(await store.get(STATE_KEY)),
      'event stream': JSON.stringify(events),
    };

    for (const [name, text] of Object.entries(surfaces)) {
      expect(text, `${REHYDRATED} reached the ${name}`).not.toContain(REHYDRATED);
      expect(text, `${SECRET_VALUE} reached the ${name}`).not.toContain(SECRET_VALUE);
    }
  });

  it('still records that something was typed, and which token it was', async () => {
    // The other half: a sweep that passes because nothing is recorded at all would be
    // worthless. The token has to survive, precisely because it is not the value.
    contentAnswers(({ actions }) => ({
      results: actions.map(() => ({
        outcome: 'ok' as const,
        note: 'typed «EMAIL_1» into [1]',
      })),
    }));
    offscreenAnswers();

    await send('RUN_TASK', { goal: 'apply', tabId: 7 });
    await settled();

    const trace = JSON.parse(traceLines[0] ?? '{}') as { execution?: string[] };
    expect(trace.execution).toEqual(['ok', 'ok']);
  });
});

describe('releasing a stored secret', () => {
  const ORIGIN = 'http://localhost:8080';

  async function storeOne(): Promise<void> {
    await send('VAULT_SAVE', {
      origin: ORIGIN,
      cls: 'SECRET',
      label: 'Portal PIN',
      value: 'hunter2',
    });
  }

  it('does nothing at all when the operator declines', async () => {
    contentAnswers();
    await storeOne();
    confirmAnswer = false;

    let filled = false;
    handle('FILL_SECRET', () => {
      filled = true;
      return { outcome: 'ok' as const };
    });

    const result = await send('VAULT_FILL', {
      tabId: 7,
      index: 1,
      origin: ORIGIN,
      cls: 'SECRET',
    });

    expect(result).toEqual({ outcome: 'failed', reason: 'declined' });
    expect(filled, 'the page was written to without a confirm').toBe(false);
  });

  it('fills only after a confirm, and never names the value in the reply', async () => {
    contentAnswers();
    await storeOne();
    confirmAnswer = true;

    let received: { value: string } | undefined;
    handle('FILL_SECRET', (payload) => {
      received = payload;
      return { outcome: 'ok' as const };
    });

    const result = await send('VAULT_FILL', {
      tabId: 7,
      index: 1,
      origin: ORIGIN,
      cls: 'SECRET',
    });

    expect(result).toEqual({ outcome: 'ok' });
    expect(received?.value).toBe('hunter2');
    // The value went to the page and nowhere else. Not to the caller, not to the log.
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify((await store.get(STATE_KEY)) ?? null)).not.toContain('hunter2');
  });

  it('checks the page has not moved before typing a credential into it', async () => {
    // The index the operator picked came from a listing that may be stale, and a field
    // that has shifted is more dangerous here than anywhere else.
    contentAnswers();
    await storeOne();
    confirmAnswer = true;

    let sent: { snapshotId: string } | undefined;
    handle('FILL_SECRET', (payload) => {
      sent = payload;
      return { outcome: 'ok' as const };
    });

    await send('VAULT_FILL', { tabId: 7, index: 1, origin: ORIGIN, cls: 'SECRET' });
    expect(sent?.snapshotId).toBeDefined();
  });

  it('does not ask about an origin it has nothing for', async () => {
    contentAnswers();
    await storeOne();
    confirmAnswer = true;

    const result = await send('VAULT_FILL', {
      tabId: 7,
      index: 1,
      origin: 'http://localhost:8080.evil.example',
      cls: 'SECRET',
    });

    expect(result).toEqual({ outcome: 'failed', reason: 'not-stored' });
  });

  it('lists what is stored without producing any of it', async () => {
    await storeOne();
    const listed = await send('VAULT_LIST', {});

    expect(listed.entries).toEqual([{ origin: ORIGIN, cls: 'SECRET' }]);
    expect(JSON.stringify(listed)).not.toContain('hunter2');
  });

  it('forgets one on request', async () => {
    await storeOne();
    await send('VAULT_FORGET', { origin: ORIGIN, cls: 'SECRET' });

    expect((await send('VAULT_LIST', {})).entries).toEqual([]);
  });
});

describe('the local reader', () => {
  /**
   * Every link between "the grammar gave up" and "the page changed", with the HTTP call
   * itself stubbed.
   *
   * The call is stubbed because it is the one part that cannot be exercised here and *is*
   * exercised elsewhere: `scripts/bench-reader.py` sends this exact prompt and schema to a
   * real Ollama and scores what comes back. What this test owns is the chain around it --
   * that an open-ended goal reaches the reader at all, that its answer is verified before
   * anything is typed, that the step is credited to tier 1 rather than tier 0, and that
   * nothing crosses the network on the way.
   */
  function readerDeps(
    answer: Awaited<ReturnType<NonNullable<RouterDeps['readGoal']>>>,
    seen: { sentence?: string; candidates?: number } = {},
  ): RouterDeps {
    return {
      ...deps(),
      readGoal: async (sentence, candidates) => {
        seen.sentence = sentence;
        seen.candidates = candidates.length;
        return answer;
      },
    };
  }

  it('reads a goal the grammar cannot, and acts on it without sending anything', async () => {
    resetBus();
    setBusTransport(loopback(), 'worker');
    collectEvents();
    contentAnswers();
    const seen: { sentence?: string; candidates?: number } = {};
    installRoutes(
      readerDeps(
        {
          ok: true,
          value: [{ index: 1, action: 'type' as const, text: 'leo' }],
          model: 'test-model',
        },
        seen,
      ),
    );

    // Deliberately a sentence with no verb the grammar knows and no field name in it. An
    // earlier version of this test used "put my name down as leo", which the grammar reads
    // perfectly well now that a backwards `as` is swapped -- so it never reached the reader
    // and the test was passing on a path it was not written for.
    await send('RUN_TASK', { goal: 'it should say leo up top', tabId: 7 });
    const state = await settled();

    // It was asked, and it was asked about this page.
    expect(seen.sentence).toBe('it should say leo up top');
    expect(seen.candidates).toBeGreaterThan(0);

    // Credited to the rung that answered, and nothing crossed the boundary.
    const note = state.log[state.log.length - 1]?.note ?? '';
    expect(note).toContain('tier 1');
    expect(note).toContain('nothing sent');
    expect(posted).toHaveLength(0);
  });

  it('refuses a value the user never typed, and escalates instead', async () => {
    resetBus();
    setBusTransport(loopback(), 'worker');
    collectEvents();
    contentAnswers();
    installRoutes(
      readerDeps({
        ok: true,
        value: [{ index: 1, action: 'type' as const, text: 'john.doe@example.com' }],
        model: 'test-model',
      }),
    );

    await send('RUN_TASK', { goal: 'fill in this form for me', tabId: 7 });
    const state = await settled();

    const note = state.log[state.log.length - 1]?.note ?? '';
    expect(note).toContain('made up a value');
    // Escalated rather than acted on. The value never reached the page.
    expect(note).not.toContain('john.doe');
  });

  it('says which kind of no it got, so a switched-off rung is visible', async () => {
    resetBus();
    setBusTransport(loopback(), 'worker');
    collectEvents();
    contentAnswers();
    installRoutes(readerDeps({ ok: false, why: 'forbidden', model: 'test-model' }));

    await send('RUN_TASK', { goal: 'fill in this form for me', tabId: 7 });
    const state = await settled();

    const note = state.log[state.log.length - 1]?.note ?? '';
    expect(note).toContain('OLLAMA_ORIGINS');
  });

  it('treats an empty answer as the model declining, not as a fault', async () => {
    resetBus();
    setBusTransport(loopback(), 'worker');
    collectEvents();
    contentAnswers();
    installRoutes(readerDeps({ ok: true, value: [], model: 'test-model' }));

    await send('RUN_TASK', { goal: 'fill in this form for me', tabId: 7 });
    const state = await settled();

    const note = state.log[state.log.length - 1]?.note ?? '';
    expect(note).toContain('found nothing it could do');
  });

  /**
   * The bug this whole carve-out exists for: "scroll and show the most liked comment"
   * reached the reader, which has no verb but type/click/select, so it clicked the
   * likeliest button and reported done having read nothing. The reader must not be asked
   * at all -- the step belongs to the tier that can scroll, re-perceive and finish.
   */
  it('escalates a reading goal past the reader, which cannot read a page', async () => {
    resetBus();
    setBusTransport(loopback(), 'worker');
    collectEvents();
    contentAnswers();
    offscreenAnswers();
    plannedDone = true;
    const seen: { sentence?: string; candidates?: number } = {};
    installRoutes(
      readerDeps(
        { ok: true, value: [{ index: 1, action: 'type' as const, text: 'leo' }], model: 'test-model' },
        seen,
      ),
    );

    // "show" and "most" are reading words: the answer has to be read off the page and
    // spoken back, and the form-fill reader has no verb that does that.
    await send('RUN_TASK', { goal: 'show the most liked comment', tabId: 7 });
    const state = await settled();

    // The reader was never consulted -- not asked and refused, never asked.
    expect(seen.sentence).toBeUndefined();
    // The step left the machine for the tier that can scroll and finish.
    expect(posted.length).toBeGreaterThan(0);
    // And the log names why the rung was skipped.
    const note = state.log[state.log.length - 1]?.note ?? '';
    expect(note).toContain('reading task');
  });
});
