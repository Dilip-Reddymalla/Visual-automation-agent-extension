# The first browser load

Eight modules were built with their browser-dependent acceptance criteria deferred, on the
grounds that no browser was available. This is the session that closed most of them, run
before M9 so the executor is built on a chain that is known to work rather than one that
is believed to.

Chrome 151, extension loaded unpacked, demo page A on `http://localhost:8080`, the stub
planner on `:8000`. Everything below is measured output, not expectation.

## What now works, verified

| Module | Criterion                                                   | Result                                                                  |
| ------ | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| M1     | Bus round trip across contexts                              | popup → worker → content, typed replies                                 |
| M2     | **One forward pass on WebGPU in a real offscreen document** | `webgpu + f16 - 1 thread - 1x8 in 75.1 ms`, values matching the fixture |
| M3     | Perception on a live page                                   | 11 elements, roles and names correct                                    |
| M4     | Capture and the geometry token                              | `scale: 1.25` on a 1.25 dpr display, token fully populated              |
| M5a    | L0 and L1 on real form fields                               | 6 findings: L0 ×4, L1 ×2 (Aadhaar via Verhoeff, PAN via entity code)    |
| M6     | Seal and encode through a real OffscreenCanvas              | 11,886 bytes of WebP, receipt verified                                  |
| M7     | **The IndexedDB bytes handoff**, receipt check, POST        | frame crossed offscreen → worker; server received the step              |
| M7     | The goal is placeholdered                                   | `Apply using Aadhaar «AADHAAR_1» and email «EMAIL_1»`                   |
| M8     | Server round trip                                           | schema-valid plan returned, 173 bytes                                   |

One step, end to end, 506 ms, stopping at `execute` — which is M9's.

```json
{
  "elements": 11,
  "findings": {
    "total": 6,
    "byClass": { "EMAIL": 2, "ADDRESS": 1, "AADHAAR": 1, "PAN": 1, "SECRET": 1 },
    "byLayer": { "L0": 4, "L1": 2 }
  },
  "redaction": {
    "redactedFraction": 0.268,
    "overRedactedFraction": 0.101,
    "ops": 6,
    "kept": 0
  },
  "payload": { "imageBytes": 11886, "requestBytes": 17058, "responseBytes": 173 },
  "plan": { "actions": ["type"], "done": false },
  "totalMs": 506
}
```

### The privacy claims, live

Six needles — the portal PIN, the Aadhaar and PAN on the page, the Aadhaar and email typed
into the goal, and the applicant's name — searched in `chrome.storage.session` and in
everything the worker logged:

```
portal PIN (page)     storage.session=absent   worker-console=absent
Aadhaar (page)        storage.session=absent   worker-console=absent
PAN (page)            storage.session=absent   worker-console=absent
Aadhaar (goal)        storage.session=absent   worker-console=absent
email (goal)          storage.session=absent   worker-console=absent
name (page)           storage.session=absent   worker-console=absent
```

## Three bugs the load found that no test could

**`fetch` unbound throws in a service worker.** `worker/main.ts` passed `globalThis.fetch`
as a bare reference; detached from its global it raises
`Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation`, and every step died
in the plan phase. The transport tests inject a fake fetch, so they could never have caught
it. Fixed by binding.

**The demo page's own fixtures failed their checksums.** Page A shipped with
`234567890123` and `ABCDE1234F` — the right shapes, the wrong checksums — so L1 correctly
ignored both and the first run produced six L0 findings and zero L1. `demo/README.md` had
warned about exactly this in week one and page A was written in violation of it. Values now
come from `eval/corpus/identifiers.json`.

**`captureVisibleTab` is refused without `activeTab`, and host permissions do not
substitute.** With `host_permissions: ["http://localhost/*"]` the capture phase fails:

```
Either the '<all_urls>' or 'activeTab' permission is required.
```

`activeTab` is granted only when the user _invokes_ the extension on that tab — clicking
the toolbar action. It is not granted by a host permission, however specific, and not by a
programmatic `RUN_TASK`.

