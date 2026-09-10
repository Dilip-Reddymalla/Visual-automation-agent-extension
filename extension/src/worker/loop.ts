/**
 * The agent loop as a state machine: pure functions from state to state.
 *
 * Nothing here does I/O, so the awkward cases -- stop arriving mid-step, the service
 * worker being killed between phases, a second PERCEIVE landing while one is running --
 * are all unit-testable without a browser. router.ts does the I/O and calls these.
 *
 * There is no timer anywhere in this file. The loop advances on events only: a user
 * command, a DOM settle, an action completing, a navigation (CLAUDE.md invariant 7).
 */

import {
  MAX_STEPS,
  STALE_STEP_MS,
  type LoopPhase,
  type LoopStatus,
  type StepLogEntry,
  type StepOutcome,
} from '../shared/agent';
import { pushLog, upsertLog, type AgentState } from './state';
import type { GoalBlock, Intent } from './intent';
import { adoptPlan, emptyProgress } from './progress';
import type { Subgoal } from '../shared/contract';

export interface StartOptions {
  sessionId: string;
  goal: string;
  tabId: number;
  /** Where that tab is, for the panel to name. Empty when it could not be read. */
  tabOrigin?: string;
  /** The parsed sentence, tokenised. Empty when nothing parsed. */
  intents?: Intent[];
  openEnded?: boolean;
  /** Words of the goal nobody read, class-masked. Empty when it was read whole. */
  residue?: string[];
  coverage?: number;
  /** Why Tier 0 may not act on this goal. See intent.ts. */
  block?: GoalBlock;
  /**
   * How the goal was broken up, when it was worth breaking up. See decompose.ts.
   *
   * Empty for a single-field instruction, which is not a multi-step task and gets no
   * plan: the loop then behaves exactly as it did before plans existed.
   */
  plan?: readonly Subgoal[];
  now: number;
}

export function startTask(state: AgentState, options: StartOptions): AgentState {
  return {
    ...state,
    sessionId: options.sessionId,
    goal: options.goal,
    tabId: options.tabId,
    tabOrigin: options.tabOrigin ?? '',
    intents: options.intents ?? [],
    openEnded: options.openEnded ?? true,
    residue: options.residue ?? [],
    coverage: options.coverage ?? 1,
    block: options.block ?? null,
    // A new task, a new tally. The old one described a different goal.
    stepsRun: 0,
    stepsSent: 0,
    stepsLocal: 0,
    status: 'running',
    phase: 'idle',
    stepIndex: 0,
    busy: false,
    // Whatever the previous session was owed, it was owed on another goal.
    pendingPerceive: false,
    // As with the log: a ledger of verified work describes the goal it was collected
    // under, and carrying it into a new one would let a new task inherit a completion
    // it never earned. The decomposition of the *new* goal is the one thing that starts
    // populated, because it was derived from the sentence that started this task.
    progress: adoptPlan(emptyProgress(), options.plan ?? [], 0),
    startedAt: options.now,
    updatedAt: options.now,
    // A new task starts with a clean log; the old one belonged to a different goal.
    log: [],
  };
}

/** Only a running, not-busy session takes new work. */
export function canAcceptStep(state: AgentState): boolean {
  return state.status === 'running' && !state.busy && state.sessionId !== null;
}

/** This task has had its allowance of steps. See MAX_STEPS for why there is one. */
export function budgetSpent(state: AgentState): boolean {
  return state.stepIndex >= MAX_STEPS;
}

/**
 * End a session that ran out of steps, with a log line saying so.
 *
 * A step budget that stops the loop silently is barely better than no budget: the popup
 * would show `stopped` with a last entry reading `ok`, and the operator would have to
 * count log lines to work out why. So the reason goes in the log, where the rest of the
 * session's history already is.
 */
export function exhaust(state: AgentState, now: number): AgentState {
  return halt(state, {
    status: 'stopped',
    outcome: 'stopped',
    note: `stopped after ${MAX_STEPS} steps without the plan finishing`,
    now,
  });
}

