/**
 * The typed bus. Every cross-context call in this project goes through here and
 * nothing else (CLAUDE.md, conventions). Nothing anywhere calls
 * `chrome.runtime.sendMessage` with an untyped object; a module that needs a new
 * message adds it to `Protocol` below first, and every context picks up the types.
 *
 * This module stays free of `chrome.*` so redaction and model code can be unit tested
 * in plain Node. Each context installs a transport at startup --
 * `setBusTransport(createChromeTransport('worker'), 'worker')` -- and everything above
 * that line just calls `send()`.
 *
 * Frames never travel on this bus. See shared/frames.ts for why, and for what does.
 */

import type { Action, Box, Finding, Manifest, Viewport } from './contract';
import type { StepEvent } from './agent';
import type { CaptureGeometry, FrameRef, GeometryToken } from './frames';
import type { ObservedElement } from './observed';
import type { PlaceholderClass } from './placeholders';

/** The four processes in the architecture diagram, plus the popup. */
/**
 * Who can be addressed on the bus.
 *
 * 'panel' is the side-by-side page. It is its own context rather than borrowing the
 * popup's because it is the only one that holds a pre-gate frame, and a message
 * addressed to a surface that must never persist anything should say so by name.
 */
export type Context = 'worker' | 'content' | 'offscreen' | 'popup' | 'panel';

export interface NerSpan {
  start: number;
  end: number;
  cls: PlaceholderClass;
  score: number;
}

export interface OcrLine {
  text: string;
  box: Box;
  score: number;
}

/** Why the content script thinks a new perception cycle is warranted. */
export type PerceiveReason = 'settle' | 'navigation' | 'action-complete' | 'user';

export type InferRequest =
  | { task: 'ner'; sessionId: string; texts: string[] }
  | { task: 'ocr'; sessionId: string; frame: FrameRef; regions: Box[]; viewport?: Viewport }
  /**
   * The viewport is not decoration. Boxes come back in CSS pixels of the visual viewport
   * like every other box in this project (CLAUDE.md invariant 2), and the only way to get
   * there from model space is the frame's own scale -- which is image width over viewport
   * width. Without it the handler would have to guess, and a guessed scale is a blur in
   * the wrong place that looks like the feature working.
   */
  | { task: 'face'; sessionId: string; frame: FrameRef; viewport: Viewport };

export type InferResult =
  | { task: 'ner'; spans: NerSpan[][] }
  | { task: 'ocr'; lines: OcrLine[] }
  | { task: 'face'; boxes: Box[]; scores: number[] };

export type InferTask = InferRequest['task'] | 'ocrDet' | 'ocrRec';

export interface HostStats {
  /** 'none' is the honest answer before anything has been loaded. */
  backend: 'webgpu' | 'wasm' | 'none';
  /** Resident model bytes, for the HUD and the 20% resource metric. */
  residentBytes: number;
  loaded: InferTask[];
  /** Last run duration per task, milliseconds. The ring buffer behind it is M10's. */
  timings: Partial<Record<InferTask, number>>;
  /** Where those bytes went. Absent tasks are not resident. */
  residentByTask?: Partial<Record<InferTask, number>>;
  /** WASM thread count actually in use, once a backend has been chosen. */
  threads?: number;
}

/**
 * What the backend probe found. The gating question for this whole project is whether
 * the first line says 'webgpu' on the demo machines.
 */
export interface SelfTestResult {
  backend: 'webgpu' | 'wasm';
  f16: boolean;
  threads: number;
  limits: Record<string, number>;
  /** Output tensor shape of the forward pass. */
  dims: number[];
  ms: number;
  /** The pass produced the values the model was generated with, not just a shape. */
  matchedFixture: boolean;
  note?: string;
}

export interface ExecutionOutcome {
  outcome: 'ok' | 'failed' | 'no-op';
  note?: string;
}

/**
 * Why an action did not run. Each of these is a different fault with a different owner,
 * and collapsing any two of them loses the thing worth knowing.
 */
