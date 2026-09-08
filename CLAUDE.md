# SIH26171 — Redaction Gate

A privacy-preserving browser agent. All visual perception happens on the user's machine.
Exactly one artefact crosses the network per agent step: a screenshot and an element list
that have already passed through a one-way redaction gate, plus a manifest telling the
server what was removed and why.

Problem statement: SIH26171, ISRO / Department of Space — "On-device Visual Perception for
Light-weight Browser Agents."

---

## Non-negotiable invariants

These are the design. Breaking one silently loses marks or breaks the privacy claim. If a
change would violate one, stop and say so instead of working around it.

1. **The gate.** `extension/src/redaction/gate.ts` is the ONLY module permitted to call
   `toBlob`, `toDataURL` or `convertToBlob`. An eslint `no-restricted-syntax` rule enforces
   this and a build test greps the output bundle. `encode()` throws if the canvas carries no
   receipt. The service worker independently refuses a payload whose receipt hash does not
   match its manifest.

   One narrowing, added in M2 and pending the team's ratification: `onnxruntime-web`
   ships an unused `Tensor.toDataURL` helper, so the bundle grep can no longer be
   absolute. First-party code is unchanged -- any encoder under `extension/src/**`
   outside gate.ts still fails the build. Vendor code is allowed only for the exact
   `(module, identifier)` pairs pinned in `VENDOR_ALLOW` in `scripts/test-gate.mjs`,
   which is itself unit-tested. A new vendor encoder fails the build.

2. **One coordinate space.** CSS pixels of the visual viewport, origin at top-left. Every
   `Box`, every `Finding`, every action coordinate is in that space. Exactly one scale factor
   converts to image space, and it lives in `shared/coords.ts`. Never mix device pixels, CSS
   pixels and image pixels — that is how redaction boxes land next to the Aadhaar number
   instead of on it.

3. **Licences: MIT and Apache-2.0 only.** ISRO requires offline deployability. Never add an
   AGPL dependency. Specifically: do not use Ultralytics YOLOv8 weights or the OmniParser v2
   icon detector.

4. **No remote models.** `env.allowRemoteModels = false`. All ONNX weights are bundled in
   `extension/models/` and loaded via `chrome.runtime.getURL`. The extension must make zero
   network requests other than the single sanitized POST.

5. **The placeholder vocabulary is frozen.** `PERSON, ADDRESS, EMAIL, PHONE, DOB, AADHAAR,
PAN, GSTIN, IFSC, UPI, ACCOUNT, CARD, PASSPORT, LICENCE, ORG, SECRET, FACE`. Numbering is
   per-class, per-session, stable across steps. Do not add classes without updating
   `shared/placeholders.ts`, the server system prompt and the eval harness together.
   `FACE` is the one class with no text behind it -- it names a region of pixels, so
   `allocate` refuses it and it can never be resolved back into something typeable.

6. **Secrets never rehydrate from a plan.** `«SECRET_*»` resolves only from the local vault
   after an explicit user confirm. A placeholder the planner invents that is not in the
   session map is rejected, never typed literally.

   As built (M9): a SECRET finding is unnumbered by policy, so no token stands for one and
   a plan cannot name one; `content/executor.ts` refuses any `type` whose text matches
   `«SECRET»` or `«SECRET_n»` _before_ it looks the element up. The vault
   (`worker/vault.ts`) is keyed by origin plus class, and its single release path,
   `VAULT_FILL`, is operator-initiated and passes the value straight from the vault to the
   content script -- never to the caller, the log, the trace or the planner.

7. **No polling.** Capture and perception run on events only: action completion, DOM
   mutation-settle after 250 ms of quiet, navigation, or a user command. Idle CPU must be
   ~0%. Client resource utilisation is 20% of the evaluation.

8. **Inference never runs in the service worker.** Neither WebGPU nor the ORT WASM backend
   exists there. All model work happens in the offscreen document (Chrome) or the background
   event page (Firefox), behind the `InferenceHost` interface.

9. **DOM-first, pixels-second.** The DOM is authoritative for element identity, role, label,
   box and state. The vision models run only where the DOM is silent: canvas, video,
   cross-origin iframes, text baked into images, faces, and post-action verification. Never
   OCR the whole screenshot.

---

## Architecture — four processes, one boundary

