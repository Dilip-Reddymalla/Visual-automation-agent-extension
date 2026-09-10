/**
 * The router. It is deliberately thin: it moves messages, owns the loop's state
 * machine, and will grow exactly one safety check (the receipt verification, M6).
 *
 * It persists no user data, and has no model and no page access. The distinction
 * matters: raw text does pass through here -- ObservedElements carrying field values on
 * their way to L0, INFER payloads on their way to the NER model -- because the worker
 * is the only thing that can talk to both the content script and the offscreen
 * document. It routes them and forgets them. What it writes to storage is the loop's
 * own state: a goal, a tab id, phases, timings. Never a value, never an element.
 *
 * Everything it knows is in `chrome.storage.session` behind the injected store, so a
 * terminated service worker loses nothing but its call stack.
 *
 * Its dependencies are injected so the whole thing runs in Node against a loopback bus
 * -- see router.test.ts.
 */

import {
  MAX_STALLED_STEPS,
  MAX_STEP_RETRIES,
  MAX_STEPS,
  PHASES,
  type LoopStatus,
  type StepEvent,
  type StepOutcome,
  type StepPhase,
} from '../shared/agent';
import { BusTimeout, handle, notify, send } from '../shared/messages';
import {
  geometryMatches,
  tokenDrift,
  type CaptureGeometry,
  type FrameRef,
} from '../shared/frames';
import type { ObservedElement } from '../shared/observed';
import type { KeyValueStore } from '../shared/store';
import {
  forgetSecret,
  listSecrets,
  readSecret,
  saveSecret,
  type ConfirmRelease,
  type VaultStore,
} from './vault';
import {
  beginStep,
  budgetSpent,
  canAcceptStep,
  endStep,
  enterPhase,
  exhaust,
  halt,
  recordPhase,
  requestStop,
  resumeIfInterrupted,
  startTask,
} from './loop';
import { loadState, saveState, updateState, type AgentState } from './state';
import { detect } from './detect';
import { markable } from '../redaction/marks';
import { placeholderText, PROTECTED_IN_GOAL, UNPROTECTED_IN_GOAL } from './goal';
import { isReadingTask, parseGoal, type Intent } from './intent';
import type { GoalBlock } from './intent';
import { actionFor as localAction, chooseTier, type Tier, type TierChoice } from './tiers';
import { assessCompletion, describeCompletion, type Fulfilment } from './complete';
import {
  activeSubgoal,
  adoptPlan,
  advanceProgress,
  isVerified,
  markComplete,
  progressFulfilments,
  planFinished,
  verifiedWork,
} from './progress';
import { advancePlan } from './criteria';
import { decompose, describeDecomposition, extractConstraints } from './decompose';
import {
  describeEvaluation,
  evaluate,
  findCandidates,
  preferenceIn,
} from './candidates';
import { describeReveal, locate, REVEAL_ATTEMPTS } from './reveal';
import { describeRejection, verifyPlan } from './verify-plan';
import { describeLocalFailure, type LocalAction, type LocalOutcome } from './local';
import type { Candidate as LocalCandidate } from './resolve';
import type { PlaceholderClass } from '../shared/placeholders';
import { scanText } from '../redaction/l1-lexical';
import { emitTrace, record, startStep, type StepTrace } from './trace';
import { TransportError } from './transport';
import { toWire } from '../shared/observed';
import {
  PROTOCOL_VERSION,
  type Finding,
  type HistoryEntry,
  type StepRequest,
} from '../shared/contract';

export interface RouterDeps {
  store: KeyValueStore;
  now(): number;
  newSessionId(): string;
  /** Rate-limited captureVisibleTab. See worker/capture.ts. */
  captureFrame(expected: { width: number; height: number; scale: number }): Promise<FrameRef>;
  /**
   * Guarantee a content script is running in that tab.
   *
   * The manifest injects one on http://localhost/* automatically, but nothing guarantees
   * a page keeps it: a tab the operator navigated to after the extension loaded, or any
   * tab outside the manifest's matches, has none until something explicitly injects one.
   * Every route that talks to content calls this first, so the step never sends into
   * silence -- which is what "Receiving end does not exist" is.
   */
  ensureContent(tabId: number): Promise<void>;
  /**
   * The origin of a tab, for the panel to name the site a session is working on.
   *
   * A dependency rather than a `chrome.tabs.get` inline, for the usual reason -- the
   * router is tested in Node -- and read here rather than taken from the first snapshot
   * so the panel can name the site before the first step has finished perceiving it.
   */
  tabOrigin(tabId: number): Promise<string>;
  /** Bring the inference host up before a phase that needs it. */
  ensureHost(): Promise<void>;
  /**
   * Take it back down. Called when a session ends, so that a stopped agent leaves no
   * model resident, no GPU context and no timer -- idle has to mean idle.
   */
  releaseHost(): Promise<void>;
  /** Where stored credentials live. platform/vault-store.ts in the browser. */
  vault: VaultStore;
  /** Asks the operator to release one. Never bypassed; see worker/vault.ts. */
  confirm: ConfirmRelease;
  /** Read the sealed bytes the offscreen document left for us. M7. */
  takeFrame(key: string): Promise<{ bytes: Uint8Array } | undefined>;
  /** The one network call. Injected so nothing else can reach the network. */
  post(request: StepRequest, bytes: Uint8Array): Promise<import('./transport').PostResult>;
  /**
   * Tier 1: ask a model on this machine to pick one of a shortlist.
   *
   * Injected like `post`, and for the same reason -- so "what can reach out of this
   * process, and to where?" is answerable by reading one interface. Resolves to null for
   * every kind of unavailable, because the caller escalates on all of them.
   */
  askLocal?(sentence: string, candidates: LocalCandidate[]): Promise<LocalOutcome<number>>;
  /**
   * Tier 1's other question: what does this whole sentence mean on this page?
   *
   * Asked when the grammar read nothing at all. Separate from `askLocal` because the two
   * are different questions with different failure modes -- one picks from a shortlist
   * somebody else built, the other proposes actions -- and because a deployment may
   * reasonably want the tie-break and not the reader.
   */
  readGoal?(
    sentence: string,
    candidates: LocalCandidate[],
    /** Why the previous answer was refused. Set only on the one retry. */
    correction?: string,
    /** Work the ledger has already verified, so the model is not asked to redo it. */
    done?: readonly string[],
  ): Promise<LocalOutcome<LocalAction[]>>;
  /**
   * Tier 1 prompt normalization: rewrite unparsed / casual goal into standard grammar
   * so Tier 0 can resolve it deterministically on device.
   */
  normalizeGoal?(
    sentence: string,
    candidates: LocalCandidate[],
  ): Promise<LocalOutcome<string>>;
  /** What to call the remote planner in a step note. The endpoint, usually. */
  plannerName?(): string;
  /** Where trace lines go. The eval harness reads them. */
  trace?(line: string): void;
}

/**
 * Chrome's own wording for "you could have this, you just have not asked".
 *
 * The grantable case is a page the extension may drive once the operator widens its
 * access. The restricted list is pages no permission reaches at all -- `chrome://`, the
 * web store, another extension's pages -- and pointing an operator at a grant button that
 * cannot help them is worse than the raw error, because they will press it.
 */
const GRANTABLE = /must request permission|cannot access contents of/i;
const RESTRICTED = /chrome:\/\/|chrome-extension:\/\/|edge:\/\/|about:|web ?store/i;

/** Thrown by a phase whose module has not landed yet. Ends the step, not the session. */
export class NotImplementedYet extends Error {
  constructor(module: string) {
    super(`not implemented yet: ${module}`);
    this.name = 'NotImplementedYet';
  }
}

export function installRoutes(deps: RouterDeps): void {
  handle('RUN_TASK', async ({ goal, tabId }) => {
    // One tab at a time, and refused here rather than only in the UI.
    //
    // A session is bound to the tab it was started on: its element indices, its
    // placeholder numbering and its step log all describe that one page. Starting a
    // second one elsewhere would not run two agents, it would silently replace the first
    // -- the state is one record -- and the operator's evidence for a run still in
    // progress would vanish mid-step. The panel disables Run for the same reason, but the
    // panel is a view, and an invariant that only a view enforces is not an invariant.
    //
    // Same tab is not refused: there the operator can see what they are replacing.
    const live = await loadState(deps.store);
    const busyElsewhere =
      (live.status === 'running' || live.status === 'stopping') &&
      live.tabId !== null &&
      live.tabId !== tabId;
    if (busyElsewhere) {
      throw new Error(
        `already running on ${live.tabOrigin || 'another tab'} — stop that first`,
      );
    }

    const sessionId = deps.newSessionId();

    // The step that follows sends into this tab five messages deep. If that tab cannot
    // host a content script -- a chrome:// page, the web store, an origin the extension
    // may not reach -- say so plainly rather than letting the step fail with a message
    // that reads as a bug.
    await deps.ensureContent(tabId).catch((cause: unknown) => {
      const reason = cause instanceof Error ? cause.message : String(cause);
      // Two failures land here and they need different sentences. A page the extension
      // may never drive -- chrome://, the web store -- is a fact about that page. A page
      // it *could* drive if it were allowed to is a fact about the permission, and the
      // raw text Chrome supplies for it ("Extension manifest must request permission")
      // reads as a build defect rather than as a button the operator has not pressed.
      const unpermitted = GRANTABLE.test(reason) && !RESTRICTED.test(reason);
      throw new Error(
        unpermitted
          ? `no access to this site yet — press Allow any site under Site access, or ` +
              `click the toolbar icon on this tab to grant it for this page only (${reason})`
          : `cannot run the agent in this tab: ${reason}`,
      );
    });

    // Read the sentence before doing anything with it.
    //
    // Two things come out of this and both matter. The intents are what Tier 0 acts on --
    // "fill first name with leo" is a grammar, not a reasoning problem -- and the classes
    // they carry are what lets the goal's own values be tokenised: "leo" has no shape for
    // a scanner to find, and the field the user named is the only evidence of what it is.
    const parsed = parseGoal(goal);

    // The goal goes to the planner as text, so it goes through the same treatment as
    // the page. An operator who types an Aadhaar number into the task box would
    // otherwise have the picture redacted and the sentence beside it sent in the clear.
    await deps.ensureHost();
    const safe = await placeholderGoal(sessionId, goal, parsed.intents);
    const safeGoal = safe.goal;
    // Best effort, and never a reason to refuse the run: this is a label for a human,
    // not something the loop depends on.
    const tabOrigin = await deps.tabOrigin(tabId).catch(() => '');

    // Decomposed from the *tokenised* sentence, not the raw one.
    //
    // A subgoal's `intent` is persisted, sent to the planner and printed in the step
    // note, so it goes through the same door as `goal` itself. Re-parsing costs one more
    // pass of a grammar over a short string and buys the guarantee that nothing the
    // allocator removed can reappear inside a plan.
    const decomposition = decompose(parseGoal(safeGoal));

    const state = await updateState(deps.store, (s) =>
      startTask(s, {
        sessionId,
        goal: safeGoal,
        intents: safe.intents,
        openEnded: parsed.openEnded,
        // Masked, not passed through. Residue is a slice of the *raw* goal, and everything
        // else on this record went through the allocator first; storing it unmasked would
        // put an identifier back into session storage that `safeGoal` had just taken out.
        residue: parsed.residue.map(maskResidue),
        coverage: parsed.coverage,
        block: maskBlock(parsed.block),
        plan: decomposition.subgoals,
        tabId,
        tabOrigin,
        now: deps.now(),
      }),
    );
    await emit(deps, state, {
      kind: 'status',
      status: 'running',
      // The plan by its leg ids, so an operator watching the panel sees what the agent
      // thinks it has been asked to do before it does any of it.
      note: joinNote(safeGoal, describeDecomposition(decomposition)),
    });
    // Do not await: the reply goes back now, the step runs behind it.
    void runStep(deps, 'user');
    return { sessionId, stepIndex: state.stepIndex };
  });

  handle('STOP', async () => {
    const state = await updateState(deps.store, (s) => requestStop(s, deps.now()));
    await emit(deps, state, { kind: 'status', status: state.status });
    // Only once nothing is in flight: releasing under a running seal phase would kill
    // the step that is using it. A 'stopping' session releases when its step ends.
    if (state.status === 'stopped') void deps.releaseHost();
    return { stopped: state.status === 'stopped' || state.status === 'stopping' };
  });

  handle('HOST_ENSURE', async () => {
    await deps.ensureHost();
    return { ready: true };
  });

  handle('GOAL_COVERAGE', () => ({
    protected: [...PROTECTED_IN_GOAL],
    unprotected: [...UNPROTECTED_IN_GOAL],
  }));

  /**
   * The vault, from the popup.
   *
   * Storing and forgetting are the operator's own business and need no confirm -- they
   * are already an explicit act. Releasing is the one that asks, and it asks in
   * platform/vault-store.ts, in a window.
   */
  handle('VAULT_SAVE', async ({ origin, cls, label, value }) => {
    await saveSecret({ origin, cls }, { label, value }, { store: deps.vault });
    return { saved: true as const };
  });

  handle('VAULT_FORGET', async ({ origin, cls }) => {
    await forgetSecret({ origin, cls }, { store: deps.vault });
    return { forgotten: true as const };
  });

  handle('VAULT_LIST', async () => ({ entries: await listSecrets({ store: deps.vault }) }));

  /**
   * Release one into a field.
   *
   * The value goes straight from the vault to the content script and is never returned
   * to the caller, never stored, and never named in the reply -- so there is no surface
   * here for it to leak from. The reply says only whether it happened.
   */
  handle('VAULT_FILL', async ({ tabId, index, origin, cls }) => {
    await deps.ensureContent(tabId);
    const read = await readSecret(
      { origin, cls },
      { store: deps.vault, confirm: deps.confirm },
    );
    if (!read.ok) return { outcome: 'failed' as const, reason: read.reason };

    // A fresh walk, so the index the operator picked is checked against the page as it
    // is now rather than as it was when the popup drew its list.
    const snapshot = await send(
      'DOM_SNAPSHOT',
      { sessionId: 'vault' },
      { to: 'content', tabId },
    );
    const result = await send(
      'FILL_SECRET',
      { index, value: read.value, snapshotId: snapshot.snapshotId },
      { to: 'content', tabId },
    );

    return result.outcome === 'ok'
      ? { outcome: 'ok' as const }
      : { outcome: 'failed' as const, reason: 'failed' as const };
  });

  handle('PERCEIVE', async ({ reason }) => {
    await wake(deps);

    // Claim, then decide from what the claim actually saw -- in that order, and never
    // from a state read beforehand.
    //
    // A running session that is merely busy owes this page a look as soon as the step in
    // flight is over, and `pendingPerceive` is how it remembers. Deciding from an earlier
    // read loses that promise when the step ends in between: this handler sees `busy` and
    // refuses, `finish` sees the flag still clear and dispatches nothing, and the event
    // is gone. Reading the flag back out of the same serialised update closes it -- if
    // the step had already ended, the transform is a no-op, `canAcceptStep` is true, and
    // this handler runs the step itself.
    //
    // A session that is stopped or stopping owes nothing, and the transform leaves it be.
    const state = await updateState(deps.store, (s) =>
      s.status === 'running' && s.busy ? { ...s, pendingPerceive: true } : s,
    );

    if (!canAcceptStep(state)) return { accepted: false, stepIndex: state.stepIndex };
    void runStep(deps, reason);
    return { accepted: true, stepIndex: state.stepIndex };
  });
}