export type RejectionReason =
  /** The page moved on since the plan was made. Ours; the step ends and we look again. */
  | 'stale-snapshot'
  /** No element at that index in the current walk. The planner's, and only this action. */
  | 'unknown-index'
  /** The placeholder map is gone. Ours; the step ends -- offscreen/allocator.ts. */
  | 'session-lost'
  /** The planner invented a token. Theirs; this action alone is refused. */
  | 'unknown-placeholder'
  /** A secret was wanted and the user did not confirm it. Neither party's fault. */
  | 'secret-declined';

/**
 * Request and response for every message type. This *is* the protocol; the
 * discriminated union below is derived from it.
 *
 * The direction in each comment is documentation. The envelope's `to` does the routing.
 */
export interface Protocol {
  /** content -> worker. The page changed; consider running a step. */
  PERCEIVE: {
    req: { reason: PerceiveReason };
    res: { accepted: boolean; stepIndex: number };
  };

  /**
   * worker -> content. Walk the DOM and return the element list.
   *
   * These are ObservedElements -- raw, unredacted, device-only. They travel content ->
   * worker -> offscreen so that L0 can sniff the attributes that say "this field holds
   * an Aadhaar number", and they become wire Elements only after M6 has substituted
   * placeholders. The worker routes them; it must never persist them (CLAUDE.md,
   * invariant on the worker).
   */
  DOM_SNAPSHOT: {
    req: { sessionId: string };
    res: {
      elements: ObservedElement[];
      viewport: Viewport;
      origin: string;
      title: string;
      /**
       * Which walk produced these indices. Carried back on EXECUTE so an action built
       * against a page that has since moved on is rejected rather than applied to
       * whatever now happens to sit at that index.
       *
       * Not a counter. See the note in content/index.ts: a counter resets with the
       * content script, so it cannot tell two documents apart.
       */
      snapshotId: string;
    };
  };

  /**
   * worker -> content. Geometry only -- viewport, scale, scroll offsets. A content
   * script cannot call chrome.tabs.captureVisibleTab, so the worker takes the picture
   * itself and forwards the ref; what it cannot see is the visual viewport, which is
   * what this asks for. M4.
   */
  CAPTURE: {
    req: { sessionId: string };
    res: CaptureGeometry;
  };

  /**
   * worker -> content. Re-read the page's position after a capture. A frame whose
   * token no longer matches the one the boxes were measured against is thrown away:
   * redacting at coordinates the page has moved out from under is worse than not
   * redacting, because it looks like it worked.
   */
  GEOMETRY_CHECK: {
    req: { token: GeometryToken };
    res: { valid: boolean; current: GeometryToken };
  };

  /** worker -> offscreen. The only path to a model. M2. */
  INFER: { req: InferRequest; res: InferResult };

  /** worker -> offscreen. Backend, resident bytes, timings. */
  HOST_STATS: { req: Record<string, never>; res: HostStats };

