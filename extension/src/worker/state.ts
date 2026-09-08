/**
 * The agent's whole memory, and where it lives.
 *
 * MV3 kills idle service workers, so there is no such thing as a module-level variable
 * that survives a step. Everything the loop needs on its next wake is in one record
 * under one key in `chrome.storage.session`, read at the top of every handler and
 * written at the end of it.
 *
 * Node-pure: this module takes a KeyValueStore and knows nothing about chrome.
 */

import { LOG_LIMIT, type LoopPhase, type LoopStatus, type StepLogEntry } from '../shared/agent';
import type { KeyValueStore } from '../shared/store';
import type { GoalBlock, Intent } from './intent';

export const STATE_KEY = 'agent-state';

/**
 * Nothing in AgentState is user data, and nothing may be added that is.
 *
 * Raw values pass through the worker on their way between the content script and the
 * offscreen document; this record is what survives, and it survives in browser storage
 * where the redaction gate cannot reach it. A goal, a tab id, phase names, durations
 * and outcomes -- all of which the operator typed or the loop produced. No element, no
 * field value, no page text.
 */

export interface AgentState {
  sessionId: string | null;
  goal: string;
  tabId: number | null;
  /**
   * The origin of the tab this session drives, for the operator to read.
   *
   * A tab id is a number, and a number is no help to someone looking at a panel that
   * docks beside *every* tab in the window. The session belongs to one tab; the panel
   * belongs to the window; so the panel has to be able to say which site it is working
   * on, and say it while you are looking at a different one.
   *
   * Origin, never the full URL and never the title. That is the same line the request
   * itself draws (router.ts sends `snapshot.origin` for the same reason): a query string
   * routinely carries identifiers and a page title routinely carries a name. An origin
   * is the least that answers "which site", and this record outlives the step in browser
   * storage, where the redaction gate cannot reach it.
   */
  tabOrigin: string;
  /**
   * The user's sentence, parsed, with any PII in it already tokenised.
   *
   * Safe to persist for the same reason `goal` is: `placeholderGoal` replaced every value
   * it could classify with a token before this was written, so what is here is a verb, a
   * field name the user typed, and a placeholder. A value the parser could not classify
   * stays literal -- and it is literal in `goal` too, so this adds no exposure that the
   * record did not already carry.
   */
  intents: Intent[];
  /** The sentence yielded nothing to act on, so the planner owns this task. */
  openEnded: boolean;
  /**
   * Runs of the goal the parser did not read, and how much of it that leaves.
   *
   * Persisted for the same reason the log is: an operator asking "why did this go to the
   * planner" is asking about a step that has already ended. Class-masked before it gets
   * here -- see `maskResidue` in router.ts. Residue is a slice of the goal, and the goal on
   * this record has been through the allocator; residue taken from the raw parse has not,
   * so it is masked on the way in rather than trusted to be harmless.
   */
  residue: string[];
  /** Characters of the goal the parser accounted for, over its length. */
  coverage: number;
  /**
   * Why Tier 0 must not act on this goal, or null.
   *
   * A fact about the sentence, so it is decided once when the task starts rather than
   * re-derived every step. Re-deriving would also be wrong: the goal on this record is the
   * tokenised one, and re-parsing it would measure a different sentence.
   */
  block: GoalBlock | null;
  /**
   * Steps this session ran, and how many of them sent anything.
   *
   * Two integers, for one sentence the popup could not previously say. The session counter
   * reads the offscreen ring, which only holds steps that *sealed* something -- so a run
   * answered entirely on the device showed "Values protected this session: 0", which reads
   * as the privacy tool having done nothing. The true statement about that run is the
   * strongest one the project has: nothing was sent, so there was nothing to protect.
   *
   * A ratio cannot be recovered from the ring, because the ring has no entry for the steps
   * that are the point.
   */
  stepsRun: number;
  stepsSent: number;
  /**
   * Steps that finished cleanly *and* sent nothing. The claim, as opposed to the tally.
   *
   * Separate from `stepsRun - stepsSent`, which is not the same thing and reads better
   * than it deserves to: a step that escalated and then died because no planner was
   * running also sent nothing, and describing that as "answered on this device" would be
   * the counter making the agent's strongest claim about its worst outcome.
   */
  stepsLocal: number;
  status: LoopStatus;
  phase: LoopPhase;
  /** Index of the step in flight, or of the next one when idle. */
  stepIndex: number;
  /** A step is running right now. Cleared even when the worker dies -- see loop.ts. */
  busy: boolean;
  /**
   * A page event arrived while a step was in flight, and is owed a look.
   *
   * The loop advances on events, and events do not wait their turn. The one that made
   * this necessary is a navigation: the click that submits page A is the last thing the
   * step does, page B's content script loads and announces itself within a few tens of
   * milliseconds, and the step that caused the navigation has not finished writing its
   * own state yet. `canAcceptStep` says no -- correctly, one step at a time -- and the
   * event was simply dropped. The session sat at `running`, idle, on a page nobody had
   * ever perceived, which from the popup is the same picture as a finished task.
   *
   * One boolean rather than a queue, because the events are all the same request: look
   * at the page as it is now. Ten of them still mean one look.
   */
  pendingPerceive: boolean;
  /** Debug overlay preference. Lives here so the popup can reopen and still know. */
  overlay: boolean;
  /**
   * Frames thrown away because the page moved between measurement and capture. A
   * count, which is why it may live here at all; M11 reports it as a real metric
   * rather than quietly absorbing it.
   */
  framesDiscarded: number;
  startedAt: number;
  updatedAt: number;
  log: StepLogEntry[];
}

