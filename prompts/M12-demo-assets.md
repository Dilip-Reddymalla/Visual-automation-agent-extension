# Prompt M12 — Demo assets and the rehearsal

> Depends on: everything. Owner: Eval + lead. Estimate: ~22 h.
> Build the two pages in **week one** — M3, M5 and M9 all test against them. Build the
> script and rehearse in week three.

---

Read `CLAUDE.md`. You are implementing M12: the demonstration. A generic "book me a flight"
demo makes the privacy filter look like overhead. This task is chosen so that every
redaction the judges see is obviously load-bearing.

## The task

Two tabs, both static HTML in `demo/`, both working with no internet.

**`demo/page-a-enrolment.html`** — a scanned enrolment document. A photograph of a person, a
name, a date of birth, and an Aadhaar number — all **rendered as image pixels, not text**, so
only OCR can find them. Use a generated placeholder photo and a synthetic Aadhaar number that
passes Verhoeff. This page exists to prove L3 is doing real work.

**`demo/page-b-application.html`** — a multi-section application form containing:

- a name field, pre-filled
- an Aadhaar field, pre-filled (so the planner must _skip_ it, proving the manifest works)
- an empty email field
- a password field
- an uploaded-photo preview showing a face
- a validation error that appears on submit
- **one deliberately awkward element**: a custom dropdown built from `div`s with
  `role="combobox"`, so the interactivity heuristics have something to prove

The user's instruction: _"Finish this application using my enrolment document."_

The agent must read PII it may not transmit, plan around fields whose contents it cannot see,
and type values the server never received. Every one of the five metrics has something to
point at.

## The eight-minute script (`demo/SCRIPT.md`)

| Min  | Beat           | On screen                                                                                                                                  |
| ---- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 0:00 | The problem    | Both pages side by side. Name the data that must not leave the machine.                                                                    |
| 1:00 | Architecture   | One diagram, one sentence: perceived locally, one redacted artefact crosses, the manifest explains it.                                     |
| 2:00 | Perception     | Overlay on, indices over the real page. Show the element list.                                                                             |
| 3:00 | The gate       | Side-by-side panel. Hover a manifest row to highlight its box.                                                                             |
| 4:30 | The round trip | Latency waterfall for one step. Point at the text-only fast path.                                                                          |
| 5:30 | Rehydration    | Planner emits `«EMAIL_1»`; the device types the real address. Say it plainly: _the server directed a keystroke of data it has never seen._ |
| 6:30 | Numbers        | The metrics report. Five rows, five targets, five measured values.                                                                         |
| 7:30 | Offline claim  | `docker compose`, open weights, licences. **Unplug the network** and complete one more step against the LAN server.                        |

Write, for each beat, the exact sentence being said and the recovery path if it fails. A beat
with no recovery path is a beat that will fail.

## Deliverables

- `README.md` — one-command setup for extension, server and harness. Test it by having a
  teammate reach a working demo on a clean machine, unaided. If they need to ask a question,
  the README is wrong.
- The architecture diagram, as an SVG in the repo.
- An eight-slide deck: problem, architecture, the gate, rehydration, the five metrics, the
  licence/offline story, what we would build next, team.
- A **three-minute recorded video** of a complete run, no cuts, audible narration. This is
  your insurance against a venue failure.
- `demo/OFFLINE-CHECKLIST.md` — models pre-pulled, server on a team laptop over LAN or
  hotspot, static pages loaded from `file://`, video on a USB stick.

## Rehearsal — this is a real task, not a formality

Run the demonstration **five times**:

1. Normal.
2. With the network unplugged (LAN server only).
3. On a cold machine — first run, models not yet warm.
4. In Firefox.
5. With one deliberate failure injected, to practise the recovery sentence.

Freeze the code before rehearsal three. Everything after the freeze is bug-fixing only.

## Acceptance criteria

1. Both demo pages work from `file://` with no network.
2. The Aadhaar number on page A is findable only via OCR — grepping the HTML source returns
   nothing.
3. The agent skips the pre-filled Aadhaar field and fills the empty email field.
4. The custom div dropdown is operated correctly.
5. The full flow completes in Chrome and in Firefox.
6. Five rehearsals completed, with the recovery path known for each beat.
7. A teammate reaches a working demo from the README alone.

## Do not

- Do not use real personal data anywhere in the demo, including in the scanned image.
- Do not depend on a live website. One flaky page and the demonstration is over.
- Do not add features after the freeze. Every team that does this breaks a working demo two
  days before the deadline.

Commit as `M12: demo assets and script`.