```
DEVICE                                                   │  SERVER
                                                         │
content script ──┐                                       │
  DOM snapshot   │                                       │
  captureVisible │                                       │
  executes acts  │                                       │
                 ▼                                       │
        offscreen document (WebGPU inference host)       │
          L0 structural │ L1 lexical │ L2 NER │ L3 vision │
                 │                                       │
                 ▼                                       │
        ██ REDACTION GATE ██  seal() → receipt → encode() │
                 │                                       │
                 ▼                                       │
        service worker (router; verifies receipt) ───────┼──▶ planner (open-weights VLM)
                 ▲                                       │      returns typed actions
                 └───────────────────────────────────────┼──── referencing indices and
                        actions, rehydrated locally      │      placeholders
```

---

## Repository layout

```
extension/
  manifest.chrome.json      MV3, offscreen permission, wasm-unsafe-eval CSP
  manifest.firefox.json     background.scripts, gecko id
  build.mjs                 esbuild, two targets, copies models/
  src/
    content/                walker.ts interactivity.ts occlusion.ts perceive.ts
                            serialize.ts overlay.ts capture.ts executor.ts settle.ts
                            fixture.ts  ◀── jsdom scaffolding for the pipeline tests
    offscreen/              host.ts sessions.ts timings.ts smoke.ts handlers.ts
                            frames.ts  ◀── decode and downscale; the only place a
                            full-resolution frame exists, and only for one tick
                            runtime-ort.ts  ◀── the only importer of onnxruntime-web
                            adapters/{chrome,firefox}.ts tasks/{ner,ocr,face}.ts
    redaction/              findings.ts l0-structural.ts l1-lexical.ts validators.ts
                            policy.ts merge.ts gate.ts   ◀── guarded
    testing/                fake-canvas.ts  ◀── test doubles only, in no bundle
    worker/                 main.ts router.ts loop.ts state.ts capture.ts detect.ts
                            goal.ts transport.ts receipt.ts trace.ts
                            index.ts / index.firefox.ts ◀── per-target entries, so
                            Chrome's service worker never bundles ORT
    platform/               chrome-bus.ts session-store.ts offscreen.ts
                            frame-store.ts  ◀── sealed bytes, offscreen to worker
                            ◀── the only browser-API layer
    ui/                     popup/ hud/ sidebyside/
    shared/                 contract.ts placeholders.ts coords.ts messages.ts
                            agent.ts frames.ts store.ts observed.ts
  models/                   bundled .onnx + tokenizers
server/
  app.py planner.py schema.json docker-compose.yml
eval/
  corpus/ label_tool/ harness.py report/
demo/
  page-a-enrolment.html page-b-application.html
```

---

## Conventions

- TypeScript strict. No `any`. No non-null assertions except where a DOM API guarantees it.
- Every cross-context call goes through the typed bus in `shared/messages.ts` — a
  discriminated union with a request-id envelope. Never call `chrome.runtime.sendMessage`
  with an untyped object.
- `chrome.*` APIs live in `platform/`, `offscreen/adapters/` and the four entry points
  (`worker/index.ts`, `content/index.ts`, `offscreen/index.ts`, `ui/popup/index.ts`).
  Everything else — `shared/`, `redaction/`, `offscreen/tasks/`, the worker's loop and
  state — must be testable in Node with no browser globals. Lint and a boundary test
  enforce this for `shared/`, `redaction/` and `offscreen/tasks/`.
- Two element types, and the difference is the privacy argument. `ObservedElement`
  (`shared/observed.ts`) is what the walker saw -- raw values, autocomplete tokens, the
  `name` attribute, `-webkit-text-security` -- and it never leaves the device. The wire
  `Element` (`shared/contract.ts`) is what the planner sees. `toWire()` is the one-way
  door, applied after M5 detects and M6 substitutes, never before.
- A frame is bound to the boxes it was measured against. Perceive and capture are two
  messages with a gap between them; the page can scroll or reflow inside it, and every
  box is then wrong relative to the frame. `CaptureGeometry` carries a `GeometryToken`,
  the worker re-reads it after the capture, and a frame whose page moved is discarded
  rather than redacted at coordinates that have moved. Two failures running end the step
  as "page would not hold still". `framesDiscarded` is a metric, not something to hide.
