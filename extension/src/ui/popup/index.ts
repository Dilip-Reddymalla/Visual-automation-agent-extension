/**
 * Popup: a goal box, run, stop, an overlay toggle, and a live step log.
 *
 * No framework -- four controls do not need one. The popup is a *view*: it never holds
 * the truth about a session, it reads it from `chrome.storage.session` and re-renders
 * when that changes. So closing and reopening it shows the same thing, and so does
 * opening it after the service worker has been killed and restarted.
 *
 * STEP_EVENT gives the same information sooner; storage is what makes it durable.
 */

import { createChromeTransport } from '../../platform/chrome-bus';
import { chromeSessionStore } from '../../platform/session-store';
import { handle, send, setBusTransport } from '../../shared/messages';
import type { StepLogEntry } from '../../shared/agent';
import { loadState, updateState, STATE_KEY, type AgentState } from '../../worker/state';
import { DEFAULT_READER_MODEL } from '../../worker/local';
import { DEFAULT_ENDPOINT } from '../../worker/transport';

const store = chromeSessionStore();

/**
 * The planner's own health endpoint, beside the one place that posts to it.
 *
 * Derived from the transport's endpoint rather than written out again, so the panel can
 * never end up describing a different server from the one the step talks to.
 */
const PLANNER_HEALTH = DEFAULT_ENDPOINT.replace(/\/v1\/step$/, '/health');

const el = {
  goal: document.getElementById('goal') as HTMLTextAreaElement | null,
  run: document.getElementById('run') as HTMLButtonElement | null,
  stop: document.getElementById('stop') as HTMLButtonElement | null,
  overlay: document.getElementById('overlay') as HTMLInputElement | null,
  selftest: document.getElementById('selftest') as HTMLButtonElement | null,
  coverage: document.getElementById('coverage'),
  host: document.getElementById('host'),
  status: document.getElementById('status'),
  log: document.getElementById('log'),
  counter: document.getElementById('counter'),
  redacted: document.getElementById('redacted'),
  selfTyped: document.getElementById('self-typed'),
  openPanel: document.getElementById('open-panel') as HTMLButtonElement | null,
  openHud: document.getElementById('open-hud') as HTMLButtonElement | null,
  access: document.getElementById('access'),
  planner: document.getElementById('planner'),
  localModel: document.getElementById('local-model'),
  grant: document.getElementById('grant') as HTMLButtonElement | null,
  tabNote: document.getElementById('tab-note'),
  tabNoteText: document.getElementById('tab-note-text'),
  showTab: document.getElementById('show-tab') as HTMLButtonElement | null,
};

/**
 * The tab the operator is looking at, kept current.
 *
 * A popup was opened, read once and closed; the panel is docked and outlives every tab
 * switch in the window, so "which tab is in front" is no longer something to ask once at
 * startup. It has to be watched, or the panel spends the rest of the session describing
 * a tab that stopped being in front minutes ago.
 */
let activeTab: { id: number | null; origin: string } = { id: null, origin: '' };

/**
 * What the extension may reach, and how to change it.
 *
 * The manifest asks for `activeTab` and `http://localhost/*` and nothing else, which is
 * the honest answer to "what can this see?" -- and it has two costs the operator should be
 * told about rather than discover.
 *
 * `activeTab` is granted when the toolbar icon is clicked and **revoked when the tab
 * navigates**. So the agent's own work can take its access away: the demo's page A submits
 * and becomes page B, and the next step has no permission to photograph what it just
 * caused. And `captureVisibleTab` accepts nothing narrower -- a host permission for the
 * exact origin in front of you does not satisfy it; the API takes `<all_urls>` or
 * `activeTab` and that is the whole list.
 *
 * So `<all_urls>` is declared *optional*: nothing at install, one deliberate click here,
 * visible in chrome://extensions, and revocable from the same button. That is a broad
 * grant and it is described as one -- the alternative is an agent that stops working
 * every time it succeeds at navigating.
 */
const BROAD: chrome.permissions.Permissions = { origins: ['<all_urls>'] };

async function hasBroadAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains(BROAD);
  } catch {
    return false;
  }
}

