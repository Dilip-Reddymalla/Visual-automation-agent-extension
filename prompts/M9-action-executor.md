# Prompt M9 — Action executor and the secret vault

> Depends on: M3, M7. Owner: Perception + Privacy. Estimate: ~14 h.

---

Read `CLAUDE.md`. You are implementing M9: executing a validated plan against the live page,
and the rehydration mechanism that lets the agent type data the server never received.

## The action vocabulary — nine operations, and resist growing it

```
click(index) | type(index, text, clear) | select(index, value)
scroll(dy | to_index) | key(combo) | navigate(url) | wait(ms)
extract(index?) -> text | done(summary, success)
```

A small typed vocabulary is what makes a 7B open-weights model reliable. Every operation you
add costs accuracy on the ones you already had.

## Index staleness — build this before the handlers

Every action carries the index version it was planned against. If the page has changed since,
**reject the action and re-perceive** rather than clicking blind. A rejected action costs a
second; a wrong click costs the demo. Return a structured result — `ok | stale | not-found |
blocked | error` — which becomes `last_action` on the next request.

## Rehydration — the project's best idea, in about fifteen lines

The planner emits `«EMAIL_1»`. The content script looks it up in the map that never left the
device, and types the real address. **The server directed a keystroke of data it has never
seen.** Put this on a slide.

Guards, both mandatory:

1. `«SECRET_*»` never resolves from a plan. It resolves only from the local vault, after an
   explicit user confirm.
2. A placeholder the planner invents that is not in the session map is **rejected**, never
   typed literally. Return `error` with the offending token.

## The secret vault

`chrome.storage.local`, keyed by origin and field class. Filling a secret requires a visible
confirm — a small in-page dialog naming the field and the origin, not a silent write. A
password must never appear in any payload, any trace line, or any log statement. Add a test
that greps a full session's trace output for the vault's test fixture value and fails if it
appears anywhere.

## Dispatching input the way frameworks expect

Setting `element.value` directly does **not** trigger React's `onChange`. Getting this wrong
makes every form in the demo silently reject its input, and it will look like the agent is
broken rather than the executor.

```ts
const proto =
  el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text);
el.dispatchEvent(new InputEvent('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
```

For `select`, set `value` then dispatch `change`. For custom div-based dropdowns — demo page
B has one deliberately — click to open, wait for mutation-settle, re-perceive, then click the
option by index. Do not try to shortcut this; it is the case that proves the perception layer
works.

## Per-action sequence

1. Resolve the index to a live handle. Reject if the version is stale.
2. `scrollIntoView({ block: 'center' })`, then await scroll settle.
3. Focus, act, dispatch events.
4. Await mutation-settle (the debounced observer from M4).
5. Return the structured result.

## Acceptance criteria

1. The full demo flow executes end to end without manual intervention, **five times
   consecutively**.
2. One run with a field pre-filled: the agent skips it rather than re-typing.
3. One run where a validation error appears: the agent reads it and corrects.
4. Typing into a React-controlled input updates component state, verified in the demo page.
5. The custom div dropdown on demo page B is operated correctly.
6. An action against a stale index is rejected and triggers a re-perceive, logged as `stale`.
7. An invented placeholder is rejected, not typed literally.
8. The vault fixture value appears nowhere in a full session's trace.

## Do not

- Do not add a "click by coordinate" fallback until visual-only elements genuinely need it,
  and then restrict it to elements with no index.
- Do not retry a failed action in the executor. Report the result and let the planner decide.
- Do not log rehydrated values. Log the placeholder.

Commit as `M9: action executor and vault`.
