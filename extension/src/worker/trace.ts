/**
 * One structured line per step: timings by stage, payload sizes, findings count,
 * manifest coverage, and the plan that came back.
 *
 * `eval/harness.py` reads this directly, so the shape is a contract and not a debug
 * convenience. M10 draws a waterfall on top of it; the numbers themselves are here.
 *
 * Nothing in a trace line is user data. Placeholders, classes, counts, durations and
 * outcomes only. This is the artefact most likely to end up enlarged on a slide, and a
 * trace that leaked a value would leak it to a room rather than to a server.
 */

import type { StepPhase } from '../shared/agent';
import type { VerifyReason } from '../shared/messages';
import type { PlaceholderClass } from '../shared/placeholders';

/** Bumped when the shape changes in a way the harness would misread. */
export const TRACE_VERSION = 1;

export interface TraceEvent {
  phase: StepPhase;
  ms: number;
  /** Machine-readable, never free text from the page. */
  detail?: string;
}

export interface StepTrace {
  traceVersion: number;
  sessionId: string;
  stepIndex: number;
  startedAt: number;
  events: TraceEvent[];
  totalMs: number;

  /** How many elements the walker produced. */
  elements?: number;
  /** Findings by class, and by layer. Counts only. */
  findings?: {
    total: number;
    byClass: Partial<Record<PlaceholderClass, number>>;
    byLayer: Record<string, number>;
    /**
     * page / agent / user. The split the session counter reports, per step.
     *
     * Here because `total` alone cannot answer the question the counter was getting
     * wrong: how much of this was the page's, and how much was ours. A run whose
     * findings are all `agent` protected nothing, and the trace is where that has to be
     * visible -- the manifest ring is released with the session, so after a run there is
     * nothing left to ask.
     */
    byOrigin: Record<string, number>;
  };
  /**
   * Which tier answered this step, and why it was not answered lower down.
   *
   * The number that proves Tier 0 is deciding rather than guessing is `gap`: the margin
   * between the field it chose and the runner-up. A fast path that cannot show its margin
   * is a coin toss with a confident tone of voice.
   */
  tier?:
    | {
        tier: 0;
        decisions: Array<{ target: string; index: number; score: number; gap: number }>;
      }
    | { tier: 1; reason: string; candidates: number }
    | { tier: 2; reason: string };
  /**
   * Did anything cross the network on this step?
   *
   * Beside `tier` rather than folded into it. They answer different questions -- which rung
   * decided, and whether the boundary was crossed -- and a Tier 1 answer is "tier 1, nothing
   * sent", which the trace could not previously express because a Tier 1 win was recorded by
   * overwriting the tier with 0.
   */
  sent?: boolean;
  /** Which model answered, or where the step was headed. Never a value. */
  answeredBy?: string;
  /**
   * How much of the user's sentence the grammar accounted for, and what it did not.
   *
   * On every step, not only the ones that escalate. A run whose coverage is 0.52 was acting
   * on half an instruction, and the whole point of recording it is that this was invisible:
   * the parser matched, the agent acted, the log said `ok`, and the words that reversed the
   * meaning of the sentence were never mentioned by anything.
   *
   * Class-masked, like everything else here.
   */
  goal?: { coverage: number; residue: string[]; block?: string };
  /** Per verified field, what the page held afterwards. Reasons only, never values. */
  fulfilled?: VerifyReason[];
  /**
   * The whole-document search, when the viewport could not place the sentence.
   *
   * Counts only. `offScreen > 0` with `reveals: 0` is the interesting row: the field exists
   * and the page would not scroll to it. Recorded because a search nobody can see is the
   * same class of problem as residue nobody can see -- the step just takes longer and the
   * log says nothing about why.
   */
  survey?: { controls: number; offScreen: number; reveals: number };
  /**
   * What the local model proposed, and what became of it.
   *
   * `rejected` is the field to watch. A model that keeps inventing values is a model that
   * should not be reading goals on this deployment, and without this the only evidence
   * would be steps that escalate for no visible reason.
   */
  localPlan?: { proposed: number; accepted?: number; rejected?: string; attempts?: number };
  /**
   * Was the debug overlay drawn on the page when this frame was captured?
   *
   * The overlay paints index badges over the page, so it is *in* the screenshot the
   * planner sees. A Tier 2 result that changes because somebody ticked a checkbox should
   * be explainable from the trace rather than from memory. One boolean until the capture
   * stops depending on it at all.
   */
  overlay?: boolean;
  /** Why L3 produced nothing, when it produced nothing because it broke. */
  faceError?: string;
  /** What the gate did: how much it painted, and how much of that covered nothing. */
  redaction?: {
    redactedFraction: number;
    overRedactedFraction: number;
    ops: number;
    kept: number;
  };
  /** Bytes on the wire, both directions. */
  payload?: { imageBytes: number; requestBytes: number; responseBytes: number };
  /** The plan, as action types and indices. Never the text an action would type. */
  plan?: { actions: string[]; done: boolean };
  /**
   * What the page made of each action, positionally. Outcomes only -- 'ok', 'failed',
   * 'no-op'. The executor's notes carry placeholders and indices and are fine, but they
   * are not needed here and the trace is the artefact most likely to end up on a slide.
   */
  execution?: ('ok' | 'failed' | 'no-op')[];
  /** Container boxes narrowed to the value, and dropped for want of one. Counts only. */
  containers?: { resolved: number; dropped: number };
  /** Why L2 produced nothing, when it produced nothing because it broke. */
  semanticError?: string;
  /** Text blocks the perception cap discarded. Non-zero means recall traded for payload. */
  textBlocksDropped?: number;
  outcome?: 'ok' | 'failed' | 'stopped' | 'interrupted' | 'incomplete';
  /** Machine-readable failure reason, e.g. "receipt-mismatch". */
  error?: string;
  /** Frames thrown away because the page moved (M4). */
  framesDiscarded?: number;
}

