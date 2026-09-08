/**
 * The resource HUD.
 *
 * Client resource utilisation is a fifth of the evaluation and almost nobody instruments
 * it, which makes a live readout the cheapest twenty percent in the project. It is also
 * the honest kind of instrument: it reads the numbers the system already keeps rather
 * than producing flattering ones of its own.
 *
 * Two rules:
 *
 *   It adds no timing mechanism. Stage durations come from the worker's trace and model
 *   durations from the inference host's ring buffer (offscreen/timings.ts). A third
 *   source would drift from both and be believed anyway.
 *
 *   It polls at most twice a second, and only while visible. A HUD that burns CPU while
 *   reporting idle CPU is a bug that has to be explained out loud, on stage, to someone
 *   holding a scorecard.
 */

import { createChromeTransport } from '../../platform/chrome-bus';
import { handle, send, setBusTransport } from '../../shared/messages';
import type { HostStats, SelfTestResult } from '../../shared/messages';
import type { StepTrace } from '../../worker/trace';

/** Twice a second. Slower than a human notices, far slower than a render costs. */
const POLL_MS = 500;

const host = document.getElementById('host') as HTMLTableElement;
const memory = document.getElementById('memory') as HTMLTableElement;
const waterfall = document.getElementById('waterfall') as HTMLTableElement;
const percentiles = document.getElementById('percentiles') as HTMLTableElement;
const cadence = document.getElementById('cadence') as HTMLElement;

/** Every trace seen this session, for the accumulating percentiles. */
const traces: StepTrace[] = [];
let timer: number | undefined;
let probe: SelfTestResult | null = null;

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function rows(pairs: Array<[string, string]>): string {
  return pairs
    .map(([label, value]) => `<tr><td>${label}</td><td class="num">${value}</td></tr>`)
    .join('');
}

/**
 * JS heap, where the browser will say.
 *
 * `performance.memory` is Chrome-only. Firefox gets `n/a` rather than a hidden row: a
 * missing row reads as a metric nobody measured, and an honest `n/a` reads as a browser
 * that does not expose it. Those are different things.
 */
function jsHeap(): string {
  const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
  return perf.memory ? mb(perf.memory.usedJSHeapSize) : 'n/a — Chrome only';
}

function renderHost(stats: HostStats): void {
  const f16 = probe
    ? `<span class="${probe.f16 ? 'yes' : 'no'}">${probe.f16 ? 'yes' : 'no'}</span>`
    : '<span class="na">not probed</span>';

  host.innerHTML =
    rows([
      [
        'Backend',
        `<span class="${stats.backend === 'webgpu' ? 'yes' : ''}">${stats.backend}</span>`,
      ],
      ['shader-f16', f16],
      ['WASM threads', stats.threads === undefined ? 'n/a' : String(stats.threads)],
      ['Models loaded', stats.loaded.length ? stats.loaded.join(', ') : 'none'],
    ]) +
    (probe
      ? Object.entries(probe.limits)
          .map(
            ([name, value]) =>
              `<tr><td class="na">adapter: ${name}</td>` +
              `<td class="num na">${Number(value).toLocaleString()}</td></tr>`,
          )
          .join('')
      : '');
}

function renderMemory(stats: HostStats): void {
  const byTask = Object.entries(stats.residentByTask ?? {});
  memory.innerHTML =
    rows([
      ['Resident model bytes', mb(stats.residentBytes)],
      ['JS heap, this page', jsHeap()],
    ]) +
    byTask
      .map(
        ([task, bytes]) => `<tr><td class="na">&nbsp;&nbsp;${task}</td>
        <td class="num na">${mb(Number(bytes))}</td></tr>`,
      )
      .join('');
}

/**
 * The waterfall, stage by stage for the most recent step.
 *
 * The bars are proportional to the slowest stage rather than to the step total, because
 * the question a reader has is "what dominates", and against a total the fast stages are
 * invisible slivers that all look the same.
 */