/**
 * Every inbound message goes through here first. If the previous step was cut short by
 * the worker being killed, this is where that is noticed and repaired.
 */
export async function wake(deps: RouterDeps): Promise<AgentState> {
  const state = await loadState(deps.store);
  const resumed = resumeIfInterrupted(state, deps.now());
  if (resumed !== state) {
    await saveState(deps.store, resumed);
    await emit(deps, resumed, {
      kind: 'step-end',
      outcome: 'interrupted',
      note: 'worker restarted',
    });
  }
  return resumed;
}

/**
 * What one step is carrying while it runs.
 *
 * A local, deliberately. Elements carry raw field values and a frame is a picture of
 * the user's screen; neither may be written to chrome.storage.session, which outlives
 * the step and which the redaction gate cannot reach into. If MV3 kills the worker
 * mid-step this is lost, and losing it is the correct outcome.
 */
export interface StepContext {
  elements?: ObservedElement[];
  geometry?: CaptureGeometry;
  frame?: FrameRef;
  /** Frames thrown away because the page moved. Reported by M11. */
  discards: number;
  /**
   * Frames kept although the page was still mutating, because nothing had *moved*.
   *
   * Counted separately from `discards` because it means the opposite thing: a discard is
   * the guard working, and this is the guard being relaxed. See captureBoundToPage.
   */
  contentDrifts: number;

  // ── M7: what the phases hand each other ──────────────────────────────────
  findings?: Finding[];
  /** finding id -> the raw string. Consumed by the offscreen allocator, never stored. */
  values?: Map<string, string>;
  /** finding id -> placeholder, for substituting into the element list. */
  placeholders?: Map<string, string>;
  /** finding id -> element index. Device-side only; not a wire field. */
  elementOf?: Map<string, number>;
  /** finding id -> box kind, which decides its padding in the gate. */
  boxKinds?: Record<string, 'element' | 'text'>;
  manifest?: import('../shared/contract').Manifest;
  capture?: { mime: string; width: number; height: number; scale: number; sha256: string };
  handoffKey?: string;
  plan?: import('../shared/contract').StepResponse;
  /** Which walk ctx.elements came from. Sent with the actions so staleness is caught. */
  snapshotId?: string;
  /** What the page made of each action. Outcomes and notes only, never values. */
  results?: import('../shared/messages').ExecutionOutcome[];
  /** Set when the plan itself ends the step: an `ask` for the operator, or a `finish`. */
  suspend?: { kind: 'ask' | 'finish'; note: string };
  /** What the actions did, in the planner's own vocabulary. Placeholders, never values. */
  historyNote?: string;
  origin?: string;
  title?: string;
  /**
   * Which tier answered this step, and what Tier 0 measured deciding.
   *
   * Set in `perceive`, because that is the first moment the element list exists and the
   * last moment before anything costs money: a Tier 0 answer means no screenshot is
   * taken, nothing is sealed and nothing is posted, and every phase after this one reads
   * `tier` to know that.
   */
  tier?: Tier;
  /**
   * Did anything cross the network on this step?
   *
   * Separate from `tier`, and it was not. A Tier 1 win used to overwrite `ctx.tier = 0` in
   * order to short-circuit the phases that follow -- correct in its effect, and it made the
   * step log say "tier 0" about a step a local model decided. Two different facts had one
   * field between them, and the more interesting of the two was the one being lost: "tier 1,
   * nothing sent" is a better story than "tier 0", and it was being hidden.
   *
   * `tier` now always names the rung that actually answered. This names the boundary.
   */
  sent: boolean;
  /**
   * The plan was produced on this machine, so nothing after `perceive` needs to run.
   *
   * What `ctx.tier === 0` used to stand in for, given a name of its own so that the tier can
   * be honest. True for a Tier 0 grammar answer and for a Tier 1 model answer alike -- the
   * phases they skip, and the reason they skip them, are identical.
   */
  answeredLocally?: boolean;
  tierNote?: string;
  /** Why this step went past Tier 0, in the operator's words. Empty when it did not. */
  escalation?: string;
  /**
   * Which model answered, or would have been asked.
   *
   * Beside `tier`, because "tier 1" does not say which of two local models did the work,
   * and they are a different size, a different job and a different failure mode. On a Tier 2
   * step this names where the request went instead.
   */
  answeredBy?: string;
  /** True when the goal was rewritten into standard grammar by the local model. */
  normalizedLocally?: boolean;
  decisions?: Array<{ target: string; index: number; score: number; gap: number }>;
  /** What the step had to scroll to before it could act. Empty when nothing moved. */
  revealNote?: string;
  /** Which leg of the plan this step is working on. Empty when there is no plan. */
  subgoal?: string;
  /**
   * The rung of the recovery ladder this step is carrying out.
   *
   * Set only when the previous attempt at this leg did not work and the ladder decided
   * that whatever chose the target last time should not choose it again. Read below, where
   * it makes the step skip Tier 0. See recover.ts.
   */
  recovery?: import('./recover').Recovery;
  /** What the plan did this step: which leg finished, which started, which failed. */
  planNote?: string;
  /**
   * What the current leg's `action-verified` criterion is looking for, if it has one.
   *
   * Carried so that the ledger and the criteria can speak the same language. A leg says
   * "this is done when the ledger has verified work named X"; the ledger names work by
   * whatever `targetForIndex` could work out, which on a step the planner answered is
   * `field [7]`. Those never match, so a leg that had in fact been carried out sat at
   * `continue` until its budget ran out and the run replanned around work it had already
   * done. The hint comes out of the user's own goal, which is already on the record.
   */
  subgoalHint?: string;
  /** One per value-bearing action, from the content script's re-read after settle. */
  fulfilments?: Fulfilment[];
  /**
   * The completion check passed on this step, so the ledger may be sealed.
   *
   * On the context rather than a `finish` parameter because it is decided in one place --
   * the suspend branch, which is the only code allowed to conclude a task is done -- and
   * read in one place, and a fifth positional argument to `finish` would be read by
   * nobody.
   */
  completed?: boolean;
  trace?: StepTrace;
}

/** The plan was made here: no screenshot, no gate, no POST. */
function decidedLocally(ctx: StepContext): boolean {
  return ctx.answeredLocally === true;
}

/** How many times one step will re-measure before giving up on a moving page. */
export const MAX_GEOMETRY_ATTEMPTS = 2;

/** What each phase does. Later modules replace a body; the shape does not change. */
type PhaseRunner = (deps: RouterDeps, state: AgentState, ctx: StepContext) => Promise<void>;