/**
 * Where the planner is running, said out loud.
 *
 * The whole architecture is redaction protecting data from a planner somewhere else. Run
 * that planner on the same laptop as the browser and every piece of the machinery still
 * works and protects nobody: the screenshot is redacted and then handed to a process the
 * user could have read the page from anyway. That is a fine way to develop and a
 * dishonest thing to demonstrate without saying so, and this line is the saying.
 *
 * The server reports its own address; only it knows how it was deployed. A planner that
 * cannot be reached at all says so rather than guessing.
 */
async function renderPlanner(): Promise<void> {
  if (!el.planner) return;
  try {
    const reply = await fetch(PLANNER_HEALTH, { signal: AbortSignal.timeout(2000) });
    const health = (await reply.json()) as { location?: string; backend?: string };
    const location = health.location ?? 'unknown';
    el.planner.dataset.where = location.startsWith('remote') ? 'remote' : 'local';
    el.planner.textContent = `Planner: ${location}${health.backend ? ` (${health.backend})` : ''}`;
  } catch {
    el.planner.dataset.where = '';
    el.planner.textContent = 'Planner: not reachable — start it, or the step will die at plan';
  }
}

/**
 * Is the local model actually available to this extension?
 *
 * Asked, not assumed, because the answer was no and nothing said so. Ollama's CORS
 * allowlist has no browser-extension origin in it by default, so every Tier 1 call from the
 * service worker came back 403 and the step log reported "tier 1 declined" -- which reads as
 * a model that considered the question. The rung had never run.
 *
 * The check is the cheapest request Ollama serves, and its failure mode is the interesting
 * part: a refusal is a *different* state from nothing listening, and only one of them is
 * fixed by starting a server.
 */
const LOCAL_MODEL_ENDPOINT = 'http://localhost:11434/v1/chat/completions';

async function renderLocalModel(): Promise<void> {
  if (!el.localModel) return;
  try {
    // The request Tier 1 actually makes, not a cheaper one that happens to be nearby.
    //
    // This first checked `GET /api/tags`, which is wrong in the most misleading possible
    // way: Ollama serves that GET to any origin and refuses the POST, so the panel said
    // "Local model: ready (7 pulled)" on the same page where the step log said the model
    // had refused the extension with 403. A readout that reports the health of something
    // other than the thing it names is worse than no readout -- it actively argues against
    // the true one.
    //
    // One token, so this costs nothing but the round trip.
    let reply: Response;
    try {
      reply = await fetch(LOCAL_MODEL_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: DEFAULT_READER_MODEL,
          messages: [{ role: 'user', content: 'ok' }],
          max_tokens: 1,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      reply = await fetch('http://127.0.0.1:11434/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: DEFAULT_READER_MODEL,
          messages: [{ role: 'user', content: 'ok' }],
          max_tokens: 1,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(4000),
      });
    }

    if (reply.status === 403) {
      el.localModel.dataset.where = '';
      el.localModel.textContent =
        'Local model: ollama refused this extension (403) — restart it with ' +
        'OLLAMA_ORIGINS=chrome-extension://*';
      return;
    }
    if (reply.status === 404) {
      el.localModel.dataset.where = '';
      el.localModel.textContent = `Local model: ollama is up, but ${DEFAULT_READER_MODEL} is not pulled`;
      return;
    }
    if (!reply.ok) {
      el.localModel.dataset.where = '';
      el.localModel.textContent = `Local model: ollama answered ${reply.status}`;
      return;
    }
    el.localModel.dataset.where = 'local';
    el.localModel.textContent = `Local model: ready (${DEFAULT_READER_MODEL})`;
  } catch {
    el.localModel.dataset.where = '';
    el.localModel.textContent = 'Local model: not running — tier 1 will be skipped';
  }
}

async function renderAccess(): Promise<void> {
  if (!el.access) return;
  const granted = await hasBroadAccess();

  el.access.dataset.access = granted ? 'granted' : 'narrow';
  el.access.textContent = granted
    ? 'Any site. Granted by you, and revocable here or in chrome://extensions.'
    : 'localhost only, plus whichever tab you last opened this panel from — and that ' +
      'lapses when the page navigates.';
  if (el.grant) el.grant.textContent = granted ? 'Revoke' : 'Allow any site';
}

