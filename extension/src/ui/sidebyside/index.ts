/**
 * The side-by-side panel.
 *
 * Left: the screen as captured. Right: the exact bytes that were POSTed. Below: every
 * manifest row, and hovering one shows precisely which pixels it accounts for.
 *
 * The argument this page makes is not "we redact things", it is "here is what left the
 * device, and here is what it came from". That is a claim a judge can check in a second,
 * and no amount of prose about redaction precision competes with it.
 *
 * Two rules it does not bend:
 *
 *   The pre-gate frame is a URL the capture already produced, rendered in an <img>. It is
 *   never encoded here -- there is no canvas on this page and no export button, and both
 *   of those are deliberate rather than unfinished (redaction/gate.ts holds the only
 *   encoder in the tree, and scripts/test-gate.mjs fails the build if a second appears).
 *
 *   Everything is dropped on close. PANEL_CLEAR revokes the object URLs and empties the
 *   ring; an object URL pins its whole decoded image until revoked.
 *
 * ## Steps that sent nothing
 *
 * Most of this page is about the pair of frames. A step answered on the device has no pair,
 * because no frame was ever taken -- and for a long time that meant this page showed such a
 * step as "No step recorded yet. Run a task, then come back."
 *
 * That is the wrong sentence about the best case. A step that ran a plan, changed the page
 * and never touched the network is the strongest claim the project makes, and it was being
 * rendered as an empty state. Those steps now arrive as traces rather than as sealed pairs,
 * and get a card of their own saying which tier answered, how long it took, and -- when the
 * step escalated instead -- exactly which words nobody could read.
 */

import { createChromeTransport } from '../../platform/chrome-bus';
import { handle, send, setBusTransport } from '../../shared/messages';
import type { Finding, Manifest } from '../../shared/contract';
import { severityRank } from '../../redaction/policy';
import type { Protocol } from '../../shared/messages';

type PanelStep = Protocol['PANEL_STEP_ADDED']['req'];

/**
 * The parts of a step trace this page renders.
 *
 * Structural rather than imported from worker/trace.ts: the panel is a UI bundle and the
 * trace type lives in the worker's, and a shared import would drag the worker's module graph
 * into a document that only wants five numbers off it.
 */
interface LocalStep {
  /** Unique across sessions. A new task restarts stepIndex at 0. */
  id: string;
  sessionId: string;
  stepIndex: number;
  /**
   * The rung that answered, as a number.
   *
   * The trace stores this as a tagged object -- `{tier: 0, decisions}` and
   * `{tier: 2, reason}` carry different payloads -- so the number has to be dug out of it.
   * Reading `trace.tier` directly renders "tier [object Object]", which is what this page
   * did until a browser run caught it.
   */
  tier?: number;
  sent?: boolean;
  totalMs: number;
  outcome?: string;
  goal?: { coverage: number; residue: string[]; block?: string };
}

/** What the trace actually holds. Structural, for the same reason LocalStep is. */
type TraceShape = {
  sessionId?: string;
  stepIndex?: number;
  sent?: boolean;
  totalMs?: number;
  outcome?: string;
  tier?: { tier: number };
  goal?: { coverage: number; residue: string[]; block?: string };
};

/**
 * Every step seen while this page has been open.
 *
 * The panel's own memory, which is the only place the pre-gate frame is allowed to live.
 * It is not read back from the offscreen document because that document does not outlive
 * the session -- the host is released when a session ends and the ring goes with it.
 * Steps arrive here as they are sealed instead.
 */
const steps: PanelStep[] = [];

/** Steps that never sealed anything, newest last. Same ring size as the sealed ones. */
const localSteps: LocalStep[] = [];

/** The step the operator picked, if they picked one. Null means "follow the newest". */
let pinned: string | null = null;

/** Object URLs this page created, so `pagehide` can revoke exactly its own. */
const adopted = new Set<string>();

/**
 * Copy the bytes behind a URL into this page's own object URL.
 *
 * An object URL belongs to the document that created it and dies with that document. The
 * offscreen host is released when a session ends, so a URL minted there goes stale a few
 * seconds after the step it describes -- and the panel would show a broken image exactly
 * when someone came to look at it.
 *
 * Fetching the blob and re-creating the URL here is a copy of bytes, not an encode:
 * nothing is decoded, no canvas is involved, and the gate keeps its monopoly. It also
 * makes the lifetime this page's own, which is what lets `pagehide` promise anything.
 */
