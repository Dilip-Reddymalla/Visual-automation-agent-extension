# Prompt M10 — Operator UI

> Depends on: M2, M6, M7. Owner: Platform + Eval. Estimate: ~19 h.
> The side-by-side panel is the single deliverable that converts your engineering into marks.

---

Read `CLAUDE.md`. You are implementing M10: three surfaces the judges will actually look at.

## 1. The side-by-side panel — build this first

A full extension page (`ui/sidebyside/`), opened from the popup.

- **Left:** the real screen as captured, before the gate.
- **Right:** the exact JPEG that was POSTed, after the gate.
- **Below:** the manifest rows — class, operation, detector (`L0:autocomplete`,
  `L3:face@0.94`), and box coordinates. **Hovering a row highlights its box on the sent
  image**, and dims the others.
- A step selector, so the panel can walk back through the session.

Judges are scoring redaction precision. Hand them the evidence instead of describing it.

One constraint that matters: the left-hand image is the pre-gate frame, which by definition
contains unredacted PII. It must live only in the extension page's memory for the current
session, never be written to storage, never be encoded, and be dropped when the panel closes.
The gate's lint rule already prevents encoding it — do not work around that rule to build a
"save screenshot" button.

## 2. Resource HUD (`ui/hud/`)

Reads `host.stats()` from M2. Displays, live:

- backend in use (`webgpu` / `wasm`) and whether `shader-f16` is available
- GPU adapter limits
- resident model bytes, per task
- JS heap (`performance.memory` where available — Chrome only; show `n/a` in Firefox rather
  than hiding the row)
- CPU while idle and while active
- per-stage timings for the current step

Metric 4 is twenty percent of the rubric and almost nobody instruments it. A live HUD is the
cheapest twenty percent in the project.

## 3. Latency waterfall

Per step, stage by stage — DOM walk, capture, L0/L1, L2, L3, fusion, seal+encode, network,
server, execute — with p50 and p95 accumulating across the run. Reads the ring buffer from
M2 and the trace from M7; do not add a third timing mechanism.

## 4. The counter

Somewhere permanently visible in the popup:

> **Values redacted this session: 47 · Values transmitted: 0**

Plain, unmissable, and true.

## Design constraints

- Plain TypeScript and CSS. No framework, no component library, no build-time CSS tooling.
- Legible in both light and dark — the panel will be projected, possibly badly. Use a real
  token set and test on a projector-like low-contrast display.
- Wide content scrolls inside its own container; the page body never scrolls sideways.
- The HUD updates at most twice a second. A HUD that itself burns CPU while measuring idle
  CPU is an embarrassing bug to explain.

## Acceptance criteria

1. Hovering a manifest row highlights exactly its box on the sent image.
2. The panel walks back through at least ten steps of a session.
3. The pre-gate frame is never persisted and is dropped on panel close — verified by a heap
   snapshot.
4. The HUD shows non-zero resident bytes during a step and zero 60 seconds after.
5. The HUD's own CPU cost is under 1%.
6. The waterfall's stage sum matches the trace's end-to-end figure within 5%.
7. Everything is readable on a projector at 1280×720.

## Do not

- Do not add a screenshot export button of any kind.
- Do not reimplement timing collection. Read M2's buffer.
- Do not hide a metric because it looks bad. A visible, honest 900 MB peak with a plan to
  reduce it reads better than a missing row.

Commit as `M10: operator UI`.
