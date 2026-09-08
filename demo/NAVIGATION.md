# What survives a navigation

Measured in Chrome 151 with the extension loaded unpacked, driving the real message bus.
Two claims sit under the planner's system prompt and under M9's design, and neither had
ever been measured. They point in opposite directions, which is why both had to be.

## The claim being tested

The system prompt tells the planner:

> stop at any action whose result you cannot predict — a click that navigates is the last
> action in a batch

That is a rule the model is asked to follow. It is only worth asking if breaking it would
actually hurt, and "actually" means measured.

## 1. Element indices do not survive. They are reused.

Page A, as the planner is told it exists — 12 elements, then a real document load to page
B in the same tab, and the first snapshot after it:

```
  [1] link     Help                  ->  [1] text     Application submitted.
  [2] link     Application status    ->  [2] link     Back to enrolment
  [3] button   Verify identity       ->  [3] textbox  Full name
  [4] textbox  Email address         ->  [4] textbox  Aadhaar number
  [5] text     Email is required     ->  [5] textbox  Email address
```

**Seven of twelve indices now mean a different element. Five vanished.**

The five that vanished are the safe half: a plan referring to `[11]` finds nothing and the
action fails loudly. The seven are the dangerous half. Index `[3]` was a button and is now
a text field. Index `[4]` was the email field and is now the Aadhaar field.

So a planner that emitted, in one batch:

```
click [3]                      # "Verify identity"
type «EMAIL_1» into [4]        # "Email address"
```

and had the first action navigate would, on the second action, click a **name field** and
type an email address into an **Aadhaar field**. No error. No exception. The index is
valid, the element is real, the data is wrong and it is PII in the wrong box.

That is the constraint, and it is not hypothetical: it is what these numbers say happens.

### Why the failure is silent

All seven of page B's elements come back marked `isNew` on the first snapshot after the
load. The content script's `previousKeys` — its diff state — is empty, because the content
script is a **new instance**. A navigation replaces it along with the document, so
`handles` (`content/index.ts:31`) starts empty and is repopulated by numbering page B's
elements from 1.

Nothing in that path can notice. The old indices were never written down anywhere the new
instance can see, so it cannot know that its `[3]` is not the `[3]` the planner is holding.

### What this means for M9's `snapshotId`

M9 adds a monotonic `snapshotId`, bumped in `runPerceive()`, carried on the snapshot and
checked at execute time so a stale plan is rejected as `'stale-snapshot'`.

**A per-instance counter does not survive this.** It lives in the same module scope as
`handles` and resets with it, so page A's snapshot 1 and page B's snapshot 1 are
indistinguishable — precisely across the boundary where indices are most dangerous.

The id has to be unique per _document_, not per content-script instance: a nonce minted
once at script start and combined with the counter. Then a plan built against page A
carries page A's nonce, and page B rejects it.

## 2. The placeholder map does survive. Numbering holds.

The opposite result, and the one the cross-page demo rests on. Before the navigation:

```
  «PERSON_1»   resolves, same value
  «AADHAAR_1»  resolves, same value
```

After it, in the same session, with the tab now on page B — the same tokens still resolve
to the same values, and page B's own identical values re-allocate to:

```
  {'g1': '«PERSON_1»', 'g2': '«AADHAAR_1»'}
```

**Not `PERSON_2`.** The same human keeps the same number across a page load, which is the
one property the planner is told it can rely on.

This works because of where the map lives. `offscreen/allocator.ts` puts it in the
offscreen document, and the offscreen document is not the tab: navigating the tab does not
touch it. `chrome.runtime.getContexts()` reports `OFFSCREEN_DOCUMENT` present on both
sides of the load.

It also depends on exact string equality — `PlaceholderAllocator.allocate` keys its map on
`` `${cls} ${value}` `` with no normalisation. A stray double space in page B's markup
would quietly produce `PERSON_2` and the demo would show nothing. That is now a test
(`scripts/demo-fixtures.test.ts`), for the same reason the checksum drift became one.

## 3. A thing found on the way: host release takes the map

The first attempt at this experiment measured nothing, because the step failed at
`execute` (M9 is not built), the session stopped being `running`, and `router.ts:446`
released the inference host — which closes the offscreen document and takes the
placeholder map with it. By the time the navigation happened there was nothing left to
test.

That is the session-end path working correctly: when a session ends, the values should go.
But it does couple two lifetimes that are not the same thing. The ONNX host is an
_inference_ resource and the placeholder map is a _session_ resource, and they share one
document. Any release while a session is still live — an unexpected status change, a
Firefox background-page suspend — silently drops the map.

The `session-lost` outcome in `allocator.ts` exists for exactly this, and M9 must route
rehydration through it rather than treating a missing map as an unknown placeholder. One
is our state loss and ends the step; the other is the planner inventing a token.

One caveat found and not yet resolved: with the offscreen document absent, a
`PLACEHOLDER_RESOLVE` sent from the popup **hung** rather than rejecting — no reply and no
error. If that reproduces from the worker, M9's rehydration would hang instead of
reporting `session-lost`, and the step would never end. Worth pinning down before M9's
vault work depends on it.

## Reproducing

`scratchpad/nav2.py`, against the demo server on `:8080`, the stub planner on `:8000`, and
Chrome with `--enable-unsafe-extension-debugging` on `:9222`. It drives the offscreen
document directly so the host stays up and navigation is the only variable.