- Sealed bytes reach the worker through IndexedDB, not the bus and not the reply
  (`platform/frame-store.ts`). The POST stays in the worker because `worker/receipt.ts`
  verifies the bytes in a different process from the gate that made them; moving the
  send into the offscreen document would make that check the gate's opinion of itself.
- Pixels never travel on the bus. An ImageBitmap is not serialisable through
  `runtime.sendMessage` and must never be base64'd to get around that; contexts exchange
  a `FrameRef` handle and fetch the bytes. See `shared/frames.ts`.
- The worker keeps nothing in a module variable. MV3 terminates it while idle, so
  everything that must outlive a step is one record in `chrome.storage.session`
  (`worker/state.ts`), read on every wake.
- **The worker persists no user data.** Not "holds none" -- raw text does transit it:
  ObservedElements on their way from the content script to L0, and INFER payloads on
  their way to the NER model. It routes them and forgets them. Nothing raw may be
  written to `chrome.storage.session` or to `worker/trace.ts`; state and traces carry
  placeholders, indices and counts only. `worker/router.test.ts` holds a regression
  test for this.
- Model code never talks to ORT directly. It goes through the `OrtRuntime` interface in
  `offscreen/host.ts`, which is why the host, the session registry and the timing ring
  all run under Vitest with no browser, no GPU and no weights. `runtime-ort.ts` is the
  one file that imports `onnxruntime-web`.
- Nothing loads at startup and nothing stays loaded. Sessions are acquired on demand,
  refcounted, and unloaded 60 idle seconds later; when the last one goes, so does the
  timer. A stopped session closes the offscreen document outright.
- Zod types in `shared/contract.ts` are the single source of truth for the wire format.
  `server/schema.json` is generated from them at build time; the server loads that file for
  guided decoding. Changing one without the other must fail the build.
- Vitest for unit tests, Playwright for the eval harness. Tests colocated as `*.test.ts`.
- Commit messages: `M<n>: <what changed>`. One module per branch, merged daily to `main`.

## Commands

```bash
npm run build            # dist/chrome
npm run build:firefox    # dist/firefox
npm run lint             # includes the gate rule
npm test                 # vitest
npm run test:gate        # greps the built bundle for illegal encoders
python eval/harness.py   # writes eval/report/report.json

python scripts/make-smoke-model.py   # regenerates models/smoke.onnx + its fixture
python -m http.server 8080 --directory demo   # the demo pages; file:// is not supported
```

The backend probe is the first thing to run on a machine nobody has tried: open the
popup and press **Check**. It reports the backend, whether the GPU has `shader-f16`,
the WASM thread count, the output tensor shape and whether the values are right.

---

## What the evaluation actually rewards

| Metric                           | Weight | Owned by                                      |
| -------------------------------- | ------ | --------------------------------------------- |
| Accuracy of visual context       | 25%    | M3 perception, M4 capture, L3 fusion          |
| PII detection recall & precision | 20%    | M5 detection layers                           |
| Precision of redaction           | 20%    | M6 gate and the per-class policy              |
| Client resource utilisation      | 20%    | M2 session lifecycle, quantisation, idle cost |
| End-to-end latency               | 15%    | M2 gating, M7 fast path, M8 server            |

Over-redaction is a first-class failure, not a safe default. Blacking out half the page
loses the 25% visual-context metric while gaining nothing on the 20% redaction metric,
which measures IoU _and_ over-redaction rate.

The manifest carries both numbers and they mean different things. `redactedFraction` is
painted area over viewport area -- how much of the page the planner cannot see, which can
legitimately be large on a dense form. `overRedactedFraction` is painted area covering
nothing anyone detected, over total painted area -- which is padding and merging running
wild, and is the one that says the gate is being careless. Never report one as though it
were the other.

---

## Mistakes that have already cost teams this project

- Setting `element.value` directly. React does not see it. Use the prototype's native value
  setter, then dispatch a bubbling `InputEvent`.
- Regex without checksums. A twelve-digit invoice number is not an Aadhaar. Verhoeff for
  Aadhaar, Luhn for cards — always.
- OCR-ing the full screenshot to "be thorough". It costs 500 ms to re-derive text the DOM
  already gave you.
- Loading every model at startup. Lazy-load L2 and L3; unload after 60 idle seconds.
- Building the eval corpus in the last week. It is 65% of the marks and it must exist by
  day 14.