  /**
   * worker -> offscreen. Redact, then encode.
   *
   * The bytes do not come back in this reply. They cannot: the bus is JSON, so a Blob
   * would have to be base64'd, and that is exactly what shared/frames.ts forbids. The
   * offscreen document writes them to IndexedDB under `handoffKey` and the worker takes
   * them from there -- structured clone, byte-identical, no new permission. See
   * platform/frame-store.ts for why that path and not the other one.
   *
   * What does come back is the manifest, including the receipt, which the worker
   * verifies against the bytes it fetched. Two independent halves of invariant 1.
   */
  SEAL_AND_ENCODE: {
    req: {
      sessionId: string;
      stepIndex: number;
      frame: FrameRef;
      findings: Finding[];
      viewport: Viewport;
      scale: number;
      /**
       * Element indices to draw on the sealed frame (Set-of-Mark).
       *
       * Index and box only. The number drawn has to be the same integer the element list
       * carries, so it is passed from the walk rather than recomputed here -- two sources
       * for one number is how the picture and the list end up disagreeing.
       */
      marks?: Array<{ index: number; box: Box }>;
      /**
       * finding id -> placeholder, from the allocation the detect phase already did.
       *
       * Tokens, not values: allocating twice in one step would hand out two numbers for
       * one person, and the stability of «PERSON_1» across steps is the property the
       * planner is told it can rely on.
       */
      placeholders: Record<string, string>;
      /**
       * finding id -> whether its box is an element rect or one drawn tight around
       * glyphs. The gate pads the two differently; see redaction/policy.ts.
       */
      boxKinds: Record<string, 'element' | 'text'>;
    };
    res: {
      /** Where the sealed bytes are waiting. platform/frame-store.ts, frameKey(). */
      handoffKey: string;
      manifest: Manifest;
      capture: { mime: string; width: number; height: number; scale: number; sha256: string };
      /** Placeholder per finding id, so the worker can substitute into the element list. */
      placeholders: Record<string, string>;
    };
  };

  /**
   * worker -> offscreen. Turn detected values into stable placeholders.
   *
   * Detection runs in the worker -- L0 and L1 are node-pure and need no model -- but the
   * map that makes «PERSON_1» the same human on step 9 as on step 2 lives in the
   * offscreen document, because it must not be persisted and must outlive an MV3
   * worker. So the worker sends values and receives tokens.
   */
  PLACEHOLDER_ALLOCATE: {
    req: {
      sessionId: string;
      items: Array<{
        id: string;
        cls: PlaceholderClass;
        value: string;
        /** The value came out of the operator's own sentence. See Finding.origin. */
        fromUser?: boolean;
      }>;
    };
    res: {
      placeholders: Record<string, string>;
      /** Ids whose token stands for a value the operator typed. See Finding.origin. */
      fromUser?: string[];
    };
  };

  /** worker -> content. Run a validated action list. M9. */
  EXECUTE: {
    req: {
      sessionId: string;
      actions: Action[];
      /** The snapshot these indices were chosen against. Rejected if it has moved on. */
      snapshotId: string;
    };
    res: { results: ExecutionOutcome[] };
  };

  /**
   * worker -> content. Put a secret into one field, outside the plan entirely.
   *
   * This is the only path by which a credential reaches a page, and it is deliberately
   * not an Action: the planner has no token for a secret, cannot name one, and the
   * executor refuses any `type` that tries. What triggers this is the operator, in the
   * popup, answering an `ask` -- and the value only ever travels worker -> content.
   */
  /**
   * worker -> content. Every control in the document, on screen or not.
   *
   * Asked only when the sentence was understood and the field it named was not in the
   * viewport. `DOM_SNAPSHOT` is viewport-bound by design -- what leaves the machine is a
   * photograph of the visual viewport, and a box outside it cannot be redacted -- which
   * meant the resolver was scoring the user's words against whatever happened to be on
   * screen. The same instruction on the same page worked or failed depending on the
   * scrollbar.
   *
   * The reply is for *locating* and nothing else. No values, no text runs, no image
   * regions, no occlusion, and the indices in it are local to this list: nothing acts on
   * them. Once the worker knows which control the user meant, it asks for it to be
   * revealed and then perceives the page properly.
   */
  SURVEY: {
    req: { sessionId: string };
    res: {
      elements: ObservedElement[];
      /** How many controls the document holds, before the viewport ever came into it. */
      total: number;
    };
  };

  /**
   * worker -> content. Bring one element into view, by its stable key.
   *
   * By key rather than by index, because the index came from a different walk. Keys are
   * built from tag, role, accessible name and DOM path, so they survive the scroll that
   * changes every box on the page.
   *
   * `scrollIntoView` on the live node rather than `window.scrollTo(y)`: a field inside a
   * scrollable panel, a modal or a nested pane is not reachable by moving the window, and
   * that is not a rare page any more. The browser walks whatever chain of scroll
   * containers the element actually sits in.
   */
  REVEAL: {
    req: { sessionId: string; key: string };
    res: { found: boolean };
  };