This is the one finding with a demo-day consequence, and it is worth being exact about it:

- **The intended flow already satisfies it.** The user has the demo tab focused, clicks the
  extension's action to open the popup, and presses Run. The action click is the
  invocation, and `activeTab` follows it.
- **What does not satisfy it** is starting a run any other way — from a detached popup tab,
  from a keyboard shortcut without an action click, or programmatically. That is how this
  session hit it.
- **The alternative is `<all_urls>`**, which is a far broader grant and a much worse answer
  to "what can this extension see?" — the question the whole project exists to answer well.
  M4 deliberately narrowed the permission set by dropping `file:///*`; widening it here
  would give that back and more.

So: keep the narrow permissions, and make sure the demo starts from the action. Before the
demo, verify it in that exact order and do not improvise on the day.

## Two numbers that are not yet good enough

**`overRedactedFraction` was 0.10 against a target of under 0.05. Now 0.016.**

The first measurement came entirely from padding, and the arithmetic said so exactly: 6%
proportional padding on a 380×32 field paints 11px of empty space either side and produces
11.0% over-redaction by itself, against a measured 10.1%.

The model was wrong in kind, not in degree. Padding exists to cover anti-aliased glyph
bleed, which is a fixed couple of pixels — but it was applied as a _fraction of the box_,
so a wide field got eleven pixels of it. And a form field's rect is not drawn tight around
its glyphs in the first place: the site's own CSS padding is already there, eight pixels
and a border on this page, so the value starts eleven pixels inside the box the detector
reports. There is nothing at that edge to bleed.

No uniform padding fixes it — even one absolute pixel a side is 6.4% on that box. The fix
is to split by what kind of box it is: element rects get nothing, rects drawn tight around
glyphs get two pixels, and blur regions get twelve because a face blurred exactly to its
bounding box leaves a recognisable outline. Re-measured on the same page with the same six
findings: **0.101 → 0.016**, and `redactedFraction` fell from 0.268 to 0.245 as well.

**Perception is viewport-only, by design.** The Aadhaar and PAN fields are below the fold on
page A, and the first run did not see them at all — six findings, none from L1. Scrolling to
the Identity fieldset produced the L1 findings above. Correct behaviour, but it means the
demo must scroll before the interesting redaction is visible, and the demo script should say
so rather than discovering it live.

## Reproducing this

Chrome 151 ignores `--load-extension` outright — it was removed as a command-line switch,
and `--disable-features=DisableLoadExtensionCommandLineSwitch` does not bring it back. The
route that works is the CDP `Extensions` domain:

```bash
python -m http.server 8080 --directory demo --bind 127.0.0.1
cd server && PLANNER=stub python -m uvicorn app:app --port 8000

chrome.exe --user-data-dir=/tmp/profile \
  --enable-unsafe-extension-debugging \
  --remote-debugging-port=9222 --remote-allow-origins=* \
  --no-first-run http://localhost:8080/page-a-enrolment.html
```

Then `Extensions.loadUnpacked` over the browser's WebSocket with the path to
`dist/chrome`. Two things that cost time and are worth knowing:

- **Order matters.** Loading the extension orphans any content script already in a tab
  (`Extension context invalidated`). Load first, then reload the page.
- **MV3 kills the worker within about thirty seconds** of idleness. Open the popup to wake
  it before expecting it to answer, which is also what a user does.
- A runtime message sent from the worker **to itself** is never delivered — Chrome fans out
  to every extension context except the sender. Drive `RUN_TASK` from the popup.

## Still open

- `execute` — M9.
- Five consecutive clean runs of the whole flow (M9's criterion 1), which needs the executor.
- Firefox. Nothing here was run under it; the `accepts: ['worker', 'offscreen']` arrangement
  in `platform/chrome-bus.ts` is still unexercised.
- The vLLM path. This session used the stub planner; no GPU was present.