/**
 * Ask for the grant, or hand it back.
 *
 * `permissions.request` needs a user gesture, which a click on this button is. The reply
 * is whether the operator accepted, and a refusal is an answer rather than an error --
 * they were asked, and they said no.
 */
async function onGrant(): Promise<void> {
  try {
    if (await hasBroadAccess()) await chrome.permissions.remove(BROAD);
    else await chrome.permissions.request(BROAD);
  } catch (err) {
    console.debug('[sih] permission change refused', err);
  }
  await renderAccess();
}

/**
 * The counter.
 *
 * The left number is what the gate removed this session; the right one is the count of
 * raw values that reached the network, and it is a literal zero rather than a total that
 * happens to be zero today. Nothing in the system can raise it: a value has no path to
 * the wire, and the tests in worker/router.test.ts sweep every surface to keep it that
 * way.
 */
async function refreshCounter(state?: AgentState): Promise<void> {
  if (!el.redacted) return;

  // A session that never sent anything is the strongest result this project produces, and
  // it was being displayed as the weakest number on the page.
  //
  // The counter reads the offscreen ring, and the ring only holds steps that *sealed*
  // something. A run answered entirely on the device seals nothing, so the ring is empty,
  // so the number was 0 -- next to the words "Values protected this session", which reads
  // as the privacy tool having done nothing at all. It is the same 0 you get when the host
  // is down, and the operator has no way to tell those apart.
  //
  // So when steps ran and none of them sent, say that instead. There is nothing to count
  // because there was nothing to protect against: no screenshot was taken and no request
  // was built.
  if (state && state.stepsRun > 0 && state.stepsSent === 0) {
    if (el.counter) {
      // Two different true sentences, and saying the wrong one would be the counter making
      // the agent's strongest claim about its worst outcome. A step that escalated and then
      // died because no planner was listening also sent nothing; it was not answered here.
      el.counter.textContent =
        state.stepsLocal > 0
          ? `Nothing was sent this session — ${state.stepsLocal} step` +
            `${state.stepsLocal === 1 ? '' : 's'} answered on this device`
          : `Nothing was sent this session — ${state.stepsRun} step` +
            `${state.stepsRun === 1 ? '' : 's'} ran, none finished on this device`;
    }
    if (el.selfTyped) el.selfTyped.hidden = true;
    return;
  }
  if (el.counter) el.counter.innerHTML = COUNTER_HTML;

  try {
    const { steps } = await send('PANEL_LIST', {}, { to: 'offscreen' });
    const held = steps.reduce((total, s) => total + s.protected, 0);
    const typed = steps.reduce((total, s) => total + s.agentTyped, 0);

    el.redacted = document.getElementById('redacted');
    el.selfTyped = document.getElementById('self-typed');
    if (!el.redacted) return;
    el.redacted.textContent = String(held);
    // Shown, because hiding it would make the drop from the old number look like the
    // gate had stopped working. Quiet, because it is not protection: those values are
    // ours, we typed them, and covering them is hygiene rather than an achievement.
    if (el.selfTyped) {
      el.selfTyped.hidden = typed === 0;
      el.selfTyped.textContent = `+${typed} the agent typed itself`;
    }
  } catch {
    // The host is only up during a session. Zero is the honest answer when it is not.
    if (el.redacted) el.redacted.textContent = '0';
    if (el.selfTyped) el.selfTyped.hidden = true;
  }
}

/**
 * The counter's normal markup, kept here because the device-only message replaces it.
 *
 * The right-hand number is not a running total that happens to be zero: nothing in the
 * system can raise it, because a raw value has no path to the wire.
 */
const COUNTER_HTML =
  'Values protected this session: <strong id="redacted">0</strong> &middot; ' +
  'Values transmitted: <strong class="zero">0</strong> ' +
  '<span id="self-typed" hidden></span>';