export const IDLE_STATE: AgentState = {
  sessionId: null,
  goal: '',
  tabId: null,
  tabOrigin: '',
  intents: [],
  openEnded: true,
  residue: [],
  coverage: 1,
  block: null,
  stepsRun: 0,
  stepsSent: 0,
  stepsLocal: 0,
  status: 'idle',
  phase: 'idle',
  stepIndex: 0,
  busy: false,
  pendingPerceive: false,
  overlay: false,
  framesDiscarded: 0,
  startedAt: 0,
  updatedAt: 0,
  log: [],
};

export function freshState(): AgentState {
  return { ...IDLE_STATE, log: [] };
}

export async function loadState(store: KeyValueStore): Promise<AgentState> {
  const stored = await store.get<AgentState>(STATE_KEY);
  if (!stored) return freshState();
  // Tolerate a record written by an older build rather than losing the session.
  return { ...freshState(), ...stored, log: stored.log ?? [] };
}

export async function saveState(store: KeyValueStore, state: AgentState): Promise<void> {
  await store.set(STATE_KEY, state);
}

/**
 * The tail of the queue every state mutation joins.
 *
 * `updateState` is a read-modify-write across two awaits, and two of them interleaving
 * loses one of the writes entirely. That is not hypothetical and it is not rare: the
 * click that submits page A navigates, page B's content script announces itself, and its
 * PERCEIVE lands inside the same millisecond as the step's own `finish`. Both read, both
 * write, the later write wins, and what it wins with is a state assembled from a read
 * that predates the other one.
 *
 * Measured consequence: `pendingPerceive: true` alongside `busy: false`. `finish` had
 * already checked the flag and found it clear, so it dispatched nothing; the handler had
 * already seen `busy` and refused, so it dispatched nothing either. A session left at
 * `running`, on a page it had never perceived, waiting on an event that had already been
 * delivered and thrown away. It happened on roughly half of runs, which is exactly the
 * frequency at which a race gets blamed on the page.
 *
 * A promise chain is enough. Worker JS is single-threaded, so a mutation that awaits the
 * previous one runs its read and its write with nothing of ours in between. It orders
 * only this worker's own writes, which is all there is: `chrome.storage.session` is not
 * shared with another process that mutates this key.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Read, transform, write -- one at a time.
 *
 * Every mutation goes through here so nothing can write a state it did not first read,
 * and so that two handlers waking the same worker cannot read the same state and write
 * over each other. `saveState` is still the unserialised primitive; anything that reads
 * before it writes must use this instead.
 */
export async function updateState(
  store: KeyValueStore,
  fn: (state: AgentState) => AgentState,
): Promise<AgentState> {
  const mine = queue.then(async () => {
    const next = fn(await loadState(store));
    await saveState(store, next);
    return next;
  });
  // The chain must survive a rejection, or one failed write wedges every later one.
  queue = mine.catch(() => undefined);
  return mine;
}

export async function clearState(store: KeyValueStore): Promise<void> {
  await store.remove(STATE_KEY);
}

/** Append a log line, keeping the newest LOG_LIMIT entries. */
export function pushLog(log: StepLogEntry[], entry: StepLogEntry): StepLogEntry[] {
  const next = [...log, entry];
  return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next;
}

/** Replace the newest entry for a step, or append when there is none. */
export function upsertLog(log: StepLogEntry[], entry: StepLogEntry): StepLogEntry[] {
  const at = log.findLastIndex((e) => e.stepIndex === entry.stepIndex);
  if (at === -1) return pushLog(log, entry);
  const next = [...log];
  next[at] = entry;
  return next;
}