const RUNNERS: Record<StepPhase, PhaseRunner> = {
  perceive: async (deps, state, ctx) => {
    const snapshot = await send(
      'DOM_SNAPSHOT',
      { sessionId: requireSession(state) },
      { to: 'content', tabId: requireTab(state) },
    );
    ctx.elements = snapshot.elements;
    ctx.snapshotId = snapshot.snapshotId;
    // Origin only, never the full URL -- query strings routinely carry identifiers.
    ctx.origin = snapshot.origin;
    ctx.title = snapshot.title;

    // The plan moves here, against the walk this step took anyway.
    //
    // The leg that was current is judged first -- did the page do what the last step's
    // actions were supposed to make it do -- and only then is the next leg chosen and
    // charged. Doing it at the *start* of a step rather than at the end of the previous
    // one costs nothing extra and asks the question after the DOM has settled rather than
    // during the click. See criteria.ts.
    if (state.progress.plan.length > 0) {
      const observation = {
        snapshotId: snapshot.snapshotId,
        origin: snapshot.origin,
        elements: snapshot.elements,
      };
      let planNote = '';
      let stepped: import('./criteria').PlanStep | undefined;
      const advanced = await updateState(deps.store, (current) => {
        stepped = advancePlan(current.progress, {
          observation,
          stepIndex: current.stepIndex,
          // `retries` is reset by any step that ends `ok`, so zero-with-history is the
          // cheapest true statement of "the last step went through".
          lastStepOk: current.progress.retries === 0 && current.progress.observed > 0,
          // The ladder may not spend a step asking for a plan the run has no room to
          // carry out: past the budget, the only honest rung left is to stop.
          stepsLeft: MAX_STEPS - current.stepIndex,
        });
        planNote = stepped.note;
        return { ...current, progress: stepped.progress };
      });
      const current = activeSubgoal(advanced.progress);
      ctx.subgoal = current?.id;
      ctx.subgoalHint = current?.criteria.find((c) => c.check === 'action-verified')?.hint;
      ctx.planNote = planNote;
      ctx.recovery = stepped?.recovery;
      if (ctx.trace) ctx.trace.subgoal = ctx.subgoal;

      // Every leg is terminal: stop here, before a tier is asked what to do next.
      //
      // `planFinished` existed and nothing read it, and the cost was visible on the live
      // amazon.in run. The plan completed at the top of step 2 -- the search had been
      // typed and answered a step earlier -- and the step carried on regardless, handed
      // the page to tier 1, and executed the four clicks it came back with. The run ended
      // with a `finish` note saying the plan had nothing left to do, on a page four clicks
      // away from the results the task had asked for.
      //
      // Answered as a device-made plan rather than by setting `ctx.suspend` directly, so
      // it travels the same path as every other terminator: `execute` records the no-op,
      // the completion check still runs in `settle`, and the step log still says which
      // tier answered. Nothing is sent -- there is nothing to plan.
      if (planFinished(advanced.progress)) {
        ctx.tier = 0;
        ctx.answeredLocally = true;
        ctx.plan = {
          protocolVersion: PROTOCOL_VERSION,
          stepIndex: state.stepIndex,
          rationale: 'the plan made on this device is finished',
          actions: [
            {
              type: 'finish',
              status: 'success',
              summary: 'every leg of the plan finished',
            },
          ],
          plan: [],
          done: true,
        };
        if (ctx.trace) ctx.trace.tier = { tier: 0, decisions: [] };
        return;
      }
    }

    // The panel names the site this session is working on, and a session outlives
    // navigations -- page A submits and becomes page B. Refreshing the label here keeps
    // it describing where the agent actually is rather than where it started.
    if (snapshot.origin && snapshot.origin !== state.tabOrigin) {
      await updateState(deps.store, (current) => ({
        ...current,
        tabOrigin: snapshot.origin,
      }));
    }

    // The tier is chosen here, at the first moment the element list exists and the last
    // moment before the step costs anything. A Tier 0 answer skips the screenshot, the
    // detection pass, the gate and the network call -- not as an optimisation but because
    // none of them have anything to contribute: nothing is being sent, so there is nothing
    // to redact.
    // A leg that is about choosing between things on the page is a different question
    // from "which control did the user mean", and `resolve.ts` cannot answer it: the user
    // named an arithmetic condition, not an element. See candidates.ts.
    if (state.progress.plan.find((s) => s.id === ctx.subgoal)?.kind === 'select') {
      if (chooseCandidate(state, ctx)) return;
    }

    // Intents the page has already confirmed are not offered to Tier 0 again.
    //
    // Tier 0 is a pure function of the sentence and the element list, so on a multi-step
    // run it re-derives the same action every step: the grammar has no memory, and the
    // ledger does. Before plans existed this never showed, because a Tier 0 answer ended
    // the session; now a run keeps going, and without this it spends every remaining step
    // re-typing a field it filled on step one -- which is not just waste, it is the
    // "previously verified actions must not be blindly repeated" rule being broken by the
    // cheapest tier in the system.
    //
    // The ledger is keyed by verb and target, and `targetForIndex` names a Tier 0
    // fulfilment by the intent that won it, so the two line up exactly.
    const outstanding = state.intents.filter(
      (intent) => !isVerified(state.progress, intent.verb, intent.target),
    );
    if (outstanding.length < state.intents.length) {
      ctx.tierNote = joinNote(
        ctx.tierNote,
        `${state.intents.length - outstanding.length} already done`,
      );
    }

    const goal = { intents: outstanding, ...(state.block ? { block: state.block } : {}) };
    let choice = chooseTier(goal, ctx.elements);

    // The recovery ladder overrules the tier choice, and only in one direction.
    //
    // Tier 0 answered this leg last step and the page did not do what that answer was for.
    // Asking the same grammar the same question about the same page gets the same answer,
    // so the cheapest rung that can differ is the next one up. Never the other way round:
    // recovery may spend more, never less. See recover.ts.
    if (ctx.recovery && choice.tier === 0) {
      choice = { tier: 2, reason: 'recovery', detail: ctx.planNote ?? 'the last attempt did not work' };
    }

    // The field may simply be somewhere else on the page.
    //
    // `below-floor` means nothing in the viewport scored high enough -- which is what a
    // page scrolled past the form looks like from here, and is indistinguishable from a
    // page that has no such field at all. The two are worth distinguishing before paying
    // for a screenshot: one is answered by scrolling, the other by a planner.
    if (choice.tier === 1 && choice.escalation.reason === 'below-floor') {
      choice = await revealAndRetry(deps, state, ctx, goal, choice);
    }

    ctx.tier = choice.tier;

    if (choice.tier === 0) {
      ctx.answeredLocally = true;
      ctx.decisions = choice.plan.decisions;
      const isNavigating = choice.plan.actions.some((a) => a.type === 'navigate');
      const hasRemainingWork = state.intents.length > choice.plan.actions.length;
      const done = !(isNavigating && hasRemainingWork);

      ctx.plan = {
        protocolVersion: PROTOCOL_VERSION,
        stepIndex: state.stepIndex,
        rationale: 'resolved on the device',
        actions: choice.plan.actions,
        // A Tier 0 answer proposes no decomposition: the grammar resolved a field, which
        // is a step, not a view about what the task is made of.
        plan: [],
        done,
      };
      ctx.tierNote = choice.plan.decisions
        .map((d) => `${d.target} -> [${d.index}] score ${d.score} gap ${d.gap}`)
        .join('; ');
      if (ctx.trace) ctx.trace.tier = { tier: 0, decisions: choice.plan.decisions };
    } else if (choice.tier === 1) {
      // Asked here rather than in `plan` so that a Tier 1 answer skips the screenshot too.
      // The whole ladder is about not paying for a tier you did not need, and a local
      // model that picks the right field has made the remote one unnecessary.
      const { intent, candidates, reason } = choice.escalation;

      // Nothing on the page scored above the floor, and the survey did not find it either.
      // At this point the grammar's reading of the sentence is the suspect part.
      //
      // "Put my first name down as Asha" is the case that made this necessary. It *parses*
      // -- `put ... as ...` is one of the five patterns -- and it parses backwards, giving
      // target "asha" and value "my first name down". A target of "asha" resolves to
      // nothing, so the step arrived here with a confident intent that was simply wrong,
      // and the reader, which gets it right, was never asked because the grammar had not
      // declared failure. A sentence read wrongly is worse than one not read at all: the
      // first produces a plan nobody checks against the sentence.
      //
      // First try normalizing the prompt against the page fields: handles multi-field
      // inputs (e.g. Card Expiration Date 10 2030 -> Month 10, Year 2030) and casual phrasing.
      if (deps.normalizeGoal) {
        const normalized = await normalizeAndRetryTier0(deps, state, ctx);
        if (normalized) return;
      }

      if (reason === 'below-floor' && deps.readGoal) {
        const answered = await readLocalPlan(deps, state, ctx);
        if (answered) return;
      }

      const outcome = deps.askLocal
        ? await deps
            .askLocal(state.goal, candidates)
            .catch(
              () => ({ ok: false, why: 'unreachable', model: 'local' }) as LocalOutcome<number>,
            )
        : null;
      const picked = outcome?.ok ? outcome.value : null;
      if (outcome) ctx.answeredBy = outcome.model;

      if (picked !== null) {
        const action = localAction(intent, picked);
        if (action) {
          ctx.plan = {
            protocolVersion: PROTOCOL_VERSION,
            stepIndex: state.stepIndex,
            rationale: 'resolved by the local model',
            actions: [action],
            plan: [],
            done: true,
          };
          // Tier 1 succeeded, so nothing after this needs to run: same short circuit as
          // Tier 0, and for the same reason -- nothing is being sent. The tier stays 1,
          // which is what it was; the short circuit is `answeredLocally`.
          ctx.answeredLocally = true;
          ctx.tierNote = `tier 1 tie-break picked [${picked}] for "${intent.target}" (${reason})`;
          if (ctx.trace) ctx.trace.tier = { tier: 1, reason, candidates: candidates.length };
          return;
        }
      }

      // If tie-break declined or was unavailable, give the local reader a chance before Tier 2
      if (deps.readGoal) {
        const answered = await readLocalPlan(deps, state, ctx);
        if (answered) return;
      }

      // Unavailable, timed out, or an answer we could not use. Not a failure -- Tier 2
      // exists for exactly this, and the log says the rung was tried.
      ctx.tier = 2;
      // Say which kind of "no" this was.
      //
      // Every failure used to read "tier 1 declined", including the one that mattered:
      // Ollama answers a chrome-extension:// origin with 403, so this rung had never once
      // run in a real browser and the log said the model had considered it and passed.
      ctx.escalation =
        outcome && !outcome.ok
          ? `tier 1 could not answer — ${describeLocalFailure(outcome.why)}`
          : `tier 1 ${deps.askLocal ? 'declined' : 'was not reachable'} (${reason})`;
      // The reader's verdict, when it had one, leads: "the local model made up a value" is
      // a more useful sentence than "tier 1 declined", and losing it here would hide the
      // one place a model's answer was actually refused.
      ctx.tierNote = [
        ctx.tierNote,
        `tier 1 ${deps.askLocal ? 'declined' : 'unavailable'} (${reason})` +
          (candidates.length > 0
            ? `: ${candidates.map((c) => `[${c.index}] ${c.label}`).join(', ')}`
            : ''),
      ]
        .filter(Boolean)
        .join(' | ');
      if (ctx.trace) ctx.trace.tier = { tier: 2, reason: `tier1-${reason}` };
    } else {
      // The grammar could not answer. Before paying for a screenshot and a remote call, ask
      // the model on this machine what the sentence means.
      //
      // Every reason except negation. The first version of this allowed only `open-ended`,
      // on the argument that a blocked goal is one the grammar refused and a small model
      // should not be invited to guess past a refusal. That was right about negation and
      // wrong about the rest, and a real instruction showed why:
      //
      //     Leo A
      //     Australia
      //     none
      //     Then click submit
      //
      // "Then click submit" parses, "Leo A" does not, so the goal is `unparsed` and went
      // straight to a planner that was not running. But there is nothing dangerous about it
      // -- it is a person listing values down a form, which is exactly the shape a reader
      // with the page's field list in front of it can turn into actions. Refusing to *ask*
      // is not a safety property; the guards in verify-plan.ts are, and they apply to the
      // answer either way.
      //
      // Negation keeps its carve-out, and it is the only one that needs it. There, being
      // wrong does the thing the user forbade, and no check on the *answer* can catch that
      // -- a plan to fill the field they said not to fill is indistinguishable from a plan
      // to fill it, because it is the same plan.
      //
      // A reading task keeps a carve-out for the opposite reason: the reader cannot be
      // *right*. Its schema is type/click/select on a shortlist of controls (worker/
      // local.ts) -- no scroll, no finish, no way to read text off the page and speak it
      // back. Asked to "show the most liked comment" it clicks the likeliest button and
      // reports done, and a bare click passes every guard in verify-plan.ts because a click
      // carries no value to invent. That is exactly the false success this fixes: the step
      // must reach Tier 2, whose planner scrolls, re-perceives and finishes with the answer.
      const reading = isReadingTask(state.goal);
      if (choice.reason !== 'negation' && !reading) {
        if (deps.normalizeGoal) {
          const normalized = await normalizeAndRetryTier0(deps, state, ctx);
          if (normalized) return;
        }
        if (deps.readGoal) {
          const answered = await readLocalPlan(deps, state, ctx);
          if (answered) return;
        }
      }
      if (reading) {
        ctx.tierNote = joinNote(ctx.tierNote, 'reading task — the local reader cannot read a page, escalating');
      }

      // Tier 2, and the reason is the part that was missing. A step that escalates without
      // being able to name what it did not understand tells the operator nothing they could
      // not have guessed; `detail` is set for exactly the reasons that are about the
      // sentence rather than about the page.
      ctx.escalation = choice.detail ?? choice.reason;
      // Tier 2 has not run yet, and naming its destination here is the point: an operator
      // reading a step that is about to leave the machine should be able to see where to.
      if (!ctx.answeredBy) ctx.answeredBy = deps.plannerName?.() ?? 'the remote planner';
      // Keep whatever the reader said about itself. Overwriting it here is how "the local
      // model made up a value" became "open-ended" -- the one sentence that says which
      // component to distrust, replaced by the one that says nothing.
      ctx.tierNote = [
        ctx.tierNote,
        choice.detail ? `${choice.reason}: ${choice.detail}` : choice.reason,
      ]
        .filter(Boolean)
        .join(' | ');
      if (ctx.trace) ctx.trace.tier = { tier: 2, reason: choice.reason };
    }
  },

  capture: async (deps, state, ctx) => {
    // No photograph when nothing is being sent. Tier 0's whole claim is that the step
    // never left the machine, and a screenshot taken to be thrown away would make that
    // claim slightly less true for no benefit at all.
    if (decidedLocally(ctx)) return;
    await captureBoundToPage(deps, state, ctx);
  },

  /**
   * L0, L1 and L2, then placeholders. All three are awaited -- the semantic layer is a
   * real model call into the offscreen document, and its latency is in the detect phase's
   * number rather than hidden behind it. L3, the pixel layers, is the one still to land.
   */
  detect: async (deps, state, ctx) => {
    // Detection exists to decide what must not cross the network. Nothing is crossing.
    if (decidedLocally(ctx)) return;
    await deps.ensureHost();
    const elements = ctx.elements ?? [];
    const viewport = ctx.geometry?.viewport ?? { w: 1, h: 1 };

    // The frame goes with it: L3 reads pixels, and the capture phase has just produced
    // the only copy that exists. Passing it here rather than re-capturing is also what
    // keeps the face boxes and the redaction boxes describing the same photograph.
    const result = await detect(
      elements,
      viewport,
      requireSession(state),
      'highPrecision',
      ctx.frame,
    );
    ctx.findings = result.findings;
    ctx.values = result.values;
    ctx.placeholders = result.placeholders;
    ctx.elementOf = result.elementOf;
    ctx.boxKinds = result.boxKinds;

    if (ctx.trace) {
      // A dropped container is a finding we refused to paint because we could not say
      // where the value was. Silent, otherwise, and it is a recall loss.
      ctx.trace.containers = result.containers;
      if (result.semanticError) ctx.trace.semanticError = result.semanticError;
      if (result.faceError) ctx.trace.faceError = result.faceError;
    }
  },

  seal: async (deps, state, ctx) => {
    if (decidedLocally(ctx)) return;
    await deps.ensureHost();
    if (!ctx.frame || !ctx.geometry) throw new Error('router: nothing captured to seal');

    const outcome = await send(
      'SEAL_AND_ENCODE',
      {
        sessionId: requireSession(state),
        stepIndex: state.stepIndex,
        frame: ctx.frame,
        findings: ctx.findings ?? [],
        viewport: ctx.geometry.viewport,
        scale: ctx.geometry.scale,
        placeholders: Object.fromEntries(ctx.placeholders ?? new Map()),
        boxKinds: ctx.boxKinds ?? {},
        // Set-of-Mark, from the same walk the element list comes from. Drawn inside the
        // gate, after the redactions -- never by leaving the debug overlay switched on,
        // which is what used to decide it and made the planner's input depend on a
        // checkbox (redaction/marks.ts).
        marks: markable(ctx.elements ?? [], ctx.geometry.viewport),
      },
      { to: 'offscreen' },
    );

    ctx.manifest = outcome.manifest;
    ctx.capture = outcome.capture;
    ctx.handoffKey = outcome.handoffKey;
    for (const [id, token] of Object.entries(outcome.placeholders)) {
      (ctx.placeholders ??= new Map()).set(id, token);
    }
  },

  /**
   * Take the bytes, verify them here rather than trusting the gate's word for it, and
   * POST. The verification is inside postStep, in a different process from the seal.
   */
  plan: async (deps, state, ctx) => {
    // Already answered, on this machine, with no network call. Acceptance criterion 2 is
    // this line: the tier that decided is recorded, and Tier 0 reaches `execute` without
    // ever having built a request.
    if (decidedLocally(ctx)) return;

    if (!ctx.manifest || !ctx.capture || !ctx.handoffKey) {
      throw new Error('router: nothing sealed to send');
    }

    const frame = await deps.takeFrame(ctx.handoffKey);
    if (!frame) throw new Error('router: the sealed frame was not where the gate left it');

    const request = buildRequest(state, ctx);
    const result = await deps.post(request, frame.bytes);
    // The one line in the project where the boundary is actually crossed, so it is the one
    // line that gets to set this.
    ctx.sent = true;
    ctx.plan = result.response;

    if (ctx.trace) {
      ctx.trace.payload = {
        imageBytes: frame.bytes.byteLength,
        requestBytes: result.requestBytes,
        responseBytes: result.responseBytes,
      };
      ctx.trace.plan = {
        actions: result.response.actions.map((a) => a.type),
        done: result.response.done,
      };
    }
  },

  /**
   * Hand the actions to the page, minus the two that are not the page's business.
   *
   * `ask` and `finish` are answered here because they are about the session, not the
   * document: one suspends the loop for the operator, the other ends it. The content
   * script still sees them -- the batch is sent whole so the ordering is honest -- and
   * returns them as no-ops.
   */
  execute: async (deps, state, ctx) => {
    if (!ctx.plan) throw new Error('router: no plan to execute');
    if (!ctx.snapshotId) throw new Error('router: no snapshot to execute against');

    const { results } = await send(
      'EXECUTE',
      {
        sessionId: requireSession(state),
        actions: ctx.plan.actions,
        snapshotId: ctx.snapshotId,
      },
      { to: 'content', tabId: requireTab(state) },
    );

    ctx.results = results;
    if (ctx.trace) {
      // Outcomes only. The notes are placeholder-safe by construction, but the trace is
      // the artefact most likely to be enlarged on a slide and it does not need them.
      ctx.trace.execution = results.map((r) => r.outcome);
    }

    // What the planner is told happened. Without this its history says "step" and it
    // re-plans the same action forever, having no way to learn that it already ran.
    //
    // Safe to record because of how the executor writes notes: by token and index,
    // never by value. That is asserted from this end too -- see the sweep in
    // router.test.ts, which greps every surface for a rehydrated value.
    ctx.historyNote = results
      .map((r, i) => r.note ?? `${ctx.plan?.actions[i]?.type ?? 'action'} ${r.outcome}`)
      .join('; ')
      .slice(0, 200);

    // The plan's own terminators. Checked after execution so their position in the
    // batch is respected -- a `finish` after three actions means those three ran.
    const terminator = ctx.plan.actions.find((a) => a.type === 'ask' || a.type === 'finish');
    if (terminator?.type === 'ask') {
      ctx.suspend = { kind: 'ask', note: terminator.question };
    } else if (terminator?.type === 'finish') {
      ctx.suspend = { kind: 'finish', note: `${terminator.status}: ${terminator.summary}` };
    } else if (ctx.plan.done && (ctx.sent || !ctx.subgoal)) {
      // `done` from the device is a claim about the *sentence*, not about the task.
      //
      // Tier 0 resolves the intents it parsed and sets `done` because it has nothing left
      // to resolve -- which was the whole truth until decompositions existed. It is not
      // any more: "go to the portal, fill full name, submit" gives Tier 0 one field it can
      // place, and a plan with three legs still to run. Honouring `done` there ended the
      // session after one step, on a task the agent had barely started, with the note "the
      // plan made on this device had nothing left to do".
      //
      // So a locally made `done` is honoured only when no leg is in flight. A planner's
      // `done` still is, because the planner is shown the plan and its statuses
      // (contract.ts) and is answering about the task rather than about a clause. An
      // explicit `finish` action is honoured either way -- that is a terminator, not a
      // flag.
      // `done` is the other way a plan can say it is over, and it was being ignored.
      //
      // The stub always pairs it with a `finish` action, so nothing noticed until a real
      // model drove the loop: qwen3:0.6b set `done: true` on four separate steps of one
      // run and the agent carried on regardless, re-typing into a field it had already
      // filled. The contract offers both signals; honouring one and silently dropping the
      // other means the planner's clearest statement about its own work depends on which
      // of two equivalent forms it happened to choose.
      // Who said so matters. This sentence was printed verbatim after a step that no
      // planner had any part in -- the plan was built from the DOM on this machine, the
      // network was never touched, and the log still credited a remote model with the
      // verdict. An operator reading "the planner reported the task done" reasonably
      // concludes a planner was reached.
      ctx.suspend = {
        kind: 'finish',
        note: ctx.sent
          ? 'the planner reported the task done'
          : 'the plan made on this device had nothing left to do',
      };
    }

    void deps;
  },

  /**
   * Look at the page again, and only then decide whether anything was achieved.
   *
   * The loop used to have nothing here -- the next step is triggered by a settle, a
   * navigation or the user, so there was nothing for this phase to *do*. There is now, and
   * it is the one thing that could not be done anywhere else: every earlier phase knows
   * what the agent intended, and this is the first moment at which the page can be asked
   * what actually happened.
   *
   * Only for steps that are about to claim they are finished. A step that will be followed
   * by another step has not made a claim yet, and checking after every batch would turn a
   * mid-task field the planner intends to revisit into a reported failure.
   */
  settle: async (deps, state, ctx) => {
    // Every step, not only the one whose plan said `finish`.
    //
    // This guard used to be `if (!ctx.suspend || ctx.suspend.kind !== 'finish') return`,
    // which meant a multi-step run verified exactly one step: the last. A run that filled
    // the first name on step 1 and the last name on step 3 reached the completion check
    // holding step 3's verdicts alone, and reported that the first name was never acted
    // on. Progress that is only ever measured at the end is not progress, it is a guess
    // about the end.
    //
    // The cost is one VERIFY_FILLED per step that typed or selected something. That is a
    // content-script round trip -- no model, no capture, no network -- and it is the only
    // thing in the loop that can tell "the executor did not throw" from "the page holds
    // the value".
    if (!ctx.plan || !ctx.snapshotId) return;

    const actions = ctx.plan.actions;

    // A value can be read back. Everything else is verified by what the page made of it at
    // the time, which the executor already recorded.
    //
    // That second half was missing, and it made the completion check accuse the agent of
    // not doing things it had just done. "Click login button" clicked the login button, the
    // modal opened, and the step ended `incomplete at settle` saying `"login" was never
    // acted on` -- because only `type` actions produced a verdict, so a click produced none,
    // and an intent with no verdict is treated as never attempted. Which is the right rule;
    // it was being fed an incomplete list.
    const valueBearing = actions.flatMap((action, at) => {
      if (action.type === 'type') {
        return [{ at, index: action.index, text: action.text }];
      }
      if (action.type === 'select') {
        return [{ at, index: action.index, text: action.option }];
      }
      return [];
    });

    const verdicts = new Map<number, import('../shared/messages').VerifyReason>();
    if (valueBearing.length > 0) {
      const { results } = await send(
        'VERIFY_FILLED',
        {
          sessionId: requireSession(state),
          snapshotId: ctx.snapshotId,
          checks: valueBearing.map(({ index, text }) => ({ index, text })),
        },
        { to: 'content', tabId: requireTab(state) },
      );
      valueBearing.forEach((check, i) => verdicts.set(check.at, results[i]?.reason ?? 'missing'));
    }

    // Name each verdict by the field the *user* asked for, not by index. "last name is still
    // empty" is a sentence an operator can act on; "[7] differs" is one they have to decode
    // against a walk that no longer exists.
    ctx.fulfilments = actions.flatMap((action, at): Fulfilment[] => {
      const execResult = ctx.results?.[at];
      const outcome = execResult?.outcome;

      if (action.type === 'type') {
        return [
          {
            target: targetForIndex(state, ctx, action.index),
            verb: 'fill' as const,
            reason: verdicts.get(at) ?? ('missing' as const),
          },
        ];
      }

      if (action.type === 'select') {
        return [
          {
            target: targetForIndex(state, ctx, action.index),
            verb: 'select' as const,
            reason:
              verdicts.get(at) ??
              (outcome === 'failed' ? ('not-done' as const) : ('not-applicable' as const)),
          },
        ];
      }

      if (action.type === 'click') {
        return [
          {
            target: targetForIndex(state, ctx, action.index),
            verb: 'click' as const,
            reason: outcome === 'failed' ? ('not-done' as const) : ('not-applicable' as const),
          },
        ];
      }

      if (action.type === 'navigate') {
        return [
          {
            target: targetForIndex(state, ctx, -1),
            verb: 'navigate' as const,
            reason: outcome === 'failed' ? ('not-done' as const) : ('not-applicable' as const),
          },
        ];
      }

      // wait, key, scroll, ask, finish: not work on a named field, and nothing
      // the user's sentence asked for by name.
      return [];
    });

    if (ctx.trace) {
      ctx.trace.fulfilled = ctx.fulfilments.map((f) => f.reason);
    }
  },
};