export function startStep(sessionId: string, stepIndex: number, now = Date.now()): StepTrace {
  return {
    traceVersion: TRACE_VERSION,
    sessionId,
    stepIndex,
    startedAt: now,
    events: [],
    totalMs: 0,
  };
}

export function record(trace: StepTrace, phase: StepPhase, ms: number, detail?: string): void {
  trace.events.push(detail === undefined ? { phase, ms } : { phase, ms, detail });
  trace.totalMs = trace.events.reduce((sum, e) => sum + e.ms, 0);
}

/** Per-phase totals, for the waterfall and for the report's p50/p95. */
export function phaseTotals(trace: StepTrace): Partial<Record<StepPhase, number>> {
  const totals: Partial<Record<StepPhase, number>> = {};
  for (const event of trace.events) {
    totals[event.phase] = (totals[event.phase] ?? 0) + event.ms;
  }
  return totals;
}

/**
 * The one line the harness parses. JSON, one object, no newlines inside.
 *
 * Deliberately not `console.log(object)`: a structured console object renders
 * differently in every browser and cannot be piped. A string can.
 */
export function formatTrace(trace: StepTrace): string {
  return JSON.stringify(trace);
}

export function emitTrace(trace: StepTrace, sink: (line: string) => void = console.info): void {
  sink(formatTrace(trace));
}

/**
 * A last check before a trace is written.
 *
 * Placeholders are allowed -- they are the whole point -- but a raw value is not, and
 * the cheapest way to be sure is to refuse anything that looks like free text where the
 * shape does not call for it. Returns the offending paths, empty when clean.
 */
export function auditTrace(trace: StepTrace, forbidden: Iterable<string>): string[] {
  const serialised = formatTrace(trace);
  const offenders: string[] = [];
  for (const value of forbidden) {
    if (value.length >= 3 && serialised.includes(value)) offenders.push(value);
  }
  return offenders;
}