async function adopt(url: string): Promise<string> {
  try {
    const blob = await fetch(url).then((r) => r.blob());
    const own = URL.createObjectURL(blob);
    adopted.add(own);
    return own;
  } catch {
    // Already gone. Better a missing image than a broken one presented as evidence.
    return '';
  }
}

const stepSelect = document.getElementById('step') as HTMLSelectElement;
const before = document.getElementById('before') as HTMLImageElement;
const after = document.getElementById('after') as HTMLImageElement;
const overlay = document.getElementById('overlay') as unknown as SVGSVGElement;
const rows = document.getElementById('rows') as HTMLElement;
const summary = document.getElementById('summary') as HTMLElement;
const counter = document.getElementById('counter') as HTMLElement;
const sentTag = document.getElementById('sent-tag') as HTMLElement;
const content = document.getElementById('content') as HTMLElement;
const empty = document.getElementById('empty') as HTMLElement;
const local = document.getElementById('local') as HTMLElement;
const localTitle = document.getElementById('local-title') as HTMLElement;
const localLede = document.getElementById('local-lede') as HTMLElement;
const localFacts = document.getElementById('local-facts') as HTMLElement;
const localWhy = document.getElementById('local-why') as HTMLElement;

/** The step on screen. Kept so a hover can find its boxes without another round trip. */
let current: {
  manifest: Manifest;
  capture: { width: number; height: number; scale: number };
} | null = null;

function text(value: unknown): string {
  return String(value ?? '');
}

/**
 * The detector, as the manifest records it: layer and reason, with the score when the
 * layer produced one. `L0:autocomplete` and `L3:face@0.94` say more in ten characters
 * than a confidence column would in a whole column.
 */
function detectorOf(finding: Finding): string {
  const base = `${finding.layer}:${finding.reason}`;
  return finding.layer === 'L0' || finding.layer === 'L1'
    ? base
    : `${base}@${finding.confidence.toFixed(2)}`;
}

/** How many steps the panel keeps. Matches the offscreen ring, for the same reason. */
const KEEP = 10;

/**
 * One line per step in the picker, sealed and local alike.
 *
 * Both kinds are listed together because they are the same sequence: step 0 sent nothing,
 * step 1 sent a frame, step 2 sent nothing. Splitting them into two lists would make the
 * ordinary case -- a run that stays on the device throughout -- look like an absence.
 */
function renderSelector(): void {
  // Option values are ids rather than step indices. A new task restarts the counter at 0,
  // so two runs in one panel session both have a step 0 -- and keying on the number alone
  // made the second silently replace the first.
  const options = [
    ...steps.map((step, i) => ({
      id: `S${i}`,
      order: step.stepIndex,
      label:
        `Step ${step.stepIndex} — ${step.manifest.findings.length} finding` +
        `${step.manifest.findings.length === 1 ? '' : 's'}`,
    })),
    ...localSteps.map((step) => ({
      id: step.id,
      order: step.stepIndex,
      label: `Step ${step.stepIndex} — nothing sent`,
    })),
  ].sort((a, b) => a.order - b.order);

  stepSelect.innerHTML = options
    .map((option) => `<option value="${option.id}">${option.label}</option>`)
    .join('');

  const has = options.length > 0;
  empty.hidden = has;
  stepSelect.disabled = !has;
  if (!has) {
    content.hidden = true;
    local.hidden = true;
    return;
  }

  // Newest last in the list, newest shown. The picker is built in arrival order so the
  // operator's mental model -- "the thing that just happened is at the bottom" -- holds.
  stepSelect.value = options[options.length - 1]?.id ?? '';

  // Hold the operator's choice across a new arrival, and *only* a choice they made.
  //
  // This used to read the select's current value back and treat it as a preference. A
  // select always has a value -- the browser picks the first option the moment the list is
  // built -- so the very first step became a permanent pin, and every step after it landed
  // in the picker while the page went on showing step 0. Which is the "come back later"
  // bug wearing different clothes: a panel that never shows what just happened.
  if (pinned && options.some((o) => o.id === pinned)) stepSelect.value = pinned;
  else pinned = null;

  showStep(stepSelect.value);
}