/**
 * Ask the local model to rewrite / normalize the sentence into standard grammar clauses,
 * then parse and retry Tier 0 resolution.
 */
async function normalizeAndRetryTier0(
  deps: RouterDeps,
  state: AgentState,
  ctx: StepContext,
): Promise<boolean> {
  if (!deps.normalizeGoal) return false;

  const elements = ctx.elements ?? [];
  const candidates = shortlistFor(elements);

  const outcome = await deps
    .normalizeGoal(state.goal, candidates)
    .catch(
      () => ({ ok: false, why: 'unreachable', model: 'local' }) as LocalOutcome<string>,
    );

  if (!outcome.ok || !outcome.value) return false;

  const normalizedGoal = outcome.value;
  const parsed = parseGoal(normalizedGoal);
  if (parsed.intents.length === 0 || parsed.block) return false;

  const choice = chooseTier(
    { intents: parsed.intents, ...(parsed.block ? { block: parsed.block } : {}) },
    elements,
  );
  if (choice.tier === 0) {
    ctx.tier = 0;
    ctx.answeredLocally = true;
    ctx.normalizedLocally = true;
    ctx.decisions = choice.plan.decisions;
    ctx.answeredBy = outcome.model;
    const isNavigating = choice.plan.actions.some((a) => a.type === 'navigate');
    const hasRemainingWork = parsed.intents.length > choice.plan.actions.length;
    const done = !(isNavigating && hasRemainingWork);
    state.intents = parsed.intents;
    state.residue = [];
    await updateState(deps.store, (s) => ({ ...s, intents: parsed.intents, residue: [] }));
    ctx.plan = {
      protocolVersion: PROTOCOL_VERSION,
      stepIndex: state.stepIndex,
      rationale: `normalized prompt into "${normalizedGoal}" and resolved on device`,
      actions: choice.plan.actions,
      plan: [],
      done,
    };
    ctx.tierNote =
      `tier 1 normalized prompt -> tier 0: ` +
      choice.plan.decisions
        .map((d) => `${d.target} -> [${d.index}] score ${d.score} gap ${d.gap}`)
        .join('; ');
    if (ctx.trace) ctx.trace.tier = { tier: 0, decisions: choice.plan.decisions };
    return true;
  }

  return false;
}

