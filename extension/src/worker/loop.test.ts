import { describe, it, expect } from 'vitest';
import { LOG_LIMIT, MAX_STEPS, STALE_STEP_MS } from '../shared/agent';
import { PLAN_TIMEOUT_MS } from './transport';
import {
  abandon,
  beginStep,
  budgetSpent,
  canAcceptStep,
  endStep,
  enterPhase,
  exhaust,
  requestStop,
  resumeIfInterrupted,
  startTask,
} from './loop';
import { freshState, pushLog, upsertLog, type AgentState } from './state';

function running(now = 1_000): AgentState {
  return startTask(freshState(), { sessionId: 's1', goal: 'renew', tabId: 7, now });
}

describe('startTask', () => {
  it('opens a running session at step 0', () => {
    const s = running();
    expect(s.status).toBe('running');
    expect(s.sessionId).toBe('s1');
    expect(s.tabId).toBe(7);
    expect(s.stepIndex).toBe(0);
    expect(s.busy).toBe(false);
  });

  it('clears the log -- the old one belonged to another goal', () => {
    const previous = {
      ...freshState(),
      log: [{ stepIndex: 0, startedAt: 1, phase: 'idle' as const }],
    };
    expect(startTask(previous, { sessionId: 's2', goal: 'g', tabId: 1, now: 5 }).log).toEqual(
      [],
    );
  });
});

describe('canAcceptStep', () => {
  it('is true only for a running, idle session', () => {
    expect(canAcceptStep(running())).toBe(true);
    expect(canAcceptStep(freshState())).toBe(false);
    expect(canAcceptStep(beginStep(running(), 2))).toBe(false);
    expect(canAcceptStep({ ...running(), status: 'stopped' })).toBe(false);
  });
});

describe('a step from beginning to end', () => {
  it('logs one entry and advances the phase', () => {
    let s = beginStep(running(), 1_100);
    expect(s.busy).toBe(true);
    expect(s.log).toHaveLength(1);

    s = enterPhase(s, 'capture', 1_150);
    s = enterPhase(s, 'detect', 1_200);
    expect(s.phase).toBe('detect');
    expect(s.log).toHaveLength(1);
    expect(s.log[0]?.phase).toBe('detect');
  });

  it('advances the step index only when the step succeeded', () => {
    const started = beginStep(running(), 1_100);
    expect(endStep(started, { outcome: 'ok', now: 1_300 }).stepIndex).toBe(1);
    expect(endStep(started, { outcome: 'failed', now: 1_300 }).stepIndex).toBe(0);
  });

  it('records the duration and the phase that failed', () => {
    let s = beginStep(running(), 1_100);
    s = enterPhase(s, 'seal', 1_180);
    s = endStep(s, { outcome: 'failed', now: 1_400, note: 'gate not implemented' });

    const entry = s.log[0];
    expect(entry?.ms).toBe(300);
    expect(entry?.phase).toBe('seal');
    expect(entry?.outcome).toBe('failed');
    expect(entry?.note).toMatch(/gate/);
    expect(s.status).toBe('failed');
    expect(s.busy).toBe(false);
  });

  it('leaves a healthy session running after a good step', () => {
    const s = endStep(beginStep(running(), 1_100), { outcome: 'ok', now: 1_200 });
    expect(s.status).toBe('running');
    expect(s.phase).toBe('idle');
  });
});

describe('stopping', () => {
  it('stops immediately when nothing is in flight', () => {
    expect(requestStop(running(), 2_000).status).toBe('stopped');
  });

  it('waits for the step in flight, then stops', () => {
    const mid = requestStop(beginStep(running(), 1_100), 1_150);
    expect(mid.status).toBe('stopping');
    expect(mid.busy).toBe(true);

    const done = endStep(mid, { outcome: 'ok', now: 1_200 });
    expect(done.status).toBe('stopped');
  });

  it('is idempotent', () => {
    const once = requestStop(running(), 2_000);
    expect(requestStop(once, 2_100).status).toBe('stopped');
  });

  it('does not resurrect a failed session', () => {
    const failed = endStep(beginStep(running(), 1_100), { outcome: 'failed', now: 1_200 });
    expect(requestStop(failed, 1_300).status).toBe('failed');
  });
});