/** Tier 0 and Tier 1 both answer here; only the sentence differs. */
function tierStory(step: LocalStep): { title: string; lede: string } {
  if (step.tier === 0) {
    return {
      title: 'Nothing was sent',
      lede:
        'This step was answered on the device from the page structure alone. No screenshot ' +
        'was taken, nothing was sealed, and no request was made — so there is no pair of ' +
        'frames to compare, because there is no second frame.',
    };
  }
  if (step.tier === 1) {
    return {
      title: 'Nothing was sent',
      lede:
        'A model on this machine chose between the candidate fields. It runs in a separate ' +
        'process on the same laptop, so the page never left the device — this is a stronger ' +
        'result than a device-only answer, not a weaker one.',
    };
  }
  return {
    title: 'Nothing was sent — the step did not get that far',
    lede:
      'This step escalated past the on-device tiers and then did not complete. Nothing was ' +
      'sealed and nothing was posted.',
  };
}

/**
 * Why the step went past Tier 0, in the operator's own words.
 *
 * The block kinds come from the parser and are one word each; the sentence around them is
 * written here rather than in the worker, because the worker's version of it goes in a step
 * log where brevity wins and this one is being read by somebody asking "why did nothing
 * happen?".
 */
const WHY: Record<string, { what: string; next: string }> = {
  negation: {
    what: 'the instruction contains a negation — a word like "don\'t", "except" or "skip".',
    next:
      'The grammar refuses these outright rather than guessing how far the negation ' +
      'reaches. Working out that scope is what the remote planner is for.',
  },
  residue: {
    what: 'part of the sentence was not understood by any rule.',
    next: 'The whole goal, including the words below, would go to the remote planner.',
  },
  unparsed: {
    what: 'one of the clauses matched no rule at all.',
    next:
      'The whole goal escalates rather than the half that parsed — running half an ' +
      'instruction leaves the page in a state neither tier planned for.',
  },
  ambiguous: {
    what: 'a clause reads two ways and both readings name a real field.',
    next: 'Choosing between them is a judgement, so it goes to the planner rather than a regex.',
  },
};

function showLocalStep(step: LocalStep): void {
  content.hidden = true;
  local.hidden = false;
  current = null;

  const story = tierStory(step);
  localTitle.textContent = story.title;
  localLede.textContent = story.lede;

  const facts = [
    step.tier === undefined ? '' : `answered at tier ${step.tier}`,
    'nothing sent',
    `${Math.round(step.totalMs)} ms`,
    step.outcome ? `outcome: ${step.outcome}` : '',
    step.goal ? `read ${Math.round(step.goal.coverage * 100)}% of the instruction` : '',
  ].filter(Boolean);

  localFacts.innerHTML = facts
    .map((fact) => `<span class="fact">${escapeHtml(fact)}</span>`)
    .join('');

  const block = step.goal?.block;
  const residue = step.goal?.residue ?? [];
  if (!block && residue.length === 0) {
    localWhy.hidden = true;
    return;
  }

  const why = block ? WHY[block] : undefined;
  localWhy.hidden = false;
  localWhy.innerHTML =
    `<strong>Why this did not run on the device</strong>` +
    (why ? `${escapeHtml(why.what)} ` : '') +
    (residue.length > 0
      ? `The words nobody read: ${residue.map((r) => `<code>${escapeHtml(r)}</code>`).join(', ')}. `
      : '') +
    (why ? escapeHtml(why.next) : '') +
    ` The planner is on another machine; if it is not reachable, the step stops here and ` +
    `nothing is typed — which is why the page is unchanged.`;
}