/**
 * Ask the local model to read the whole sentence, and check its homework.
 *
 * Returns true when it produced a plan this step will act on. Every other outcome -- no
 * model, a timeout, an empty list, an index that does not exist, a value the user never
 * typed -- returns false, and the caller escalates exactly as it did before.
 *
 * The verification is the load-bearing part, and `verify-plan.ts` says why: a model asked
 * what to type into an email box has an overwhelmingly likely answer that has nothing to do
 * with the person in front of it, and an invented value looks precisely like success.
 */
async function readLocalPlan(
  deps: RouterDeps,
  state: AgentState,
  ctx: StepContext,
): Promise<boolean> {
  if (!deps.readGoal) return false;

  const elements = ctx.elements ?? [];
  const candidates = shortlistFor(elements);

  // One attempt.
  //
  // A retry, told exactly what the guard had refused, was built and measured and removed:
  // `qwen2.5:1.5b` went from 3/8 correct to 2/8, and from 3.6s to 10.3s a call. It does not
  // use the correction, it re-rolls -- and one re-roll turned a correct answer into an
  // invented surname. The model that needs a second chance is the model that cannot use one.
  const outcome = await deps
    .readGoal(state.goal, candidates, undefined, verifiedWork(state.progress))
    .catch(
      () => ({ ok: false, why: 'unreachable', model: 'local' }) as LocalOutcome<LocalAction[]>,
    );

  ctx.answeredBy = outcome.model;

  if (!outcome.ok) {
    ctx.tierNote = `tier 1 could not read the goal — ${describeLocalFailure(outcome.why)}`;
    if (ctx.trace) ctx.trace.localPlan = { proposed: 0, rejected: outcome.why };
    return false;
  }

  if (outcome.value.length === 0) {
    // The model saying it cannot tell. Not a fault, and worth distinguishing from one.
    ctx.tierNote = 'tier 1 read the goal and found nothing it could do';
    if (ctx.trace) ctx.trace.localPlan = { proposed: 0 };
    return false;
  }

  const checked = verifyPlan(outcome.value, elements, state.goal);
  if (!checked.ok) {
    // Refused, and the refusal is worth saying out loud. "The local model made up a value"
    // is the sentence an operator needs in order to distrust the right component.
    ctx.tierNote = `tier 1 refused: ${describeRejection(checked.reason)}`;
    if (ctx.trace) {
      ctx.trace.localPlan = { proposed: outcome.value.length, rejected: checked.reason.kind };
    }
    return false;
  }

  ctx.tier = 1;
  ctx.answeredLocally = true;
  ctx.plan = {
    protocolVersion: PROTOCOL_VERSION,
    stepIndex: state.stepIndex,
    rationale: 'read on this device by the local model',
    actions: checked.actions,
    plan: [],
    done: true,
  };

  // What was kept and what was not, in one line. A partial plan that does not say it is
  // partial is the shape of nearly every failure this project has spent its time on; the
  // completion check re-reads the fields afterwards and ends the session `incomplete` if
  // the dropped action turns out to have mattered.
  const first = checked.dropped[0];
  ctx.tierNote =
    `tier 1 read the goal into ${checked.actions.length} action` +
    `${checked.actions.length === 1 ? '' : 's'}` +
    (first ? `, and refused ${checked.dropped.length}: ${describeRejection(first)}` : '');

  if (ctx.trace) {
    ctx.trace.tier = { tier: 1, reason: 'open-ended', candidates: candidates.length };
    ctx.trace.localPlan = {
      proposed: outcome.value.length,
      accepted: checked.actions.length,
      ...(first ? { rejected: first.kind } : {}),
    };
  }
  return true;
}

/** How many elements the local model is shown. A shortlist a small model can hold. */
const LOCAL_SHORTLIST = 40;

/**
 * Roles worth putting in front of the reader, in the order they are worth it.
 *
 * The first pass built the shortlist by truncation -- the first forty elements in paint
 * order -- and on any real page that is the navigation. On the w3schools contact form the
 * fields are at index 60 and up, behind a tutorial menu, so the model was shown fifty links
 * and asked which one to type a name into. It answered `[8]`, a button, and the guard
 * refused it: a correct refusal of a question that should never have been asked in that
 * form.
 *
 * Ordering by role rather than by position. A page has a handful of inputs and a hundred
 * links, and the sentences that reach the reader are overwhelmingly about the inputs.
 */
const SHORTLIST_ROLES: readonly string[] = [
  'textbox',
  'searchbox',
  'spinbutton',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'button',
  'link',
  'tab',
  'menuitem',
];

/**
 * The elements the reader is shown, most useful first.
 *
 * Sorted by role, then by document order within a role, then cut. What that buys on a real
 * page is that the cut falls in the links rather than in the form.
 */
function shortlistFor(elements: readonly ObservedElement[]): LocalCandidate[] {
  const usable = elements.filter(
    (element) => element.index !== undefined && SHORTLIST_ROLES.includes(element.role),
  );

  const ranked = [...usable].sort((a, b) => {
    const byRole = SHORTLIST_ROLES.indexOf(a.role) - SHORTLIST_ROLES.indexOf(b.role);
    return byRole !== 0 ? byRole : (a.index ?? 0) - (b.index ?? 0);
  });

  return ranked.slice(0, LOCAL_SHORTLIST).map((element) => ({
    index: element.index as number,
    score: 0,
    // The name a person would use for it. `nearbyText` is in here because a field the page
    // never labelled is exactly the field a user has to describe in words.
    label:
      element.labelText ??
      element.ariaLabel ??
      (element.name || undefined) ??
      element.nearbyText ??
      element.placeholder ??
      '',
    role: element.role,
  }));
}

/**
 * Scroll to what the sentence named, then look again.
 *
 * Three round trips at most per attempt -- survey, reveal, re-perceive -- and the survey is
 * done once and reused. The loop terminates on the first tier-0 answer, on running out of
 * intents it could place, or on REVEAL_ATTEMPTS, whichever comes first.
 *
 * On failure the original choice is returned untouched, so a page where the field genuinely
 * does not exist escalates exactly as it did before, with the same reason. A fallback that
 * changes the failure mode of the case it cannot fix is worse than no fallback.
 */