export interface HaltOptions {
  status: LoopStatus;
  outcome: StepOutcome;
  note: string;
  now: number;
}

/**
 * End a run the loop itself decided to end, with the reason in the log.
 *
 * Three of these exist and they are different endings, which is why the status is a
 * parameter rather than always `stopped`. Running out of steps is a budget; three failed
 * steps in a row is a failure; four steps that changed nothing is a run that did not
 * finish -- and `incomplete` is the status this project added precisely so that last one
 * has somewhere honest to go.
 *
 * The note goes in the log rather than only in an event, because the log is what a panel
 * opened afterwards reads, and "why did this stop" is the question it is opened to answer.
 */
export function halt(state: AgentState, options: HaltOptions): AgentState {
  return {
    ...state,
    status: options.status,
    phase: 'idle',
    busy: false,
    updatedAt: options.now,
    log: pushLog(state.log, {
      stepIndex: state.stepIndex,
      startedAt: options.now,
      endedAt: options.now,
      ms: 0,
      outcome: options.outcome,
      phase: 'idle',
      note: options.note,
    }),
  };
}

export function beginStep(state: AgentState, now: number): AgentState {
  const entry: StepLogEntry = {
    stepIndex: state.stepIndex,
    startedAt: now,
    phase: 'perceive',
  };
  return {
    ...state,
    busy: true,
    phase: 'perceive',
    // This step is the look that any earlier request was asking for. Anything that
    // arrives from here on is about the page as this step will leave it, and stays set.
    pendingPerceive: false,
    updatedAt: now,
    log: pushLog(state.log, entry),
  };
}

export function enterPhase(state: AgentState, phase: LoopPhase, now: number): AgentState {
  return {
    ...state,
    phase,
    updatedAt: now,
    log: upsertLog(state.log, {
      ...currentEntry(state, now),
      phase,
    }),
  };
}

/**
 * Note that a phase finished, and what it cost.
 *
 * Appended rather than replacing `phase`, so the log holds the whole sequence. The write
 * rides along with the one `enterPhase` already does per phase, so this costs no extra
 * round trip to storage.
 */
export function recordPhase(
  state: AgentState,
  phase: LoopPhase,
  ms: number,
  now: number,
): AgentState {
  const entry = currentEntry(state, now);
  return {
    ...state,
    updatedAt: now,
    log: upsertLog(state.log, {
      ...entry,
      phases: [...(entry.phases ?? []), { phase, ms }],
    }),
  };
}

export interface EndStepOptions {
  outcome: StepOutcome;
  now: number;
  note?: string;
  /**
   * This step failed for a reason another step might not.
   *
   * A failed step used to end the whole session, and for a one-step task that was right:
   * there was nothing left to salvage. On a multi-step run it is wrong, and expensively
   * so -- a frame discarded because the page moved between measuring and photographing it
   * is a *frame* problem, and the session it killed had already filled the form.
   *
   * So a transient failure leaves the session `running` and the next step retries. What
   * stops that being an unbounded retry loop is `progress.retries`, which counts
   * consecutive failures and ends the run at MAX_STEP_RETRIES with a note saying so.
   *
   * Structural failures -- no content script, no tab, a phase that threw for its own
   * reasons -- are not marked retryable and still end the session, because retrying them
   * produces the same error at the same cost.
   */
  retryable?: boolean;
}

export function endStep(state: AgentState, options: EndStepOptions): AgentState {
  const entry = currentEntry(state, options.now);
  const done: StepLogEntry = {
    ...entry,
    endedAt: options.now,
    ms: options.now - entry.startedAt,
    outcome: options.outcome,
    note: options.note,
  };

  const status = nextStatus(state.status, options.outcome, options.retryable === true);

  return {
    ...state,
    busy: false,
    phase: 'idle',
    // Only a completed step advances the counter. A failed one is not retried blindly.
    stepIndex: options.outcome === 'ok' ? state.stepIndex + 1 : state.stepIndex,
    status,
    updatedAt: options.now,
    log: upsertLog(state.log, done),
  };
}