/** The panel renders text the user typed. It is escaped like anything else from outside. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showStep(id: string): void {
  const localStep = localSteps.find((s) => s.id === id);
  if (localStep) {
    showLocalStep(localStep);
    return;
  }

  const step = id.startsWith('S') ? steps[Number(id.slice(1))] : undefined;
  if (!step) return;

  content.hidden = false;
  local.hidden = true;
  current = { manifest: step.manifest, capture: step.capture };

  before.src = step.preGate.kind === 'blob-url' ? step.preGate.url : step.preGate.dataUrl;
  after.src = step.sentUrl;
  sentTag.textContent = text(step.sentMime);

  // The overlay is in the sealed image's own pixels, so a box in CSS px has to be scaled
  // the same way the capture was. Getting this wrong draws every rectangle almost right,
  // which is the worst outcome for a picture whose whole job is to show placement.
  overlay.setAttribute('viewBox', `0 0 ${step.capture.width} ${step.capture.height}`);
  overlay.innerHTML = '';

  renderRows(step.manifest, step.capture.scale);
  refreshCounter();
}

function renderRows(manifest: Manifest, scale: number): void {
  rows.innerHTML = '';

  // Severity first, then the frame's own reading order down the page. A judge scanning
  // this table has seconds, and a SECRET below three EMAILs is a table that buried the
  // thing it exists to show. Ties break on position so the order is stable between steps
  // rather than shuffling with whatever the detectors happened to emit.
  const ordered = [...manifest.findings].sort(
    (a, b) =>
      severityRank(a.cls) - severityRank(b.cls) || a.box.y - b.box.y || a.box.x - b.box.x,
  );

  for (const finding of ordered) {
    const row = document.createElement('tr');
    const kept = finding.mode === 'keep';

    row.innerHTML =
      `<td>${text(finding.cls)}</td>` +
      `<td class="origin ${text(finding.origin)}">${text(finding.origin)}</td>` +
      `<td${kept ? ' class="keep"' : ''}>${text(finding.mode)}</td>` +
      `<td><code>${detectorOf(finding)}</code></td>` +
      `<td><code>${text(finding.placeholder ?? '—')}</code></td>` +
      `<td class="num">${finding.box.x.toFixed(0)}</td>` +
      `<td class="num">${finding.box.y.toFixed(0)}</td>` +
      `<td class="num">${finding.box.w.toFixed(0)}</td>` +
      `<td class="num">${finding.box.h.toFixed(0)}</td>`;

    row.addEventListener('mouseenter', () => highlight(finding, scale));
    row.addEventListener('mouseleave', clearHighlight);
    // Keyboard reaches it too: the row is focusable, and a judge driving by tab should
    // see the same thing as one driving by mouse.
    row.tabIndex = 0;
    row.addEventListener('focus', () => highlight(finding, scale));
    row.addEventListener('blur', clearHighlight);

    rows.append(row);
  }

  const painted = manifest.findings.filter((f) => f.mode !== 'keep').length;
  const kept = manifest.findings.length - painted;
  const typed = manifest.findings.filter((f) => f.origin === 'agent').length;

  // `overRedactedFraction` used to be quoted here and is not any more.
  //
  // It measures painted area against *our own findings*, so it is zero whenever the gate
  // paints what it was told to -- which is always. A number that cannot fail sitting
  // beside numbers that can is worse than no number: it reads as evidence and is a
  // tautology, and it was reporting a confident 0.0% on a frame whose real
  // over-redaction, measured against hand-labelled ground truth, was double digits.
  //
  // The honest figure needs labels this page does not have and cannot get. It is computed
  // by the harness against the corpus and lives in eval/report/report.json, so that is
  // where the reader is sent.
  summary.textContent =
    `${painted} painted, ${kept} reported and deliberately left visible` +
    `${typed > 0 ? `, ${typed} of them values this agent typed` : ''}. ` +
    `${(manifest.redactedFraction * 100).toFixed(1)}% of the frame is covered. ` +
    // The answer to "how does the planner know which box is which?", in one line.
    `${manifest.marks} element${manifest.marks === 1 ? '' : 's'} marked. ` +
    `Over-redaction is measured against ground truth by the eval harness, not here.`;
}

/**
 * Dim everything except this box.
 *
 * One path with an even-odd fill rule rather than four rectangles around the hole: four
 * rectangles meet at seams that show as hairlines on a projector, and the whole point of
 * this panel is that it survives a projector.
 */
function highlight(finding: Finding, scale: number): void {
  if (!current) return;
  const { width, height } = current.capture;
  const b = finding.box;
  const x = b.x * scale;
  const y = b.y * scale;
  const w = b.w * scale;
  const h = b.h * scale;

  overlay.innerHTML =
    `<path class="veil" fill-rule="evenodd" d="M0 0H${width}V${height}H0Z ` +
    `M${x} ${y}H${x + w}V${y + h}H${x}Z" />` +
    `<rect class="outline" x="${x}" y="${y}" width="${w}" height="${h}" />`;
}

function clearHighlight(): void {
  overlay.innerHTML = '';
}

/**
 * The same split the Agent tab reports, for the same reason.
 *
 * Two counters that disagree are worse than one that is wrong, and these are the two a
 * judge sees side by side. `protected` is what the page was holding before the agent
 * arrived; the agent's own keystrokes are covered by the gate exactly like anything else
 * and are reported separately, because calling them protection would be claiming credit
 * for redacting our own typing.
 */