  /**
   * worker -> content. Did the value actually land in the field?
   *
   * A successful keystroke is not a filled field. The executor reports `ok` when it wrote a
   * property and dispatched the events a framework listens for; whether the framework then
   * accepted the value, reformatted it, rejected it as invalid or replaced it on re-render
   * is a fact about the page, and the only way to know it is to look at the page.
   *
   * Asked of the content script rather than answered in the worker, for the same reason the
   * executor rehydrates there: the expected text is a placeholder, and turning it back into
   * a value is the one thing that must not happen on this side of the boundary. The content
   * script compares locally and returns a verdict. No value crosses in either direction.
   */
  VERIFY_FILLED: {
    req: {
      sessionId: string;
      snapshotId: string;
      /** `text` is exactly what the action carried: a token, or a literal. */
      checks: Array<{ index: number; text: string }>;
    };
    res: {
      results: Array<{
        index: number;
        fulfilled: boolean;
        /** Machine-readable, and deliberately not the value. See VerifyReason. */
        reason: VerifyReason;
      }>;
    };
  };

  FILL_SECRET: {
    req: { index: number; value: string; snapshotId: string };
    res: { outcome: 'ok' | 'failed'; note?: string };
  };

  /**
   * panel -> offscreen. What the side-by-side panel is shown.
   *
   * The pre-gate frame comes back as a `FrameRef`, which is a URL -- the same URL the
   * capture already produced. Nothing is encoded to put it on the bus, which is what
   * keeps this outside the gate's lint rule rather than around it.
   */
  PANEL_LIST: {
    req: Record<string, never>;
    res: {
      steps: Array<{
        sessionId: string;
        stepIndex: number;
        at: number;
        findings: number;
        /** Findings that were on the page before the agent touched it. The real claim. */
        protected: number;
        /** Findings covering values this extension typed. Redacted, never counted. */
        agentTyped: number;
      }>;
    };
  };
  PANEL_STEP: {
    req: { stepIndex: number };
    res: {
      found: boolean;
      preGate?: FrameRef;
      sentUrl?: string;
      sentMime?: string;
      manifest?: Manifest;
      capture?: { width: number; height: number; scale: number };
    };
  };
  /**
   * worker -> panel. The trace for a step that just ended.
   *
   * The same object that goes to the trace log -- no second timing mechanism, and no
   * second definition of what a stage is. Placeholders and durations only; trace.ts
   * checks that before anything is emitted.
   */
  PANEL_TRACE: { req: { trace: unknown }; res: { ok: true } };

  /** panel -> offscreen. Drop the frames when the panel closes. */
  PANEL_CLEAR: { req: Record<string, never>; res: { dropped: number } };

  /**
   * offscreen -> panel. A step just sealed; here is the pair.
   *
   * Pushed rather than polled because the offscreen document does not outlive the
   * session: the host is released when a session ends, which closes the document and
   * takes its ring with it. The panel's own memory is where these are meant to live
   * anyway -- it is the context that must never persist them and is dropped on close.
   *
   * Sent with `notify`, so a run with no panel open is not an error.
   */
  PANEL_STEP_ADDED: {
    req: {
      sessionId: string;
      stepIndex: number;
      preGate: FrameRef;
      sentUrl: string;
      sentMime: string;
      manifest: Manifest;
      capture: { width: number; height: number; scale: number };
    };
    res: { ok: true };
  };

  /** popup -> content. Show or hide the debug overlay; omit `show` to flip it. */
  OVERLAY_TOGGLE: { req: { show?: boolean }; res: { visible: boolean } };