describe('resumeIfInterrupted -- MV3 killed the worker mid-step', () => {
  it('leaves a step that is merely slow alone', () => {
    const s = beginStep(running(), 1_100);
    expect(resumeIfInterrupted(s, 1_100 + STALE_STEP_MS - 1)).toBe(s);
  });

  it('leaves an idle session alone', () => {
    const s = running();
    expect(resumeIfInterrupted(s, 9_999_999)).toBe(s);
  });

  it('clears the stale busy flag and keeps the session running', () => {
    const killed = enterPhase(beginStep(running(), 1_100), 'capture', 1_150);
    const back = resumeIfInterrupted(killed, 1_150 + STALE_STEP_MS + 1);

    expect(back.busy).toBe(false);
    expect(back.status).toBe('running');
    expect(back.stepIndex).toBe(0);
    expect(canAcceptStep(back)).toBe(true);
  });

  it('marks the interrupted step in the log rather than losing it', () => {
    const killed = beginStep(running(), 1_100);
    const back = resumeIfInterrupted(killed, 1_100 + STALE_STEP_MS + 1);
    const entry = back.log[0];

    expect(entry?.outcome).toBe('interrupted');
    expect(entry?.note).toMatch(/terminated mid-step/);
  });

  it('completes a stop that was pending when the worker died', () => {
    const stopping = requestStop(beginStep(running(), 1_100), 1_120);
    const back = resumeIfInterrupted(stopping, 1_120 + STALE_STEP_MS + 1);
    expect(back.status).toBe('stopped');
  });
});

describe('the log', () => {
  it('keeps the newest LOG_LIMIT entries', () => {
    let log = freshState().log;
    for (let i = 0; i < LOG_LIMIT + 10; i += 1) {
      log = pushLog(log, { stepIndex: i, startedAt: i, phase: 'perceive' });
    }
    expect(log).toHaveLength(LOG_LIMIT);
    expect(log[0]?.stepIndex).toBe(10);
  });

  it('replaces the entry for a step instead of duplicating it', () => {
    const first = pushLog([], { stepIndex: 3, startedAt: 1, phase: 'perceive' });
    const updated = upsertLog(first, { stepIndex: 3, startedAt: 1, phase: 'seal' });
    expect(updated).toHaveLength(1);
    expect(updated[0]?.phase).toBe('seal');
  });
});

describe('the step budget', () => {
  it('is not spent while there are steps left', () => {
    expect(budgetSpent({ ...running(), stepIndex: MAX_STEPS - 1 })).toBe(false);
  });

  it('is spent once the last one has run', () => {
    expect(budgetSpent({ ...running(), stepIndex: MAX_STEPS })).toBe(true);
  });

  /**
   * The loop owns no other terminator: `finish` and `ask` are the plan's, so without a
   * budget the only thing between a planner that re-proposes a failed action and an
   * agent that runs until the tab closes is the planner's own judgement.
   */
  it('stops the session and says why in the log', () => {
    const spent = exhaust({ ...running(), stepIndex: MAX_STEPS }, 9_000);

    expect(spent.status).toBe('stopped');
    expect(spent.busy).toBe(false);
    expect(spent.phase).toBe('idle');

    const last = spent.log[spent.log.length - 1];
    expect(last?.outcome).toBe('stopped');
    expect(last?.note).toContain(String(MAX_STEPS));
  });
});

/**
 * The interaction that made this a constant worth reading twice: `resumeIfInterrupted`
 * runs on every wake, and a step that is merely slow must never look interrupted --
 * clearing `busy` under a live step lets a second one start beside it.
 */
describe('the stale-step threshold against the plan phase', () => {
  it('outlasts the longest a step is allowed to take', () => {
    expect(STALE_STEP_MS).toBeGreaterThan(PLAN_TIMEOUT_MS);
  });

  it('leaves a step that is inside the plan budget alone', () => {
    const busy = beginStep(running(1_000), 1_000);
    const midPlan = { ...busy, updatedAt: 1_000 };
    expect(resumeIfInterrupted(midPlan, 1_000 + PLAN_TIMEOUT_MS).busy).toBe(true);
  });
});

/**
 * A closed tab ends its session outright.
 *
 * `requestStop` waits for the step in flight, which is right for a Stop button and wrong
 * here: the step is sending messages into a tab that no longer exists, so it never
 * finishes and the session sits at `stopping` for ever. With one-session-at-a-time
 * enforced in the worker, that wedges every later run behind a page closed minutes ago.
 */
describe('the tab went away', () => {
  it('stops a busy session rather than leaving it stopping', () => {
    const busy = beginStep(running(1_000), 1_000);
    expect(requestStop(busy, 2_000).status).toBe('stopping');

    const gone = abandon(busy, 2_000);
    expect(gone.status).toBe('stopped');
    expect(gone.busy).toBe(false);
    expect(gone.log.at(-1)?.note).toContain('closed');
  });

  it('stops an idle running session too', () => {
    expect(abandon(running(1_000), 2_000).status).toBe('stopped');
  });

  it('leaves a session that had already finished alone', () => {
    const done = endStep(beginStep(running(1_000), 1_000), { outcome: 'ok', now: 2_000 });
    const after = abandon({ ...done, status: 'stopped' }, 3_000);
    expect(after.log).toEqual(done.log);
  });
});
