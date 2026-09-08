# Prompt M3 — DOM perception

> Depends on: M1. Owner: Perception. Estimate: ~27 h.
> Owns the visual-context metric (25% of the evaluation).

---

Read `CLAUDE.md`. You are implementing M3, the agent's primary sense: the indexed element
list. The DOM is authoritative here. A vision model reconstructing this from pixels would be
slower, larger and worse, so this module does the heavy lifting and the vision models fill
gaps later.

The representation is modelled on `browser-use` (github.com/browser-use/browser-use). Port
the _ideas_ — indexed elements, interactivity heuristics, paint-order and containment
filtering, the `*` new-since-last-step marker. Do not port the code; it is a Python CDP
driver running outside the browser, and you are a content script running inside it, which is
a simpler problem with better access to computed style.

## The algorithm, in this order

**1. Traverse** — `document.createTreeWalker` over the document, descending into open shadow
roots and same-origin iframes. Closed shadow roots are unreachable: emit a marker node so
the planner knows something is hidden rather than absent.

**2. Filter for visibility** — reject `display:none`, `visibility:hidden`, opacity below
0.05, zero-area rects, and elements fully outside the viewport. Keep elements carrying
validation-relevant ARIA attributes even when currently hidden; an error message about to
appear matters.

**3. Score interactivity** — an element is interactive if any of:

- tag in `a, button, input, select, textarea, summary, option, label`
- ARIA role in `button, link, checkbox, radio, combobox, textbox, menuitem, tab, switch, slider`
- `tabindex >= 0`, or `contenteditable`
- computed `cursor: pointer`
- an `onclick` attribute, or a framework binding: `@click`, `v-on:click`, `ng-click`, or a
  React fibre props key found by scanning `Object.keys(el)` for `__reactProps$`
- a form-control descendant within two levels under a `label` or `span` wrapper (this is how
  component libraries wrap radios and checkboxes)
- an `iframe` larger than 100×100
- class or id containing a search affordance substring (`search`, `magnify`, `lookup`, `query`)

Skip `label` elements that proxy via `for` — activating them double-fires the real input.

**4. Test occlusion** — `document.elementFromPoint` at the centre and four quarter points of
each candidate. If no probe returns the element or one of its descendants, it is occluded;
drop it. This is what stops the agent clicking a button behind an open modal.

**5. Collapse containment** — when a candidate's rect lies ≥90% inside another candidate's
rect and it carries no distinct accessible name, keep only the outer element. Without this,
one card renders as three or four clickable entries and the list triples in size, which
costs you latency and accuracy simultaneously.

**6. Assign indices** in paint order — top to bottom, then left to right by rect origin — so
numbering reads naturally against the screenshot and stays stable.

**7. Diff** — compute a stable key per element from tag, role, accessible name and a
normalised DOM path. Compare against the previous step's keys; mark newcomers with `*`.

**8. Serialise** to one line per element. Keep a parallel `Map<number, Element>` of live
handles in the content script. **The handle map never leaves the page.**

**9. Overlay** — `src/content/overlay.ts` draws outlines and index badges into a shadow-DOM
host, toggled from the popup. Build this early; it is the fastest way to see that step 3 is
wrong.

## Output format

```
[4]<input type="text" aria-label="Full name" value="«PERSON_1»" />
[5]<input type="text" aria-label="Aadhaar number" value="«AADHAAR_1»" filled />
[6]<input type="email" placeholder="Email address" value="" />
[7]<select aria-label="State" options=36 selected="Karnataka" />
*[8]<div role="alert">Email is required</div>
*[9]<button type="submit">Save and continue</button>
    <img alt="" ocr="«PERSON_1»" redacted="blur" />   // visual-only, no index
```

Values are already placeholder-substituted by the time this is serialised — M5 and M6 own
that; here, just render whatever the value field holds.

## Files

`src/content/walker.ts`, `interactivity.ts`, `occlusion.ts`, `serialize.ts`, `overlay.ts`.
Each independently unit-testable against fixture HTML with jsdom where possible, and against
a real page in Playwright where jsdom's layout model is insufficient (occlusion, cursor).

## Acceptance criteria

1. On the two demo pages plus five real sites of your choosing, ≥92% of hand-listed
   interactive elements appear in the index.
2. Spurious entries stay under 5%.
3. A button behind an open modal does not appear.
4. A card containing a link and a button yields at most two entries, not four.
5. Elements inside an open shadow root appear.
6. The whole walk completes in under 120 ms on the demo laptop.
7. Overlay badges align with their elements at 80%, 100% and 150% browser zoom.
8. Indices are stable across a no-op re-perceive; a newly appeared element is marked `*`.

## Do not

- Do not send the element handle map anywhere. It stays in the content script.
- Do not read pixel data here. That is M4.
- Do not use a vision model to find UI elements. The DOM is better, faster and free.

Commit as `M3: DOM perception`.