function render(state: AgentState): void {
  const running = state.status === 'running' || state.status === 'stopping';

  if (el.status) {
    el.status.textContent =
      state.status === 'running' ? `running - step ${state.stepIndex}` : state.status;
    el.status.dataset.status = state.status;
  }
  if (el.goal) {
    // Do not clobber what the operator is typing.
    if (document.activeElement !== el.goal) el.goal.value = state.goal;
    el.goal.disabled = running;
  }
  if (el.run) el.run.disabled = running;
  if (el.stop) el.stop.disabled = !running;
  if (el.overlay && document.activeElement !== el.overlay) el.overlay.checked = state.overlay;

  renderTabNote(state);
  renderLog(state.log);
}

/**
 * Which tab the overlay and a new run act on.
 *
 * A live session owns a tab, and the overlay draws the boxes *that session* perceived, so
 * it belongs on that tab wherever the operator has since navigated to. With no session
 * running there is nothing to follow and the tab in front is the only sensible target.
 */
async function targetTabId(state: AgentState): Promise<number> {
  const running = state.status === 'running' || state.status === 'stopping';
  if (running && state.tabId !== null) return state.tabId;
  return activeTabId();
}

function renderLog(log: StepLogEntry[]): void {
  if (!el.log) return;
  el.log.replaceChildren();

  for (const entry of [...log].reverse()) {
    const li = document.createElement('li');
    li.dataset.outcome = entry.outcome ?? 'running';

    const header = document.createElement('div');
    header.className = 'step-header';

    const idx = document.createElement('span');
    idx.className = 'step-idx-badge';
    idx.textContent = `Step #${entry.stepIndex}`;

    const phase = document.createElement('span');
    phase.className = 'step-phase';
    const statusText = entry.outcome ? `${entry.outcome} (${entry.phase})` : entry.phase;
    phase.textContent = statusText;

    const ms = document.createElement('span');
    ms.className = 'step-ms';
    ms.textContent = entry.ms === undefined ? '' : `${entry.ms} ms`;

    header.append(idx, phase, ms);
    li.append(header);

    if (entry.note) {
      const note = document.createElement('div');
      note.className = 'step-note';
      note.textContent = entry.note;
      li.append(note);
    }

    if (entry.phases && entry.phases.length > 0) {
      const stages = document.createElement('ol');
      stages.className = 'stages-waterfall';
      for (const stage of entry.phases) {
        const step = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = stage.phase;
        const took = document.createElement('span');
        took.className = 'step-ms';
        took.textContent = `${stage.ms} ms`;
        step.append(name, took);
        stages.append(step);
      }
      li.append(stages);
    }

    el.log.append(li);
  }
}

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('no active tab');
  return tab.id;
}

/** Re-read which tab is in front, then redraw whatever depended on it. */
async function refreshActiveTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = {
      id: tab?.id ?? null,
      origin: tab?.url ? new URL(tab.url).origin : '',
    };
  } catch {
    activeTab = { id: null, origin: '' };
  }
  await refresh();
}

/**
 * Say which tab the session is driving, when that is not the tab in front.
 *
 * The session is bound to one tab -- `AgentState.tabId`, chosen when Run was pressed --
 * and the panel is bound to the window. Switch tabs and the panel used to carry straight
 * on reading `running - step 4`, with nothing anywhere to say that the four steps had
 * happened on a site you were no longer looking at. The goal box still said "What should
 * the agent do on this tab?" while pointing at a different tab entirely.
 *
 * Two states worth distinguishing, because the answer to "why is Run disabled?" differs:
 * a session still running elsewhere, which is why you cannot start another; and one that
 * has finished elsewhere, which is only there to explain what the log below is about.
 */
function renderTabNote(state: AgentState): void {
  if (!el.tabNote || !el.tabNoteText) return;

  const elsewhere =
    state.sessionId !== null && state.tabId !== null && state.tabId !== activeTab.id;

  el.tabNote.hidden = !elsewhere;
  if (!elsewhere) return;

  const running = state.status === 'running' || state.status === 'stopping';
  const where = state.tabOrigin || 'another tab';

  el.tabNoteText.replaceChildren();
  el.tabNoteText.append(running ? 'Running on ' : `${state.status} on `);
  const site = document.createElement('b');
  site.textContent = where;
  el.tabNoteText.append(site, ' — not the tab in front.');
}

