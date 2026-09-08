# Prompt M1 — Extension shell and message bus

> Depends on: 00-bootstrap. Owner: Platform. Estimate: ~11 h.

---

Read `CLAUDE.md`. You are implementing M1, the extension shell: the packaging, the popup,
and the typed message bus that every other module in this project communicates through.

## What to build

**`src/shared/messages.ts`** — finish the bus. A discriminated union over `type`, each
variant carrying its own payload and response type. A `send<T>(msg): Promise<T>` wrapper
that attaches a request id, resolves the matching response, and rejects on timeout (5 s
default, configurable per message type — inference messages need 30 s). A `handle(type, fn)`
registration helper used by the worker and the offscreen host.

Message types you will need across the project — define them all now so later modules do not
each invent their own:

```
PERCEIVE            content → worker     request a full perception cycle
DOM_SNAPSHOT        worker  → content    walk the DOM, return the element list
CAPTURE             worker  → content    captureVisibleTab, return an ImageBitmap
INFER               worker  → offscreen  { task, input } → typed result
HOST_STATS          worker  → offscreen  backend, resident bytes, timings
SEAL_AND_ENCODE     worker  → offscreen  findings + bitmap → { blob, receipt }
EXECUTE             worker  → content    run a validated action list
OVERLAY_TOGGLE      popup   → content    show/hide the debug overlay
RUN_TASK / STOP     popup   → worker     start and halt the agent loop
STEP_EVENT          worker  → popup      progress, timings, errors
```

**`src/worker/router.ts`** — the service worker. It routes messages, owns the agent loop
state machine, and holds no user data, no model and no page access. Keep it deliberately
thin; it is a router with one safety check (the receipt verification, added in M6).

**`src/ui/popup/`** — task input, run and stop, a live step log showing per-step status and
timing, and the overlay toggle. State survives closing and reopening the popup (persist to
`chrome.storage.session`).

## Constraints

- Never call `chrome.runtime.sendMessage` with an untyped object anywhere in the project.
  If a later module needs a new message, it is added to the union here first.
- The worker must survive termination. MV3 kills idle service workers; any state that must
  outlive a step goes in `chrome.storage.session`, not a module-level variable.
- `ImageBitmap` is transferable. When passing frames between contexts, transfer it — never
  serialise to base64 or a pixel array. A base64 round-trip of a 1024 px frame costs
  ~40 ms and a megabyte of heap for nothing.
- No polling loops anywhere. Everything is event-driven.

## Acceptance criteria

1. A round trip from popup → content script → popup resolves a typed promise, in both
   Chrome and Firefox.
2. Killing the service worker mid-task (via `chrome://serviceworker-internals`) and sending
   a new message restores state and continues.
3. The popup shows a step log that persists across close/reopen.
4. `npm run lint` and `npm test` pass.

## Do not

- Do not add a UI framework. Plain TypeScript and CSS; the popup is four controls.
- Do not implement perception, capture or inference here — those are M3, M4 and M2. Stub
  their message handlers to throw.
- Do not widen `host_permissions` beyond localhost and file URLs yet.

Commit as `M1: extension shell and message bus`.
