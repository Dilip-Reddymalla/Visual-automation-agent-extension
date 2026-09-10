/**
 * The agent loop's vocabulary: what a step is made of and what the popup gets told
 * about it. Kept out of messages.ts so the worker's state machine and the bus can both
 * import it without a cycle.
 *
 * Node-pure by construction -- these are data shapes, not behaviour.
 */

/**
 * Where the loop is as a whole. Only `running` accepts new perception.
 *
 * `incomplete` is an ending, like `stopped`, and it exists because the alternative was a
 * lie. The loop used to end a session the moment a plan said it was done, and print "the
 * planner reported the task done" -- while a field the user had named in the same sentence
 * sat empty. "Done" is a claim an operator will believe without checking; a status that can
 * only say `stopped` or `failed` has nowhere to put "it ran, and it did not finish".
 */
export type LoopStatus = 'idle' | 'running' | 'stopping' | 'stopped' | 'incomplete' | 'failed';

/** Where one step is. The order below is the order they run in. */
export type LoopPhase =
  'idle' | 'perceive' | 'capture' | 'detect' | 'seal' | 'plan' | 'execute' | 'settle';

/** A phase a step actually runs. `idle` is the absence of one. */
export type StepPhase = Exclude<LoopPhase, 'idle'>;

/** The phases of one step, in order. */
export const PHASES: readonly StepPhase[] = [
  'perceive',
  'capture',
  'detect',
  'seal',
  'plan',
  'execute',
  'settle',
] as const;

/**
 * How one step ended.
 *
 * `incomplete` is not a failure: every phase ran, nothing threw, and the actions were
 * carried out. What it says is that the step claimed to finish the task and the completion
 * check disagreed. Kept distinct from `failed` so that a step which did some real work is
 * not filed alongside one that fell over in `capture`.
 */
export type StepOutcome = 'ok' | 'failed' | 'stopped' | 'interrupted' | 'incomplete';

/** One line in the popup's step log. Kept small: this is persisted on every change. */
export interface StepLogEntry {
  stepIndex: number;
  startedAt: number;
  endedAt?: number;
  /** Absent while the step is still running. */
  outcome?: StepOutcome;
  /** Phase reached. On a failure this is the phase that threw. */
  phase: LoopPhase;
  /**
   * Every phase this step has finished, in order, with what each cost.
   *
   * `phase` above is a single value that each phase overwrites, so the panel could only
   * ever show where the step was *now* -- perceive replaced by capture replaced by detect,
   * one line flickering through seven states and settling on whichever one it ended in. A
   * step is a sequence and it should read as one, particularly on the screen someone is
   * being shown the system on.
   *
   * Durations only, never a detail. This record is persisted.
   */
  phases?: Array<{ phase: LoopPhase; ms: number }>;
  ms?: number;
  note?: string;
}

/** Pushed to the popup as it happens. The popup may be closed; these are best-effort. */
export interface StepEvent {
  sessionId: string;
  stepIndex: number;
  at: number;
  kind: 'step-start' | 'phase' | 'step-end' | 'status' | 'error';
  phase?: LoopPhase;
  status?: LoopStatus;
  outcome?: StepOutcome;
  ms?: number;
  note?: string;
}

/** How many step log entries survive. Older ones are dropped, oldest first. */
export const LOG_LIMIT = 50;

/**
 * How many steps one task gets before the loop stops itself.
 *
 * The loop has no other terminator it owns. `finish` and `ask` come from the plan, which
 * means the only thing standing between a planner that keeps proposing the same action
 * and an agent that runs until the tab closes is the planner's own judgement. That is
 * not a safe place to put the guarantee: a model that cannot see why its last action
 * failed will cheerfully re-plan it, and each round is a screenshot, a detection pass
 * and a POST.
 *
 * Thirty is generous for anything the demo does -- the longest scripted run is eleven --
 * and small enough that a stuck loop is over in a minute rather than discovered later
 * from a fan.
 */
export const MAX_STEPS = 30;

/**
 * A step that has not been touched for this long, while the worker claimed to be busy,
 * was interrupted by the service worker being killed. MV3 does that routinely.
 *
 * It has to be longer than the longest a step can legitimately take, and that is not a
 * matter of taste. `resumeIfInterrupted` runs on every wake and clears `busy`; if a step
 * that is still running can look stale, then any inbound message during it -- a settle
 * from the page, the popup opening -- clears the flag, `canAcceptStep` says yes, and a
 * second step starts while the first is still holding a frame and a placeholder map.
 * Two concurrent steps is not a degraded mode, it is two of everything.
 *
 * This was 30 s, which is shorter than one plan phase against a local VLM
 * (transport.ts, PLAN_TIMEOUT_MS is 60 s), so the race was reachable with the planner
 * the README recommends for a laptop. The cost of the larger value is that recovery from
 * a genuine MV3 kill waits longer, which is the cheaper of the two mistakes.
 */
export const STALE_STEP_MS = 90_000;

/**
 * How many steps may act on one target before the loop stops trying.
 *
 * MAX_STEPS bounds the run; this bounds the *repetition inside* it, which is a different
 * failure. A planner that cannot see why its click missed will re-plan the same click,
 * and thirty steps of that is thirty screenshots and thirty POSTs spent on one button.
 * Three attempts is enough for a page that was still settling on the first and had moved
 * on the second; a fourth is the loop telling itself something it has already been told.
 */
export const MAX_TARGET_ATTEMPTS = 3;

/**
 * Consecutive steps that verify nothing new before the run is called stuck.
 *
 * Distinct from a failing step: these steps *succeed*. The plan is carried out, nothing
 * throws, and the ledger is the same afterwards as before -- scrolling a list that does
 * not scroll, clicking a control that does nothing. Without this the only terminator is
 * MAX_STEPS, so the cheapest possible non-progress runs the most expensive possible way.
 *
 * Four, not one: a step that only observes, or that scrolls to reveal a field it will act
 * on next step, legitimately verifies nothing.
 */
export const MAX_STALLED_STEPS = 4;

/**
 * Consecutive failed steps before the run gives up.
 *
 * `endStep` already refuses to advance `stepIndex` on a failure, so a failing step is
 * retried rather than skipped -- which is right, and which without a ceiling means a
 * genuinely broken page burns the whole step budget re-running the phase that threw.
 */
export const MAX_STEP_RETRIES = 3;