  /**
   * popup -> worker. The vault: what the operator has stored, per origin and class.
   *
   * Reading is not among these. A secret leaves the vault in exactly one way -- through
   * VAULT_FILL, which asks the operator first and hands the value straight to the page.
   * There is no message that returns one to the caller, so there is nothing to log.
   */
  VAULT_SAVE: {
    req: { origin: string; cls: PlaceholderClass; label: string; value: string };
    res: { saved: true };
  };
  VAULT_FORGET: { req: { origin: string; cls: PlaceholderClass }; res: { forgotten: true } };
  VAULT_LIST: {
    req: Record<string, never>;
    res: { entries: { origin: string; cls: string }[] };
  };

  /**
   * popup -> worker. Release a stored secret into a field, after a visible confirm.
   *
   * Operator-initiated, never plan-initiated. The reply says whether it happened, not
   * what was typed.
   */
  VAULT_FILL: {
    req: { tabId: number; index: number; origin: string; cls: PlaceholderClass };
    res: { outcome: 'ok' | 'failed'; reason?: 'not-stored' | 'declined' | 'failed' };
  };

  /** popup -> worker. Start the agent loop on a tab. */
  RUN_TASK: {
    req: { goal: string; tabId: number };
    res: { sessionId: string; stepIndex: number };
  };

  /** popup -> worker. Halt it. Idempotent. */
  STOP: { req: { sessionId?: string }; res: { stopped: boolean } };

  /**
   * content -> offscreen. Turn a placeholder back into the value it stands for.
   *
   * The map lives in the offscreen document (offscreen/allocator.ts) because that is
   * the only context that is not the worker, does not persist, and can still be
   * messaged. M9's executor asks before typing anything.
   *
   * `reason` distinguishes the two failures that must never be conflated: a planner
   * inventing a token, which is a plan to reject, and our own map having been lost
   * with a suspended host, which is a degradation to report and a step to end.
   */
  PLACEHOLDER_RESOLVE: {
    req: { sessionId: string; placeholder: string };
    res: { value?: string; reason?: 'unknown-placeholder' | 'session-lost' };
  };

  /**
   * anywhere -> offscreen. Drop a model, or all of them. The registry unloads on its
   * own after 60 idle seconds; this is for the hard cases -- the tab closed, the
   * operator stopped, the machine is under memory pressure.
   */
  HOST_UNLOAD: { req: { task: InferTask | 'all' }; res: { freedBytes: number } };

  /**
   * anywhere -> offscreen. One forward pass through the bundled probe model, on
   * whichever backend init chose. This is the acceptance test for M2 and the first
   * thing to run on a machine nobody has tried yet.
   */
  SELF_TEST: { req: Record<string, never>; res: SelfTestResult };

  /**
   * popup -> worker. Which classes the goal box is actually protected against.
   *
   * Asked rather than hard-coded in the popup, because the answer changes when L2
   * lands. A privacy tool that overstates its coverage is worse than one that states it
   * plainly, and "names are not covered yet" is a sentence the operator should read
   * before typing one.
   */
  GOAL_COVERAGE: {
    req: Record<string, never>;
    res: { protected: PlaceholderClass[]; unprotected: PlaceholderClass[] };
  };

  /**
   * popup -> worker. Make sure the inference host exists. Only the worker can create
   * an offscreen document, so anything wanting to talk to the host asks first.
   */
  HOST_ENSURE: { req: Record<string, never>; res: { ready: boolean } };

  /** worker -> popup. Progress, timings, errors. Best-effort: the popup may be closed. */
  STEP_EVENT: { req: StepEvent; res: { ok: true } };
}

/**
 * Why one field did or did not hold what it was asked to hold.
 *
 * A closed vocabulary rather than a sentence, because this crosses from the content script
 * -- which has seen the rehydrated value -- back to the worker, which must not. Every member
 * describes the *shape* of the disagreement and none of them can carry the value itself.
 */
