# Showcase run sheet

Eight pages, in order, each built to force one rung of the tier ladder. Every number in
this file was measured on the pages in this folder; where a run needs a real planner to
finish rather than the eval stub, it says so.

## Before anyone is in the room

```bash
npm run build
```

```bash
python -m http.server 8080 --directory demo
```

Load `dist/chrome` at `chrome://extensions` (Developer mode, then Load unpacked), and open
`http://localhost:8080/`. **Never open these as `file://`** -- the content script does not
run there, on purpose. See `demo/README.md`.

For tier 2 you need a planner listening. Either `server/` with a real VLM
(`docker compose up`), which is what a judge should see; or nothing at all, and say plainly
that the artefact was sealed and the POST refused -- the manifest and the sealed image are
still there to look at in **What was sent**.

Two checks, in this order:

1. Popup, **Check**. It reports the backend, whether the GPU has `shader-f16`, the WASM
   thread count and whether the smoke model's output matches its fixture. If this is red,
   stop and fix it before anything else.
2. Popup, **Resources**. Leave it open on a second screen if you have one: idle CPU should
   sit at 0.00%, which is the claim that there is no polling anywhere.

## The one sentence to open with

> Everything that looks at the page runs on this machine. Exactly one artefact per step can
> cross the network, it has already been through a one-way redaction gate, and the manifest
> beside it lists what was removed and why. Most steps send nothing at all.

## The run

Each card on `http://localhost:8080/` carries the goal to paste. Click the dark box to
select it, paste it into the popup's goal field, press **Run**.

### 1. Pension life certificate -- tier 0

Goal: `fill full name with Asha Menon, fill mobile number with 9845012345, click submit certificate`

Point at the step line: `tier 0 - the device - nothing sent`, then at the per-field scores,
`full name -> [1] score 34 gap 34`. The gap is the number that says whether the device is
deciding or guessing.

Say: no screenshot was taken on this step. Not "a screenshot was taken and not sent" --
none was taken, because nothing was going to be sent, so there is nothing that could leak.

Worth pointing out: the log line reads `typed <<PERSON_1>> into [1]`. The operator's own
sentence is placeholdered before it is written into the step log.

### 2. Mobile number update -- tier 0 with no real labels

Goal: `fill new mobile number with 9845012345`

The captions on this page are `<label>` elements with no `for`, associated with nothing.
The device scores the caption a human would read, which is what the page means even though
it is not what the page says.

### 3. Employer verification -- tier 1, a tie

Goal: `fill email address with asha.menon@example.in`

Two sections, each asking for an email address and a mobile number. Both candidates score
identically. The step line says `tier 1 tie-break picked [1] for "email address" (tie)`.

Say: the interesting half is the refusal. Tier 0 could have picked the first one and been
right half the time; instead it reports a tie and pays for a second opinion -- from a model
that is also on this machine. Still nothing sent.

### 4. Water board -- tier 1, open-ended

Goal: `sign up for outage alerts on this page`

Nothing on the page is a field until a tile is clicked, so the sentence names no control.
The step line says `open-ended`, then `tier 1 read the goal into 1 action`. The Outage
alerts tile opens and the form appears.

### 5. Scanned challan -- tier 2, the gate

Goal: `describe what this challan is asking for`

This is the money shot. Everything printed on the challan lives in a `<canvas>`: no text
node, no label, no value. Open the popup's **What was sent** panel.

Measured on this page: three steps, three sealed POSTs, five findings, every one of them
`L3` -- `ocr:verhoeff-ok` for the Aadhaar, `ocr:pan-structure` for the PAN,
`ocr:in-mobile-series` for the mobile, plus the name and the address from the on-device NER
model. Redacted area is about 1% of the viewport.

Then point at what is **not** painted: `Invoice no. 669436125079`, two lines under the
Aadhaar. It is twelve digits and it passes the Aadhaar checksum. It survives because the
words beside it say what it is -- and on a scan those words are a different OCR box, 70 px
to the left, which the detector has to reason about geometrically.

Say: over-redaction is a first-class failure here, not a safe default. Blacking out half
the page would lose the 25% visual-context metric and gain nothing on the 20% redaction
metric, which measures IoU *and* over-redaction.

### 6. Uploaded enrolment slip -- tier 2, an ordinary upload

Goal: `read the uploaded slip and tell me what it says`

The same argument for an `<img>` with an empty `alt`, which is how a document actually
arrives from an applicant. Name, date of birth, Aadhaar and address are glyphs; all four
are found and painted. The enrolment number directly under the Aadhaar is Verhoeff-valid
and is left alone. Over-redaction on this page is about 7% of what was painted.

### 7. Beneficiary registration -- tier 1 declines, tier 2 answers

Goal: `fill account number with 50100234567`

`Bene. A/c No. (CBS)` scores below the grammar's floor -- the device says "I do not know"
rather than typing into the first box that looks vaguely right. Tier 1 is asked, and its
answer is *rejected*:

> tier 1 refused: the local model put the same text into 4 fields, which is what it does
> instead of saying it does not know

Say: a cheap answer is not accepted merely because it is cheap. That check is the reason
the ladder is safe to have.

### 8. Enrolment to application -- placeholders across a navigation

Goal: `fill full name with Asha Menon, fill aadhaar number with 7237 2429 6561, click verify identity`

The submit navigates to a second page. The same person keeps the same placeholder numbers
across a real document load. `demo/NAVIGATION.md` has the measurement of what an element
index is worth after that load: seven of twelve indices meant something else, five had
vanished -- which is why a plan may not batch actions past a navigation.

## If someone asks

**"How do I know the screenshot was really redacted?"** Open **What was sent**. The image in
that panel is the sealed bytes, not a re-render of the page. The gate
(`extension/src/redaction/gate.ts`) is the only module in the codebase allowed to call an
encoder -- an eslint rule enforces it and `npm run test:gate` greps the built bundle for
violations. The service worker verifies the receipt hash in a different process from the one
that made it, and refuses a payload whose hash does not match its manifest.

**"What happens if the network is down?"** Tiers 0 and 1 are unaffected: they never touch
it. Tier 2 fails the step and says so.

**"Can I see it fail?"** Yes -- that is page 7. Also try any goal on a page that does not
have the field: the step ends `incomplete` with the field named, rather than reporting
success.

**"Is this measured, or is it a demo?"** `python eval/harness.py` scores a 50-page corpus and
writes `eval/report/report.html`; `python eval/scenarios.py` runs six end-to-end scenarios;
`python eval/live.py` runs the same build against real public sites read-only. Latency
numbers on a laptop with no GPU are not the numbers for a GPU box, and the report says which
machine it ran on rather than quoting the flattering half.

## Running any page yourself, headless

```bash
python eval/live.py --url http://localhost:8080/tier-2-pixels.html --task "describe what this challan is asking for"
```

The report lands in `eval/report/live/<page>/` -- every step's screenshot, the traces, the
sealed frame and the step the planner was sent.