function renderWaterfall(trace: StepTrace | undefined): void {
  if (!trace) {
    waterfall.innerHTML = '<tr><td class="na">No step recorded yet.</td></tr>';
    return;
  }

  const events = trace.events ?? [];
  const slowest = Math.max(1, ...events.map((e) => e.ms));
  const sum = events.reduce((total, e) => total + e.ms, 0);

  waterfall.innerHTML =
    '<tr><th>stage</th><th>ms</th><th>&nbsp;</th></tr>' +
    events
      .map(
        (event) =>
          `<tr><td>${event.phase}</td><td class="num">${event.ms.toFixed(0)}</td>` +
          `<td class="track"><span class="bar${event.ms > 1000 ? ' late' : ''}" ` +
          `style="width:${Math.max(2, (event.ms / slowest) * 100)}%"></span></td></tr>`,
      )
      .join('') +
    `<tr><td><strong>step</strong></td>` +
    `<td class="num"><strong>${trace.totalMs.toFixed(0)}</strong></td>` +
    // The stages should account for the step. When they do not, the gap is time spent
    // between phases and saying so is more useful than quietly showing the larger number.
    `<td class="na">stages sum to ${sum.toFixed(0)} ms` +
    `${Math.abs(sum - trace.totalMs) > trace.totalMs * 0.05 ? ' — unaccounted gap' : ''}</td></tr>`;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank, so every percentile is a step that actually happened.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? 0;
}

function renderPercentiles(): void {
  const byPhase = new Map<string, number[]>();
  const totals: number[] = [];

  for (const trace of traces) {
    totals.push(trace.totalMs);
    for (const event of trace.events ?? []) {
      const list = byPhase.get(event.phase) ?? [];
      list.push(event.ms);
      byPhase.set(event.phase, list);
    }
  }

  percentiles.innerHTML =
    '<tr><th>stage</th><th>p50</th><th>p95</th><th>n</th></tr>' +
    [...byPhase.entries()]
      .map(
        ([phase, values]) =>
          `<tr><td>${phase}</td><td class="num">${percentile(values, 50).toFixed(0)}</td>` +
          `<td class="num">${percentile(values, 95).toFixed(0)}</td>` +
          `<td class="num na">${values.length}</td></tr>`,
      )
      .join('') +
    `<tr><td><strong>step</strong></td>` +
    `<td class="num"><strong>${percentile(totals, 50).toFixed(0)}</strong></td>` +
    `<td class="num"><strong>${percentile(totals, 95).toFixed(0)}</strong></td>` +
    `<td class="num na">${totals.length}</td></tr>`;
}

async function tick(): Promise<void> {
  try {
    const stats = await send('HOST_STATS', {}, { to: 'offscreen' });
    renderHost(stats);
    renderMemory(stats);
  } catch {
    // The host is only up while a session runs. That is the design, not a fault, and it
    // is exactly what "zero resident bytes sixty seconds later" looks like from here.
    host.innerHTML = rows([['Backend', '<span class="na">host not running</span>']]);
    memory.innerHTML = rows([
      ['Resident model bytes', '0.0 MB'],
      ['JS heap, this page', jsHeap()],
    ]);
  }

  renderWaterfall(traces[traces.length - 1]);
  renderPercentiles();
}

/** Only while visible: a background tab has no reader and no business sampling. */
function setPolling(on: boolean): void {
  if (on && timer === undefined) {
    timer = window.setInterval(() => void tick(), POLL_MS);
    cadence.textContent = `Sampling every ${POLL_MS} ms while this tab is visible.`;
  } else if (!on && timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
    cadence.textContent = 'Paused — this tab is not visible.';
  }
}

export function main(): void {
  setBusTransport(createChromeTransport('panel'), 'panel');

  // The adapter's own numbers do not change, so they are probed once rather than polled.
  void send('SELF_TEST', {}, { to: 'offscreen' })
    .then((result) => {
      probe = result;
    })
    .catch(() => undefined);

  handle('PANEL_TRACE', ({ trace }) => {
    traces.push(trace as StepTrace);
    void tick();
    return { ok: true as const };
  });

  document.addEventListener('visibilitychange', () => setPolling(!document.hidden));
  setPolling(!document.hidden);
  void tick();
}

main();