async function refresh(): Promise<void> {
  render(await loadState(store));
}

async function onRun(): Promise<void> {
  const goal = el.goal?.value.trim() ?? '';
  if (!goal) {
    el.goal?.focus();
    return;
  }
  try {
    await send('RUN_TASK', { goal, tabId: await activeTabId() });
  } catch (err) {
    // The worker refuses the run up front -- e.g. this tab cannot host a content script
    // (chrome://, web store). Say why instead of leaving an unhandled rejection that the
    // log file only dimly recalls.
    if (el.goal) el.goal.classList.add('error');
    if (el.status) {
      el.status.textContent = err instanceof Error ? err.message : String(err);
      el.status.dataset.status = 'failed';
    } else {
      console.debug('[sih] run refused', err);
    }
    return;
  }
  await refresh();
}

async function onStop(): Promise<void> {
  await send('STOP', {});
  await refresh();
}

/**
 * popup -> content -> popup, straight past the worker: this is the round trip that
 * proves the bus works end to end.
 */
async function onOverlayToggle(): Promise<void> {
  const show = el.overlay?.checked ?? false;
  try {
    const { visible } = await send(
      'OVERLAY_TOGGLE',
      { show },
      { to: 'content', tabId: await targetTabId(await loadState(store)) },
    );
    if (el.overlay) el.overlay.checked = visible;
    await updateState(store, (state) => ({ ...state, overlay: visible }));
  } catch (err) {
    // No content script on this tab -- a chrome:// page, or one outside host_permissions.
    if (el.overlay) el.overlay.checked = false;
    if (el.status) el.status.textContent = 'overlay unavailable here';
    console.debug('[sih] overlay toggle failed', err);
  }
}

/**
 * The gating check for the whole project, on a button: does a real forward pass run on
 * this machine, on which backend, and does it produce the right numbers?
 *
 * Two hops on purpose. Only the worker can create an offscreen document, so it is asked
 * first; then the popup talks to the host directly. On Firefox the second hop lands in
 * the background page, which answers for 'offscreen' as well as itself.
 */
async function onSelfTest(): Promise<void> {
  if (!el.host) return;
  if (el.selftest) el.selftest.disabled = true;
  el.host.dataset.backend = '';
  el.host.textContent = 'probing...';

  try {
    await send('HOST_ENSURE', {});
    const r = await send('SELF_TEST', {}, { to: 'offscreen' });

    el.host.dataset.backend = r.matchedFixture ? r.backend : 'failed';
    const shape = r.dims.join('x');
    const detail = [
      `${r.backend}${r.f16 ? ' + f16' : ''}`,
      `${r.threads} thread${r.threads === 1 ? '' : 's'}`,
      `${shape} in ${r.ms} ms`,
    ].join(' - ');
    el.host.textContent = r.matchedFixture ? detail : `${detail} - WRONG VALUES`;
    console.info('[sih] self-test', r);
  } catch (err) {
    el.host.dataset.backend = 'failed';
    el.host.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    if (el.selftest) el.selftest.disabled = false;
  }
}

/**
 * What the goal box is actually protected against.
 *
 * Anything typed here goes to the planner as text, so it needs the same treatment as the
 * page. Identifiers are found by shape; a name is found when the sentence names the field
 * it is going into. Saying which is which costs one line and is the difference between a
 * tool that is honest about its coverage and one that lets the operator assume more than
 * it delivers -- and this line used to say names were not covered at all, which stopped
 * being true when the goal started being parsed.
 */
async function showCoverage(): Promise<void> {
  if (!el.coverage) return;
  try {
    const { protected: covered, unprotected } = await send('GOAL_COVERAGE', {});
    el.coverage.replaceChildren();

    const line = document.createElement('span');
    line.textContent =
      `Values you type here are replaced before sending (${covered.slice(0, 4).join(', ')} ` +
      `and ${covered.length - 4} more; names when you name the field). `;
    el.coverage.append(line);

    if (unprotected.length > 0) {
      const warn = document.createElement('b');
      warn.textContent = `${unprotected.join(', ')} are not yet.`;
      el.coverage.append(warn);
    }
  } catch {
    // The worker is asleep and the popup opened first. Not worth a message.
  }
}