async function revealAndRetry(
  deps: RouterDeps,
  state: AgentState,
  ctx: StepContext,
  goal: Parameters<typeof chooseTier>[0],
  original: TierChoice,
): Promise<TierChoice> {
  const sessionId = requireSession(state);
  const tabId = requireTab(state);

  // Every message in this function is best-effort.
  //
  // The reveal is an enhancement to a step that was already going to escalate, so nothing
  // here may turn "escalate" into "fail". A content script from a previous build does not
  // answer SURVEY at all, and without this that step would die in `perceive` instead of
  // going to the planner -- a fallback that breaks the case it cannot help is worse than
  // no fallback.
  const surveyed = await send('SURVEY', { sessionId }, { to: 'content', tabId }).catch(
    () => null,
  );
  if (!surveyed) return original;

  const targets = locate(goal.intents, ctx.elements ?? [], surveyed.elements);

  if (ctx.trace) {
    ctx.trace.survey = { controls: surveyed.total, offScreen: targets.length, reveals: 0 };
  }

  // Nothing off screen matches either. The page does not have this field, and no amount
  // of scrolling is going to produce one.
  if (targets.length === 0) {
    ctx.revealNote = `searched all ${surveyed.total} controls on the page`;
    return original;
  }

  const revealed: string[] = [];
  for (const target of targets.slice(0, REVEAL_ATTEMPTS)) {
    const reveal = await send(
      'REVEAL',
      { sessionId, key: target.key },
      { to: 'content', tabId },
    ).catch(() => null);
    if (!reveal?.found) continue;
    revealed.push(target.intent.target);

    // Perceive again, properly. This is a normal viewport walk with real indices and a
    // real snapshot id -- the survey's numbering never leaves `locate`.
    const snapshot = await send('DOM_SNAPSHOT', { sessionId }, { to: 'content', tabId }).catch(
      () => null,
    );
    if (!snapshot) break;
    ctx.elements = snapshot.elements;
    ctx.snapshotId = snapshot.snapshotId;
    if (ctx.trace?.survey) ctx.trace.survey.reveals = revealed.length;

    const retried = chooseTier(goal, ctx.elements);
    if (retried.tier === 0) {
      ctx.revealNote = describeReveal(targets, revealed);
      return retried;
    }
  }

  // Revealed something and still could not place the whole goal. Two fields three screens
  // apart cannot share a viewport, and half a plan is not an improvement on none: the
  // batch carries indices from one walk, so acting on the half that resolved would leave
  // the other half owned by nobody.
  ctx.revealNote =
    revealed.length > 0
      ? `scrolled to ${revealed.map((r) => `"${r}"`).join(', ')}, and the goal still ` +
        `names a field that is not on screen with it`
      : describeReveal(targets, revealed);

  // Not `original` -- that choice was computed against the walk from before the scroll,
  // and its escalation carries candidate *indices* from that walk. Handing those to Tier 1
  // after the page has moved would have the local model pick a number that names a
  // different element in the snapshot the executor is holding, which is the silent
  // wrong-element failure this project keeps finding, reintroduced by its own fix.
  //
  // When nothing was revealed, `ctx.elements` is untouched and this returns exactly what
  // `original` said.
  return revealed.length > 0 ? chooseTier(goal, ctx.elements ?? []) : original;
}

/**
 * Which field name the user used for the element at this index.
 *
 * Falls back to the index because a Tier 2 plan types into fields the user never named --
 * that is the planner's business and there is no user's word for it. Never a value.
 */
function targetForIndex(
  state: AgentState,
  ctx: StepContext,
  index: number | undefined,
): string {
  if (index === undefined) return 'a field';

  // Tier 0 recorded which intent won which element, so this is exact.
  if (ctx.decisions) {
    const hit = ctx.decisions.find((d) => d.index === index);
    if (hit) return hit.target;
  }
  const decided = ctx.trace?.tier;
  if (decided?.tier === 0) {
    const hit = decided.decisions.find((d) => d.index === index);
    if (hit) return hit.target;
  }

  // Tier 1 resolved a single intent, so there is only one name it could be.
  const only = state.intents.length === 1 ? state.intents[0] : undefined;
  if (only) return only.target;

  // Nothing named this action, but the plan knows what it was *for*. Naming the work
  // after the leg is what lets an `action-verified` criterion recognise it afterwards --
  // otherwise the ledger says `field [7]`, the criterion is looking for "the cart", and a
  // leg that had been carried out correctly never finishes.
  if (ctx.subgoalHint) return ctx.subgoalHint;
  return `field [${index}]`;
}

/** A page that moved between the measurement and the photograph. */
export class GeometryDrift extends Error {
  constructor(readonly drift: string[]) {
    super(`page moved during capture: ${drift.join(', ')}`);
    this.name = 'GeometryDrift';
  }
}

/**
 * Measure, photograph, then check the page did not move in between.
 *
 * The gap between CAPTURE and captureVisibleTab is unbounded -- a message round trip
 * plus Chrome's own rate limiter -- and a page that scrolls inside it leaves every box
 * describing somewhere the frame does not show. The check is cheap; getting it wrong is
 * a redaction box beside the Aadhaar number rather than on it, which looks like it
 * worked.
 *
 * On drift: throw the frame away, re-measure, try once more. A page that will not hold
 * still twice running is animated, and failing the step says so honestly instead of
 * looping on it.
 */
export async function captureBoundToPage(
  deps: RouterDeps,
  state: AgentState,
  ctx: StepContext,
): Promise<void> {
  const sessionId = requireSession(state);
  const tabId = requireTab(state);

  for (let attempt = 1; attempt <= MAX_GEOMETRY_ATTEMPTS; attempt += 1) {
    const geometry = await send('CAPTURE', { sessionId }, { to: 'content', tabId });
    const frame = await deps.captureFrame({
      width: Math.round(geometry.viewport.w * geometry.scale),
      height: Math.round(geometry.viewport.h * geometry.scale),
      scale: geometry.scale,
    });

    const check = await send(
      'GEOMETRY_CHECK',
      { token: geometry.token },
      { to: 'content', tabId },
    );
    if (check.valid) {
      ctx.geometry = geometry;
      ctx.frame = frame;
      return;
    }

    const drift = tokenDrift(geometry.token, check.current);

    // The page will not hold still, but did anything actually *move*?
    //
    // Only asked on the last attempt, so a page that settles keeps the strict guarantee
    // and pays nothing for this. On a page that never settles it is the difference
    // between working and not: measured on live government portals, indianrail.gov.in
    // drifted `mutationSeq 8 -> 48` and incometax.gov.in `7 -> 35` between measuring and
    // photographing, with every geometric field identical. A rotating banner bumps that
    // counter thirty times a second and moves nothing, and the strict check discarded
    // every frame for ever -- so the agent could not see either site at all.
    //
    // Accepting here does not weaken invariant 2. Every box is still where it was
    // measured, because nothing that positions a box changed. What it risks is a *stale*
    // box -- text that changed after measurement and was therefore never detected -- and
    // that is a missed finding, not paint landing on the wrong thing.
    //
    // Counted, and named in the step note. A concession nobody can see is a concession
    // that becomes a habit.
    if (attempt === MAX_GEOMETRY_ATTEMPTS && geometryMatches(geometry.token, check.current)) {
      ctx.contentDrifts += 1;
      ctx.geometry = geometry;
      ctx.frame = frame;
      await emit(deps, state, {
        kind: 'phase',
        phase: 'capture',
        note: `frame kept: the page mutated but did not move (${drift.join(', ')})`,
      });
      return;
    }

    ctx.discards += 1;
    await emit(deps, state, {
      kind: 'phase',
      phase: 'capture',
      note: `frame discarded, attempt ${attempt}: ${drift.join(', ')}`,
    });

    if (attempt === MAX_GEOMETRY_ATTEMPTS) throw new GeometryDrift(drift);

    // Re-measuring means re-perceiving: the boxes belonged to the page as it was.
    const snapshot = await send('DOM_SNAPSHOT', { sessionId }, { to: 'content', tabId });
    ctx.elements = snapshot.elements;
    // The re-walk replaced the handle map, so the indices the plan will carry are the
    // new ones. Forgetting this is how a retry ends up rejected as stale.
    ctx.snapshotId = snapshot.snapshotId;
  }
}

/**
 * One step, phase by phase. Never called with await from a message handler -- the reply
 * must not wait for the step.
 */