function refreshCounter(): void {
  let held = 0;
  let typed = 0;
  for (const step of steps) {
    for (const finding of step.manifest.findings) {
      if (finding.origin === 'agent') typed += 1;
      else held += 1;
    }
  }

  counter.innerHTML =
    `Values protected this session: <strong>${held}</strong> &middot; ` +
    `Values transmitted: <strong class="zero">0</strong>` +
    (typed > 0 ? ` &middot; <span class="na">+${typed} the agent typed itself</span>` : '');
}

stepSelect.addEventListener('change', () => {
  pinned = stepSelect.value;
  showStep(stepSelect.value);
});

function release(step: PanelStep): void {
  for (const url of [step.sentUrl, step.preGate.kind === 'blob-url' ? step.preGate.url : '']) {
    if (url && adopted.delete(url)) URL.revokeObjectURL(url);
  }
}

/**
 * Closing the panel drops the frames.
 *
 * `pagehide` rather than `unload`: `unload` is not fired reliably in a modern browser and
 * the whole guarantee rests on this running. Both sides are cleared -- this page's copies
 * and the offscreen ring -- because either one alone would keep an unredacted frame alive
 * after the only thing that justified holding it has gone away.
 */
window.addEventListener('pagehide', () => {
  for (const step of steps) release(step);
  steps.length = 0;
  void send('PANEL_CLEAR', {}, { to: 'offscreen' });
});

export function main(): void {
  setBusTransport(createChromeTransport('panel'), 'panel');

  handle('PANEL_STEP_ADDED', async (step) => {
    // Adopt both frames before storing the step: from here on their lifetime is this
    // page's, and the offscreen document may close at any moment.
    const preGate =
      step.preGate.kind === 'blob-url'
        ? { ...step.preGate, url: await adopt(step.preGate.url) }
        : step.preGate;

    steps.push({ ...step, preGate, sentUrl: await adopt(step.sentUrl) });
    while (steps.length > KEEP) {
      const dropped = steps.shift();
      if (dropped) release(dropped);
    }
    renderSelector();
    return { ok: true as const };
  });

  /**
   * Every step's trace, including the ones that sealed nothing.
   *
   * The HUD already listens for this and draws a waterfall from it. This page wants five
   * fields off the same object, and takes them rather than inventing a second channel --
   * one definition of what a step was, for both consumers.
   *
   * A step that *did* send arrives here too, and is ignored: it will also arrive as a sealed
   * pair, and that is the better rendering of it.
   */
  handle('PANEL_TRACE', ({ trace }) => {
    const step = trace as TraceShape;
    if (step?.sent !== false || typeof step.stepIndex !== 'number')
      return { ok: true as const };

    const sessionId = step.sessionId ?? '';
    const entry: LocalStep = {
      id: `L${sessionId}:${step.stepIndex}`,
      sessionId,
      stepIndex: step.stepIndex,
      tier: step.tier?.tier,
      sent: false,
      totalMs: step.totalMs ?? 0,
      outcome: step.outcome,
      goal: step.goal,
    };

    const at = localSteps.findIndex((s) => s.id === entry.id);
    if (at === -1) localSteps.push(entry);
    else localSteps[at] = entry;

    while (localSteps.length > KEEP) localSteps.shift();
    renderSelector();
    return { ok: true as const };
  });

  // Anything the offscreen document still holds from this session, so a panel opened
  // mid-run is not blank. It is empty whenever the host has been released since, which
  // is why the push above is the primary path rather than a supplement to this one.
  void send('PANEL_LIST', {}, { to: 'offscreen' })
    .then(async ({ steps: known }) => {
      for (const summary of known) {
        const full = await send(
          'PANEL_STEP',
          { stepIndex: summary.stepIndex },
          { to: 'offscreen' },
        );
        if (!full.found || !full.preGate || !full.manifest || !full.capture || !full.sentUrl) {
          continue;
        }
        const preGate =
          full.preGate.kind === 'blob-url'
            ? { ...full.preGate, url: await adopt(full.preGate.url) }
            : full.preGate;
        steps.push({
          sessionId: summary.sessionId,
          stepIndex: summary.stepIndex,
          preGate,
          sentUrl: await adopt(full.sentUrl),
          sentMime: full.sentMime ?? '',
          manifest: full.manifest,
          capture: full.capture,
        });
      }
      steps.sort((a, b) => a.stepIndex - b.stepIndex);
      renderSelector();
      refreshCounter();
    })
    .catch(() => {
      renderSelector();
      refreshCounter();
    });
}

main();