export type VerifyReason =
  /** The field holds exactly what was asked for. */
  | 'match'
  /** The field holds something, and it is not what was asked for. */
  | 'differs'
  /** The field is empty. */
  | 'empty'
  /** The index is not in the current walk -- the page moved on. */
  | 'missing'
  /** The placeholder would not resolve, so there was nothing to compare against. */
  | 'unresolved'
  /** Not a value-bearing action, and it happened. The executor's outcome is the evidence. */
  | 'not-applicable'
  /** Not a value-bearing action, and the page rejected it. */
  | 'not-done';

export type MessageType = keyof Protocol;

/** The discriminated union: one member per Protocol key. */
export type Message = {
  [K in MessageType]: { type: K; payload: Protocol[K]['req'] };
}[MessageType];

export type RequestOf<K extends MessageType> = Protocol[K]['req'];
export type ResponseFor<K extends MessageType> = Protocol[K]['res'];

/** Five seconds is plenty for anything that is not a model or a page. */
export const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Per-type overrides. Inference gets 30 s because a cold model load on the WASM backend
 * legitimately takes that long; everything else staying short is what keeps a wedged
 * step from looking like a hung extension.
 */
export const TIMEOUT_MS: Partial<Record<MessageType, number>> = {
  INFER: 30_000,
  SEAL_AND_ENCODE: 30_000,
  SELF_TEST: 30_000,
  HOST_ENSURE: 10_000,
  SURVEY: 10_000,
  REVEAL: 5_000,
  VERIFY_FILLED: 10_000,
  PLACEHOLDER_RESOLVE: 5_000,
  PLACEHOLDER_ALLOCATE: 5_000,
  HOST_UNLOAD: 10_000,
  DOM_SNAPSHOT: 10_000,
  CAPTURE: 10_000,
  GEOMETRY_CHECK: 5_000,
  EXECUTE: 15_000,
  PANEL_LIST: 5_000,
  PANEL_STEP: 5_000,
  PANEL_CLEAR: 5_000,
  PANEL_STEP_ADDED: 5_000,
  PANEL_TRACE: 5_000,
  FILL_SECRET: 5_000,
  // Long, because a human has to read a sentence and decide. A confirm that times out
  // and defaults to anything is not a confirm.
  VAULT_FILL: 300_000,
};

export function timeoutFor(type: MessageType): number {
  return TIMEOUT_MS[type] ?? DEFAULT_TIMEOUT_MS;
}

/** Every message on the wire is wrapped in this. Nothing is sent bare. */
export interface Envelope<K extends MessageType = MessageType> {
  /** Unique per request; the reply carries the same id. */
  id: string;
  from: Context;
  /** Who should answer. Defaults to the worker, which is the router. */
  to: Context;
  /** Required when `to` is 'content': which tab. */
  tabId?: number;
  sentAt: number;
  type: K;
  payload: Protocol[K]['req'];
}

export type Reply<K extends MessageType = MessageType> =
  | { id: string; ok: true; result: Protocol[K]['res'] }
  | { id: string; ok: false; error: { message: string; stack?: string } };

export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<Envelope>;
  return typeof e.id === 'string' && typeof e.type === 'string' && typeof e.from === 'string';
}

/**
 * What a context plugs in so `send()` has somewhere to go. The chrome-flavoured
 * implementation is platform/chrome-bus.ts.
 */
export interface BusTransport {
  /** Deliver an envelope and resolve with the peer's reply. */
  post(envelope: Envelope): Promise<Reply>;
  /** Register the local handler and return a disposer. */
  listen(handler: (envelope: Envelope) => Promise<Reply>): () => void;
}

export type Handler<K extends MessageType> = (
  payload: Protocol[K]['req'],
  envelope: Envelope<K>,
) => Promise<Protocol[K]['res']> | Protocol[K]['res'];

/** Handlers are stored erased; `handle()` is where the type is checked. */
type StoredHandler = (payload: unknown, envelope: Envelope) => Promise<unknown> | unknown;

let transport: BusTransport | null = null;
let selfContext: Context = 'worker';
let disposeListener: (() => void) | null = null;
let counter = 0;