export async function runStep(deps: RouterDeps, reason: string): Promise<StepOutcome> {
  let state = await loadState(deps.store);
  if (!canAcceptStep(state)) return 'stopped';

  // The only terminator the loop owns. `finish` and `ask` belong to the plan, so without
  // this the sole thing ending a run is the planner's own judgement -- and a planner that
  // cannot see why its last action failed will re-plan it for as long as the tab is open,
  // at a screenshot, a detection pass and a POST per round.
  if (budgetSpent(state)) {
    const spent = await updateState(deps.store, (s) => exhaust(s, deps.now()));
    await emit(deps, spent, {
      kind: 'step-end',
      outcome: 'stopped',
      status: spent.status,
      note: spent.log[spent.log.length - 1]?.note,
    });
    void deps.releaseHost();
    return 'stopped';
  }

  // Two terminators beside the step budget, and they end runs MAX_STEPS would only end
  // twenty steps later, having paid for a screenshot, a detection pass and a POST each
  // time.
  //
  // `retries` is consecutive failed steps: `endStep` deliberately does not advance
  // `stepIndex` on a failure, so a step that throws is retried rather than skipped --
  // right, and without a ceiling it means a genuinely broken page burns the whole budget
  // re-running the phase that threw.
  //
  // `stalled` is consecutive steps that verified nothing new. Those steps *succeed*: the
  // plan is carried out, nothing throws, and the ledger is identical afterwards. That is
  // the cheapest possible non-progress running the most expensive possible way.
  const giveUp = stuckReason(state);
  if (giveUp) {
    const halted = await updateState(deps.store, (s) => halt(s, { ...giveUp, now: deps.now() }));
    await emit(deps, halted, {
      kind: 'step-end',
      outcome: giveUp.outcome,
      status: halted.status,
      note: giveUp.note,
    });
    void deps.releaseHost();
    return giveUp.outcome;
  }

  const ctx: StepContext = { discards: 0, contentDrifts: 0, sent: false };
  ctx.trace = startStep(state.sessionId ?? '', state.stepIndex, deps.now());
  // The overlay draws index badges onto the page, so when it is on it is *in* the frame
  // the planner is shown. Recorded per step because a Tier 2 answer that changed because
  // somebody ticked a checkbox should be explainable from the trace.
  ctx.trace.overlay = state.overlay;
  // On every step, not only the ones that escalate. Acceptance criterion 5 of M16, and the
  // reason for it: a run acting on half a sentence looked exactly like a run acting on all
  // of it, from every artefact the project produces.
  ctx.trace.goal = {
    coverage: state.coverage,
    residue: state.residue,
    ...(state.block ? { block: state.block.kind } : {}),
  };

  // Every write in this loop is a read-modify-write and goes through `updateState`, which
  // serialises them against the message handlers. A bare `saveState` here would write a
  // whole record built from a read taken before the last await, and quietly undo anything
  // a handler set in between -- which is precisely the flag that decides whether the loop
  // takes another step. See the note on the queue in state.ts.
  state = await updateState(deps.store, (s) => beginStep(s, deps.now()));
  await emit(deps, state, { kind: 'step-start', note: reason });

  for (const phase of PHASES) {
    state = await updateState(deps.store, (s) =>
      s.status === 'stopping' ? s : enterPhase(s, phase, deps.now()),
    );
    if (state.status === 'stopping') {
      return await finish(deps, state, 'stopped', 'stopped by the operator', ctx);
    }

    await emit(deps, state, { kind: 'phase', phase });

    const startedAt = deps.now();
    try {
      await RUNNERS[phase](deps, state, ctx);
      if (ctx.trace) record(ctx.trace, phase, deps.now() - startedAt);
    } catch (err) {
      if (ctx.trace) {
        record(ctx.trace, phase, deps.now() - startedAt, 'failed');
        ctx.trace.error = err instanceof TransportError ? err.kind : 'phase-failed';
      }
      const message =
        err instanceof GeometryDrift
          ? `page would not hold still (${err.drift.join(', ')})`
          : err instanceof Error
            ? err.message
            : String(err);
      // The reason the step escalated survives the failure that followed it.
      //
      // Without this the operator gets "no answer from the planner" and nothing else --
      // true, and useless, because it does not say what the agent was trying to ask the
      // planner or why it needed to. A refusal followed by an unreachable planner reads
      // exactly like a broken build, and it is the system working: the sentence was one the
      // grammar declined to guess at, and the only thing that could have answered it was not
      // there. Both halves, in the order they happened.
      // `tierNote` as well as `escalation`, and it was missing.
      //
      // The two say different things: `escalation` is "tier 1 declined", and `tierNote` is
      // what each rung actually measured on the way past -- including, now, whether the
      // local reader was asked and what became of its answer. Leaving it out meant that on
      // a failed step, which is exactly when someone is reading the log, every measurement
      // the tiers made was thrown away and the note said only that the planner was down.
      const why = joinNote(
        describeTier(ctx),
        ctx.planNote,
        ctx.revealNote,
        ctx.tierNote,
        ctx.escalation,
        message,
      );
      // A frame the page invalidated, or a planner that did not answer, is a reason to
      // take the step again rather than to end a task the run may be most of the way
      // through. Anything else is not: a phase that threw for its own reasons will throw
      // again, at the same cost.
      const retryable =
        err instanceof GeometryDrift ||
        err instanceof TransportError ||
        // A reply that did not come in time. The commonest cause is the offscreen
        // document loading a model on its first real step, which the next step does not
        // have to pay for again.
        err instanceof BusTimeout;
      return await finish(deps, await loadState(deps.store), 'failed', why, ctx, retryable);
    }
    const spent = deps.now() - startedAt;
    // Kept, not just announced. The event reaches an open panel; the log is what a panel
    // opened afterwards has to read, and what survives the worker being killed.
    state = await updateState(deps.store, (s) => recordPhase(s, phase, spent, deps.now()));
    await emit(deps, state, { kind: 'phase', phase, ms: spent });
  }

  // The plan's own terminators, honoured after the batch rather than before it, so an
  // `ask` or `finish` at the end of a plan still lets the actions before it run.
  //
  // Both end the loop: `finish` because the task is over, `ask` because the next move
  // is the operator's and stepping again would just re-plan against the same page.
  // Neither is a failure -- the step did what it was told.
  // The tier leads every note, including a terminating one. "tier 0 | first name -> [1]
  // score 18 gap 10" says what happened, what it cost and how sure it was, in one line.
  const tierNote = joinNote(describeTier(ctx), ctx.planNote, ctx.revealNote, ctx.tierNote);

  if (ctx.suspend) {
    const stopped = await updateState(deps.store, (current) =>
      requestStop(current, deps.now()),
    );

    // The last gate before the agent is allowed to say it finished.
    //
    // Everything above this line describes what the agent *did*. This is the only thing
    // that describes what is *true of the page*, and it is allowed to overrule the plan.
    // A planner saying "done" is a planner's opinion about its own work; the field being
    // empty is not an opinion.
    // The ledger with this step's verdicts folded in, computed rather than written:
    // `finish` performs the same fold under `updateState`, and doing it twice would count
    // this step's attempts twice. `advanceProgress` is pure, so the two agree.
    const ledger = advanceProgress(stopped.progress, {
      stepIndex: stopped.stepIndex,
      outcome: 'ok',
      verdicts: ctx.fulfilments ?? [],
      now: deps.now(),
    });

    const completion =
      ctx.suspend.kind === 'finish'
        ? assessCompletion({
            intents: stopped.intents,
            residue: stopped.residue,
            // The whole run's verified work, not the last step's. See progress.ts.
            fulfilments: progressFulfilments(ledger),
            sent: ctx.sent,
            // Tier 1's reader or prompt normalizer was given the whole sentence, so when it answered,
            // the words the grammar could not read were read by a model that could.
            readLocally:
              (ctx.tier === 1 || ctx.normalizedLocally === true) && ctx.answeredLocally === true,
          })
        : { complete: true, outstanding: [] };

    if (completion.complete) ctx.completed = true;

    const note = joinNote(
      tierNote,
      `${ctx.suspend.kind}: ${ctx.suspend.note}`,
      describeCompletion(completion),
    );
    return await finish(deps, stopped, completion.complete ? 'ok' : 'incomplete', note, ctx);
  }

  if (ctx.plan?.actions.some((a) => a.type === 'navigate')) {
    await updateState(deps.store, (s) => ({
      ...s,
      intents: s.intents.filter((i) => i.verb !== 'navigate'),
    }));
  }

  const note = joinNote(tierNote, ctx.historyNote);
  return await finish(deps, await loadState(deps.store), 'ok', note || undefined, ctx);
}

/**
 * The tier, and whether anything left the machine.
 *
 * Both, always, and in that order. "tier 1 · nothing sent" is the project's strongest claim
 * stated in four words -- a model decided this step and the network was never touched --
 * and until now the log could only say "tier 0", which is a weaker claim *and* a false one.
 */
/**
 * Join note fragments, dropping anything already said.
 *
 * The fragments come from layers that do not know about each other -- the tier choice, the
 * reveal, the escalation reason, the failure -- and two of them legitimately derive from the
 * same source, so a blocked goal read "negation: the goal says dont ... | the goal says
 * dont ...". A note that repeats itself is a note people stop reading.
 */
function joinNote(...parts: Array<string | undefined>): string {
  const kept: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (kept.some((seen) => seen.includes(part) || part.includes(seen))) continue;
    kept.push(part);
  }
  return kept.join(' | ');
}

function describeTier(ctx: StepContext): string {
  if (ctx.tier === undefined) return '';

  // Three facts in one line, and each of them is one somebody asked for: which rung
  // answered, who it asked, and whether anything crossed the boundary. "tier 1" alone does
  // not say which of two local models did the work, and "tier 2" alone does not say where
  // the step was headed.
  const who =
    ctx.tier === 0
      ? 'the device'
      : (ctx.answeredBy ?? (ctx.tier === 1 ? 'a local model' : 'the remote planner'));

  return `tier ${ctx.tier} · ${who} · ${ctx.sent ? 'sent' : 'nothing sent'}`;
}

/** One structured line per step, once the step is over either way. */
function writeTrace(
  deps: RouterDeps,
  ctx: StepContext | undefined,
  outcome: StepOutcome,
): void {
  if (!ctx?.trace) return;

  const trace = ctx.trace;
  trace.outcome = outcome;
  trace.elements = ctx.elements?.length;
  trace.framesDiscarded = ctx.discards;
  trace.framesContentDrifted = ctx.contentDrifts;
  trace.sent = ctx.sent;
  if (ctx.answeredBy) trace.answeredBy = ctx.answeredBy;

  if (ctx.findings) {
    const byClass: Record<string, number> = {};
    const byLayer: Record<string, number> = {};
    const byOrigin: Record<string, number> = {};
    for (const finding of ctx.findings) {
      byClass[finding.cls] = (byClass[finding.cls] ?? 0) + 1;
      byLayer[finding.layer] = (byLayer[finding.layer] ?? 0) + 1;
      byOrigin[finding.origin] = (byOrigin[finding.origin] ?? 0) + 1;
    }
    trace.findings = { total: ctx.findings.length, byClass, byLayer, byOrigin };
  }

  if (ctx.manifest) {
    trace.redaction = {
      redactedFraction: ctx.manifest.redactedFraction,
      overRedactedFraction: ctx.manifest.overRedactedFraction,
      ops: ctx.manifest.findings.filter((f) => f.mode !== 'keep').length,
      kept: ctx.manifest.findings.filter((f) => f.mode === 'keep').length,
    };
  }

  emitTrace(trace, deps.trace);

  // The HUD reads this rather than timing anything itself. A push, and a failure is not
  // one: the panel is usually not open, and a debugging surface must never be able to
  // fail a step.
  void send('PANEL_TRACE', { trace }, { to: 'panel' }).catch(() => undefined);
}

/**
 * The parts of the caller's state that describe the step it just ran, as opposed to
 * what the session has since become. Merged over the stored record so that ending a step
 * cannot roll back anything a message handler wrote while the step was in flight.
 */
function stepFacts(state: AgentState): Partial<AgentState> {
  return {
    status: state.status,
    phase: state.phase,
    stepIndex: state.stepIndex,
    busy: state.busy,
    log: state.log,
  };
}

async function finish(
  deps: RouterDeps,
  state: AgentState,
  outcome: StepOutcome,
  note?: string,
  ctx?: StepContext,
  retryable = false,
): Promise<StepOutcome> {
  writeTrace(deps, ctx, outcome);

  // Read-modify-write, not the state the caller was holding.
  //
  // The caller's copy was read before the step's last phase, and a step's last phase is
  // exactly when the events that matter arrive -- the click that navigates is the final
  // action, and page B's content script announces itself while this function is still
  // being called. That handler sets `pendingPerceive` through `updateState`; saving a
  // snapshot taken before it would set the flag straight back to false and lose the only
  // record that the new page was ever seen. Which is what happened: the session ended at
  // `running`, idle, on a page it had never perceived, roughly half the time.
  //
  // `state` is still the argument because the outcome and the log entry belong to the
  // step that just ran, and those are the caller's to decide.
  const next = await updateState(deps.store, (current) => {
    const ended = endStep(
      {
        ...current,
        ...stepFacts(state),
        // Counted here rather than in the trace, because the popup outlives the trace and
        // the offscreen ring both: the ring is released when the session ends, and after a
        // device-only run there is nothing left to ask about how it went.
        stepsRun: current.stepsRun + 1,
        stepsSent: current.stepsSent + (ctx?.sent ? 1 : 0),
        stepsLocal: current.stepsLocal + (outcome === 'ok' && !ctx?.sent ? 1 : 0),
      },
      {
        outcome,
        now: deps.now(),
        note,
        retryable,
      },
    );
    if (!ctx) return ended;

    // A planner that returned a decomposition replaces the one the device derived --
    // keeping the progress of every leg whose id it reused. That is the replanning path:
    // the model that can see the page gets to say the plan was wrong, in the same
    // vocabulary, without undoing the legs the page already confirmed. See progress.ts.
    const replanned =
      ctx.plan && ctx.plan.plan.length > 0
        ? adoptPlan(current.progress, ctx.plan.plan, state.stepIndex)
        : current.progress;

    // Fold this step's verdicts into the run's ledger, under the same read-modify-write
    // as the rest of the step's state so a handler waking the worker cannot interleave.
    // `state.stepIndex`, not `ended.stepIndex`: endStep has already advanced the latter
    // past the step these verdicts belong to.
    const advanced = advanceProgress(replanned, {
      stepIndex: state.stepIndex,
      outcome,
      verdicts: ctx.fulfilments ?? [],
      now: deps.now(),
    });

    return {
      ...ended,
      // A count, not content: how many frames the page invalidated under us. M11 reports it.
      framesDiscarded: ended.framesDiscarded + ctx.discards,
      framesContentDrifted: ended.framesContentDrifted + ctx.contentDrifts,
      progress: ctx.completed ? markComplete(advanced) : advanced,
    };
  });
  await emit(deps, next, { kind: 'step-end', outcome, note, status: next.status });
  // The session is over one way or another; nothing should stay loaded on its behalf.
  if (next.status !== 'running') void deps.releaseHost();

  // A page event that arrived while this step was running was refused rather than
  // dropped. Serve it now: it is the same request the loop advances on, only it turned
  // up a few milliseconds early. Fire and forget, exactly as PERCEIVE does.
  if (next.status === 'running' && next.pendingPerceive) {
    void runStep(deps, 'deferred');
    return outcome;
  }

  // A transient failure that left the session running is its own event: the page did not
  // send one, because nothing on the page went wrong. Taking the step again immediately
  // is not a timer (invariant 7) and it is not unbounded -- `stuckReason` at the top of
  // `runStep` ends the run once the failures stop being occasional.
  if (next.status === 'running' && outcome === 'failed' && retryable) {
    void runStep(deps, 'retry');
  }
  return outcome;
}

