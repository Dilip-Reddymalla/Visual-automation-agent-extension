# Prompt M4 — Screen capture and the coordinate contract

> Depends on: M1, M2. Owner: Perception. Estimate: ~8 h.
> Small module, outsized consequences. Every misaligned redaction box traces back here.

---

Read `CLAUDE.md`. You are implementing M4: getting pixels, cheaply, in a coordinate space
every other module agrees on.

## What to build

**`src/content/capture.ts`**

1. Capture with `chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 92 })`.
2. Convert to an `ImageBitmap`, and immediately downscale to **1024 px on the long edge** on
   an `OffscreenCanvas`. Everything downstream works on the downscaled buffer.
3. **Close the full-resolution bitmap in the same tick.** Holding it is ~100 MB of heap for
   nothing, and the resource metric is 20% of the evaluation.
4. Return `{ bitmap, scale }` where `scale` converts CSS-pixel boxes to image-pixel boxes.
   Transfer the bitmap; never serialise it.

**Rate limiting.** `captureVisibleTab` permits roughly two calls per second and rejects
beyond that. Enforce a 500 ms minimum interval with a coalescing queue: a burst of ten
mutation events must produce one capture, not eight rejected promises and two frames.

**Trigger policy.** Capture on events only — action completion, DOM mutation-settle after
250 ms of quiet, navigation, or an explicit user command. Never on a timer. Implement the
mutation-settle detector here as a `MutationObserver` with a debounce, exported for M9 to
await after each action.

## The coordinate contract — write this down and enforce it

One space: **CSS pixels of the visual viewport, origin at top-left.** Every `Box`, every
`Finding`, every action coordinate is in that space. Exactly one `scale` converts to image
space, at encode time, using the helpers already in `shared/coords.ts`.

Document it in a comment block at the top of `coords.ts` and reference that comment from
`capture.ts`. If any module needs device pixels or page-relative coordinates, it converts at
its own boundary and converts back — the shared space never changes.

## The bug this module exists to prevent

On a high-DPI display, `captureVisibleTab` returns a frame at `devicePixelRatio` scale while
`getBoundingClientRect` returns CSS pixels. If those are mixed, redaction boxes drift by the
DPR factor and the black bar lands _next to_ the Aadhaar number instead of on it. You will
not notice this on a 1× laptop screen, and it silently forfeits the 20% redaction metric.

Write the alignment test before you write the capture code:

## Acceptance criteria

1. **Alignment test**: draw a box at a known element's CSS rect onto the captured frame; the
   box covers that element exactly, verified by pixel sampling at the four corners. Must
   pass on a 1× display, a 2× display, and at 80%, 100% and 150% browser zoom.
2. A burst of ten mutation events produces exactly one capture, with no rejected promises.
3. The full-resolution bitmap is closed — assert `bitmap.width === 0` after close in a test.
4. Peak heap during a capture cycle stays under 60 MB above baseline.
5. Capture-to-bitmap completes in under 80 ms on the demo laptop.

## Do not

- Do not add a `setInterval` capture loop, even temporarily for debugging. Idle cost is
  measured.
- Do not base64-encode the frame to pass it between contexts. Transfer the `ImageBitmap`.
- Do not capture at full resolution "in case we need it later". We do not.

Commit as `M4: capture and coordinate contract`.