const handlers = new Map<MessageType, StoredHandler>();

function newId(): string {
  counter += 1;
  const rand =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${selfContext}-${counter}-${rand}`;
}

/**
 * Called once per context at startup, before anything sends. In the worker this runs at
 * the top level of the bundle, never inside an async init -- MV3 restarts the worker on
 * every wake, and a listener registered later is a listener that missed the message
 * that did the waking.
 */
export function setBusTransport(next: BusTransport, context: Context): void {
  disposeListener?.();
  transport = next;
  selfContext = context;
  disposeListener = next.listen(dispatch);
}

export function busContext(): Context {
  return selfContext;
}

/** Tests and teardown. Leaves the bus with no transport installed. */
export function resetBus(): void {
  disposeListener?.();
  disposeListener = null;
  transport = null;
  handlers.clear();
}

/**
 * Register this context's handler for one message type. Used by the worker's router,
 * the content script, the offscreen host and the popup.
 */
export function handle<K extends MessageType>(type: K, handler: Handler<K>): () => void {
  if (handlers.has(type)) {
    throw new Error(`bus: ${type} already has a handler in ${selfContext}`);
  }
  handlers.set(type, handler as unknown as StoredHandler);
  return () => handlers.delete(type);
}

export function isHandled(type: MessageType): boolean {
  return handlers.has(type);
}

/** Route an inbound envelope to the local handler. Errors come back as replies. */
export async function dispatch(envelope: Envelope): Promise<Reply> {
  const handler = handlers.get(envelope.type);
  if (!handler) {
    return {
      id: envelope.id,
      ok: false,
      error: { message: `bus: no handler for ${envelope.type} in ${selfContext}` },
    };
  }
  try {
    const result = await handler(envelope.payload, envelope);
    return { id: envelope.id, ok: true, result } as Reply;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return { id: envelope.id, ok: false, error: { message: e.message, stack: e.stack } };
  }
}

export interface SendOptions {
  /** Defaults to 'worker' -- the router. */
  to?: Context;
  /** Required when `to` is 'content'. */
  tabId?: number;
  /** Milliseconds before the promise rejects. 0 disables. Defaults per message type. */
  timeoutMs?: number;
}

/**
 * The one way to talk to another context. Rejects on transport failure, on a handler
 * throw, and on timeout -- it never resolves with a half-formed result.
 */
export async function send<K extends MessageType>(
  type: K,
  payload: Protocol[K]['req'],
  options: SendOptions = {},
): Promise<ResponseFor<K>> {
  if (!transport) {
    throw new Error(`bus: no transport installed in ${selfContext} (send ${type})`);
  }
  const to = options.to ?? 'worker';
  if (to === 'content' && options.tabId === undefined) {
    throw new Error(`bus: ${type} to content needs a tabId`);
  }

  const envelope: Envelope<K> = {
    id: newId(),
    from: selfContext,
    to,
    tabId: options.tabId,
    sentAt: Date.now(),
    type,
    payload,
  };

  const posted = transport.post(envelope as Envelope);
  const timeoutMs = options.timeoutMs ?? timeoutFor(type);
  const reply = timeoutMs > 0 ? await withTimeout(posted, timeoutMs, type) : await posted;

  if (!reply.ok) {
    const error = new Error(`bus: ${type} failed: ${reply.error.message}`);
    if (reply.error.stack) error.stack = reply.error.stack;
    throw error;
  }
  return reply.result as ResponseFor<K>;
}

/**
 * Fire and forget, for messages whose receiver may legitimately not exist -- a
 * STEP_EVENT to a closed popup is the normal case, not an error. Resolves to whether it
 * landed.
 */
export async function notify<K extends MessageType>(
  type: K,
  payload: Protocol[K]['req'],
  options: SendOptions = {},
): Promise<boolean> {
  try {
    await send(type, payload, options);
    return true;
  } catch {
    return false;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`bus: ${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