/**
 * Substitute identifiers in the goal, using the same allocator the page findings use --
 * so an Aadhaar number typed into the task box and the same number found on the page
 * get the same token.
 *
 * What this covers is what L1 covers: checksummed identifiers and the labelled cases.
 * A name is L2's job and L2 is not implemented, which is why the popup lists the
 * classes rather than claiming the goal is clean.
 */
export async function placeholderGoal(
  sessionId: string,
  goal: string,
  intents: Intent[] = [],
): Promise<{ goal: string; intents: Intent[] }> {
  // Two sources, one allocator, one round trip.
  //
  // `scanText` finds identifiers by their shape -- an Aadhaar number looks like one
  // wherever it appears. It cannot find "leo", which has no shape at all, and until the
  // goal was parsed nothing could: a name typed into the task box was not tokenised, and
  // went to the planner in clear text beside a screenshot carefully arranged to hide
  // exactly that.
  //
  // The intent supplies what the shape cannot. A value going into a field the user called
  // "first name" is a person's name because of the sentence, not because of the string.
  const found = scanText(goal);
  const named = intents.filter(
    (intent) => intent.value !== undefined && intent.cls !== undefined,
  );
  if (found.length === 0 && named.length === 0) return { goal, intents };

  const items = [
    ...found.map((match, i) => ({ id: `goal-${i}`, cls: match.cls, value: match.text })),
    ...named.map((intent, i) => ({
      id: `intent-${i}`,
      cls: intent.cls as PlaceholderClass,
      value: intent.value as string,
    })),
  ].map((item) => ({ ...item, fromUser: true }));

  const reply = await send('PLACEHOLDER_ALLOCATE', { sessionId, items }, { to: 'offscreen' });

  const tokens = new Map(
    found.map((match, i) => [match.text, reply.placeholders[`goal-${i}`]]),
  );

  // The token replaces the value in the intent as well as in the sentence, so the action
  // Tier 0 emits carries a placeholder and the executor rehydrates it locally -- the same
  // path a planner-emitted \u00abEMAIL_1\u00bb takes, and the raw value never leaves the device.
  const placeholdered = intents.map((intent) => {
    const at = named.indexOf(intent);
    // The intent's own class first, then whatever the goal-level scan already minted for
    // this exact string. The second is what catches a shaped identifier under a field name
    // the class table does not know: "DL Number 10001000193" and "apply with x@y.in" both
    // name no class, and both carry something the scanner recognises on sight.
    const token =
      (at === -1 ? undefined : reply.placeholders[`intent-${at}`]) ??
      (intent.value === undefined ? undefined : tokens.get(intent.value));
    if (!token || intent.value === undefined) return intent;
    tokens.set(intent.value, token);

    // The token replaces the value rather than joining it.
    //
    // `AgentState` is persisted to session storage, and an intent that kept both was
    // carrying the raw address next to the placeholder that exists to stand in for it --
    // the substitution done everywhere except the one record that outlives the step.
    // Nothing needs it: `actionFor` reads `valueRef ?? value`, and the executor rehydrates
    // the token locally at the moment of typing.
    const { value: _raw, ...rest } = intent;
    return { ...rest, valueRef: token };
  });

  return {
    goal: placeholderText(goal, (cls, value) => tokens.get(value) ?? `\u00ab${cls}\u00bb`).text,
    intents: placeholdered,
  };
}

/**
 * Mask any identifier in a run of unparsed text, by class.
 *
 * Residue is a slice of the goal *as the user typed it*, taken before `placeholderGoal`
 * ran. Everything else on the state record is post-allocator, so storing residue raw would
 * quietly put an Aadhaar number back into session storage -- and into the step note, and
 * onto the panel -- immediately after the sentence containing it had been sanitised.
 *
 * By class rather than by numbered token, because residue is by definition text nobody will
 * act on: there is nothing to rehydrate it *for*, and allocating a token would add an entry
 * to the session map that no action can ever name. «AADHAAR» says everything the operator
 * needs in order to recognise their own sentence.
 */
export function maskResidue(text: string): string {
  return placeholderText(text, (cls) => `\u00ab${cls}\u00bb`).text;
}

/** The same, for the strings carried inside a block. */
export function maskBlock(block: GoalBlock | undefined): GoalBlock | undefined {
  if (!block) return undefined;
  switch (block.kind) {
    case 'residue':
      return { ...block, residue: block.residue.map(maskResidue) };
    case 'unparsed':
      return { ...block, clause: maskResidue(block.clause) };
    case 'ambiguous':
      // Readings are field names the alias table recognised, so they are not values. The
      // clause they came from is the user's own text and is masked like any other.
      return { ...block, clause: maskResidue(block.clause) };
    case 'negation':
      // A word from a fixed list. There is nothing in it to mask.
      return block;
  }
}

/** Best-effort progress to the popup. A closed popup is the normal case, not an error. */
async function emit(
  deps: RouterDeps,
  state: AgentState,
  partial: Omit<StepEvent, 'sessionId' | 'stepIndex' | 'at'>,
): Promise<void> {
  const event: StepEvent = {
    sessionId: state.sessionId ?? '',
    stepIndex: state.stepIndex,
    at: deps.now(),
    ...partial,
  };
  await notify('STEP_EVENT', event, { to: 'popup' });
}

/**
 * Assemble the outbound request.
 *
 * Elements become wire Elements here and nowhere earlier -- toWire is the one-way door,
 * and it is applied after allocation so the substituted text is what crosses. An
 * element with no placeholder for its value has its value masked rather than sent: the
 * planner needs to know a field is filled, not what fills it.
 */
export function buildRequest(state: AgentState, ctx: StepContext): StepRequest {
  const placeholders = ctx.placeholders ?? new Map<string, string>();
  const elementOf = ctx.elementOf ?? new Map<string, number>();
  const byElement = new Map<number, string>();
  for (const finding of ctx.findings ?? []) {
    const token = placeholders.get(finding.id);
    const index = elementOf.get(finding.id);
    if (token !== undefined && index !== undefined) byElement.set(index, token);
  }

  const elements = (ctx.elements ?? []).map((el) => {
    const token = el.index === undefined ? undefined : byElement.get(el.index);
    // `filled` says the field has something in it; `value` says what, when a token
    // exists for it. A field that is filled with something nobody tokenised is filled
    // with no value -- which is exactly the case the planner must not touch.
    return toWire(el, { name: el.name, value: token });
  });

  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: requireSession(state),
    stepIndex: state.stepIndex,
    goal: state.goal,
    // Tokens only: the verb and the field name the user typed, never the value.
    intents: state.intents.map((intent) => ({
      verb: intent.verb,
      target: intent.target,
      ...(intent.valueRef ? { valueRef: intent.valueRef } : {}),
    })),
    origin: ctx.origin ?? '',
    title: ctx.title ?? '',
    viewport: ctx.geometry?.viewport ?? { w: 1, h: 1 },
    capture: {
      mime: (ctx.capture?.mime ?? 'image/webp') as 'image/webp' | 'image/png' | 'image/jpeg',
      width: ctx.capture?.width ?? 1,
      height: ctx.capture?.height ?? 1,
      scale: ctx.capture?.scale ?? 1,
      sha256: ctx.capture?.sha256 ?? '',
    },
    elements,
    manifest: ctx.manifest as import('../shared/contract').Manifest,
    history: historyFrom(state),
    // What the device thinks the task is made of, so a planner asked to replan can see
    // which legs have already been tried and how they failed. See contract.ts.
    plan: state.progress.plan,
  };
}

function historyFrom(state: AgentState): HistoryEntry[] {
  return state.log
    .filter((entry) => entry.outcome !== undefined && entry.note !== undefined)
    .slice(-4)
    .map((entry) => ({
      stepIndex: entry.stepIndex,
      action: entry.note ?? 'step',
      outcome: entry.outcome === 'ok' ? ('ok' as const) : ('failed' as const),
    }));
}

function requireSession(state: AgentState): string {
  if (!state.sessionId) throw new Error('router: no active session');
  return state.sessionId;
}

function requireTab(state: AgentState): number {
  if (state.tabId === null) throw new Error('router: session has no tab');
  return state.tabId;
}

/**
 * Is this run going in circles, and if so what should be said about it?
 *
 * Returns the ending, or undefined to carry on. Kept as a pure function beside `runStep`
 * so the thresholds are read in one place rather than inlined into the loop.
 */
function stuckReason(
  state: AgentState,
): { status: LoopStatus; outcome: StepOutcome; note: string } | undefined {
  if (state.progress.retries >= MAX_STEP_RETRIES) {
    return {
      status: 'failed',
      outcome: 'failed',
      note: `stopped after ${MAX_STEP_RETRIES} steps in a row that failed`,
    };
  }
  if (state.progress.stalled >= MAX_STALLED_STEPS) {
    return {
      // Not `failed`: every one of those steps ran cleanly. The run did not finish, which
      // is exactly what `incomplete` was added to be able to say.
      status: 'incomplete',
      outcome: 'incomplete',
      note: `stopped after ${MAX_STALLED_STEPS} steps that verified nothing new`,
    };
  }
  return undefined;
}

/**
 * Answer a `select` leg on the device, when the page printed enough to answer it.
 *
 * Returns true when the step is settled here -- a click on the candidate the goal's own
 * words support -- and false to carry on down the tier ladder.
 *
 * This is Tier 0's argument applied to a different question. "Find the cheapest one under
 * 30,000" is arithmetic over numbers already on screen; doing it here means no screenshot,
 * no gate, no POST, and the numbers on a results page never leave the machine. What makes
 * it safe is that it refuses easily: three of the five verdicts are refusals, and each of
 * them falls through to a model that can see the picture rather than guessing.
 */
function chooseCandidate(state: AgentState, ctx: StepContext): boolean {
  const evaluation = evaluate({
    candidates: findCandidates(ctx.elements ?? []),
    // Re-derived from the goal rather than persisted: the goal is on the record already,
    // and a second copy of the same limits is a second thing that can go stale.
    constraints: extractConstraints(state.goal),
    preference: preferenceIn(state.goal),
  });

  // Counts and enum names. The candidates' own text is not written anywhere.
  ctx.tierNote = joinNote(ctx.tierNote, describeEvaluation(evaluation));

  const best = evaluation.best;
  if (evaluation.verdict !== 'choose' || !best) {
    // A refusal is a reason to escalate, not a reason to stop. The note says which of the
    // three refusals it was, so an operator can tell "the page did not say" from "nothing
    // qualified".
    ctx.escalation = joinNote(ctx.escalation, `candidates: ${evaluation.verdict}`);
    return false;
  }

  ctx.tier = 0;
  ctx.answeredLocally = true;
  // Named after the leg, not after the stage. `select-1` completes when the ledger holds
  // verified work matching its criterion's hint, and a decision called "the candidate the
  // goal describes" matches no hint anyone wrote.
  ctx.decisions = [
    {
      target: ctx.subgoalHint || ctx.subgoal || 'the candidate the goal describes',
      index: best.index,
      score: 10,
      gap: 10,
    },
  ];
  ctx.plan = {
    protocolVersion: PROTOCOL_VERSION,
    stepIndex: state.stepIndex,
    rationale: 'chose a candidate from the numbers on the page',
    actions: [{ type: 'click', index: best.index }],
    plan: [],
    // The plan's legs decide when the task is over, not this one step.
    done: false,
  };
  if (ctx.trace) ctx.trace.tier = { tier: 0, decisions: ctx.decisions };
  return true;
}