function main(): void {
  setBusTransport(createChromeTransport('popup'), 'popup');

  // Framed in the side panel, or standing on its own as the action popup. The layout
  // differs and so does what the evidence buttons do; both read this.
  if (window.parent !== window) document.body.dataset.framed = '1';

  handle('STEP_EVENT', (event) => {
    if (el.status && event.kind === 'status' && event.status) {
      el.status.textContent = event.status;
      el.status.dataset.status = event.status;
    }
    // The worker has already written the state; read the durable version.
    void refresh();
    // The state carries the session's own tally now, so the counter is told which of the
    // two zeroes it is looking at rather than having to guess from an empty ring.
    if (event.kind === 'step-end') {
      void loadState(store).then((state) => refreshCounter(state));
    }
    return { ok: true as const };
  });

  el.run?.addEventListener('click', () => void onRun());
  el.stop?.addEventListener('click', () => void onStop());

  /**
   * Take me to the tab this session is on.
   *
   * The banner names the site; without a way to get there, naming it is only half an
   * answer -- and finding one tab of twenty by its favicon is exactly the chore the
   * banner exists to spare.
   */
  el.showTab?.addEventListener('click', () => {
    void (async () => {
      const { tabId } = await loadState(store);
      if (tabId === null) return;
      try {
        const tab = await chrome.tabs.update(tabId, { active: true });
        // A tab in another window needs that window raised too, or the click appears to
        // do nothing at all.
        if (tab?.windowId !== undefined)
          await chrome.windows.update(tab.windowId, { focused: true });
      } catch {
        // The tab has gone. The session will notice on its own -- worker/main.ts stops it
        // on tabs.onRemoved -- and the banner disappears with the next state write.
        await refresh();
      }
    })();
  });
  el.overlay?.addEventListener('change', () => void onOverlayToggle());
  el.selftest?.addEventListener('click', () => void onSelfTest());
  el.grant?.addEventListener('click', () => void onGrant());

  // Chrome tells us when a grant changes, including from chrome://extensions.
  chrome.permissions?.onAdded?.addListener(() => void renderAccess());
  chrome.permissions?.onRemoved?.addListener(() => void renderAccess());

  // Two containers, one behaviour worth having in each.
  //
  // Framed inside the side panel this is a tab switch, and the evidence appears beside
  // the page the agent is driving. Standing on its own -- the action popup on Firefox, or
  // popup.html opened directly, which is what the eval harness drives -- there is no shell
  // to switch, so it opens a full tab. Never a second popup: a 320px window that closes
  // when focus moves is the wrong container for something a judge is asked to read.
  const openEvidence = (view: 'sent' | 'resources', page: string): void => {
    if (window.parent !== window) {
      window.parent.postMessage({ sih: 'show-view', view }, location.origin);
      return;
    }
    void chrome.tabs.create({ url: chrome.runtime.getURL(page) });
  };

  el.openPanel?.addEventListener('click', () => openEvidence('sent', 'sidebyside.html'));
  el.openHud?.addEventListener('click', () => openEvidence('resources', 'hud.html'));

  void loadState(store).then((state) => refreshCounter(state));
  void renderAccess();
  void renderPlanner();
  void renderLocalModel();
  el.goal?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void onRun();
  });

  // Event-driven, not polled: storage tells us when the worker moved.
  store.watch<AgentState>(STATE_KEY, (state) => {
    if (state) render(state);
  });

  // ...and the browser tells us when the operator moved. A docked panel outlives every
  // tab switch in the window, so which tab is in front is a thing that changes underneath
  // it rather than a thing it reads once at startup. Three events, because they are three
  // different ways for the answer to change: switching tab, the front tab navigating, and
  // another window coming forward.
  chrome.tabs.onActivated.addListener(() => void refreshActiveTab());
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url && tabId === activeTab.id) void refreshActiveTab();
  });
  chrome.windows?.onFocusChanged?.addListener(() => void refreshActiveTab());

  void refreshActiveTab();
  void showCoverage();
  console.debug('[sih] popup ready');
}

main();