function nextStatus(
  current: LoopStatus,
  outcome: StepOutcome,
  retryable: boolean,
): LoopStatus {
  if (current === 'stopping') return 'stopped';
  // A transient failure keeps the session alive so the next step can try again. See
  // EndStepOptions.retryable, and stuckReason in router.ts for what bounds it.
  if (outcome === 'failed' && retryable && current === 'running') return 'running';
  if (outcome === 'failed') return 'failed';
  if (outcome === 'stopped') return 'stopped';
  // An ending, and one the operator has to be able to tell from a clean finish. The step
  // ran, the actions were carried out, and the completion check found work outstanding.
  if (outcome === 'incomplete') return 'incomplete';
  return current;
}

/**
 * Stop arriving mid-step does not tear anything down. The step in flight finishes its
 * current phase and endStep sees 'stopping'; a stop while idle stops immediately.
 */
export function requestStop(state: AgentState, now: number): AgentState {
  if (state.status !== 'running') {
    return {
      ...state,
      status: state.status === 'stopping' ? 'stopping' : state.status,
      updatedAt: now,
    };
  }
  return {
    ...state,
    status: state.busy ? 'stopping' : 'stopped',
    phase: state.busy ? state.phase : 'idle',
    updatedAt: now,
  };
}

/**
 * The session's tab is gone. Not a stop request -- an ending.
 *
 * `requestStop` on a busy session yields `stopping` and waits for the step in flight to
 * finish, which is right when the operator pressed Stop and wrong here: the step is
 * sending messages into a tab that no longer exists, so it will never finish, and the
 * session sits at `stopping` for ever. With one-session-at-a-time enforced in the worker,
 * that wedges every later run behind a session whose page closed minutes ago.
 */
export function abandon(state: AgentState, now: number): AgentState {
  if (state.status !== 'running' && state.status !== 'stopping') return state;
  return {
    ...state,
    status: 'stopped',
    phase: 'idle',
    busy: false,
    updatedAt: now,
    log: upsertLog(state.log, {
      ...currentEntry(state, now),
      endedAt: now,
      ms: now - currentEntry(state, now).startedAt,
      outcome: 'stopped',
      note: 'the tab this session was driving was closed',
    }),
  };
}

export function fail(state: AgentState, message: string, now: number): AgentState {
  return endStep(state, { outcome: 'failed', now, note: message });
}

/**
 * Called on every wake, before anything else.
 *
 * A state that says "busy" but has not been touched for STALE_STEP_MS was interrupted:
 * MV3 killed the worker mid-step. Nothing is lost -- the step had produced nothing yet
 * -- so mark it interrupted, clear the flag, and let the session carry on from the same
 * step index. This is what makes acceptance criterion 2 true.
 */
export function resumeIfInterrupted(state: AgentState, now: number): AgentState {
  if (!state.busy) return state;
  if (now - state.updatedAt < STALE_STEP_MS) return state;

  const entry = currentEntry(state, now);
  return {
    ...state,
    busy: false,
    phase: 'idle',
    status: state.status === 'stopping' ? 'stopped' : state.status,
    updatedAt: now,
    log: upsertLog(state.log, {
      ...entry,
      endedAt: now,
      ms: now - entry.startedAt,
      outcome: 'interrupted',
      note: 'service worker was terminated mid-step; resuming',
    }),
  };
}

/** The log entry for the step in flight, invented if the log lost it. */
function currentEntry(state: AgentState, now: number): StepLogEntry {
  const at = state.log.findLastIndex((e) => e.stepIndex === state.stepIndex);
  const found = at === -1 ? undefined : state.log[at];
  return found ?? { stepIndex: state.stepIndex, startedAt: now, phase: state.phase };
}
