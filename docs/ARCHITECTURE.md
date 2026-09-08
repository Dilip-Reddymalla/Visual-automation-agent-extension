# Where things run

SIH26171 — Redaction Gate. This document is the authoritative answer to "where does that
happen", derived by reading the code rather than the design notes. Where the two disagree,
the code wins and the disagreement is recorded at the bottom.

The reason this file exists: "the local model" has been used in this project to mean two
different processes running two different models for two different purposes, and the
ambiguity has cost real time. **C** and **D** below are both on the user's laptop, both run a
model, and have nothing else in common.

---

## The five places

|       | Where            | Process                                                 | What runs there                                                                         | Model                                |
| ----- | ---------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------ |
| **A** | Inside the page  | content script                                          | DOM walk, interactivity, occlusion, overlay, executor, settle watch, field re-read      | none                                 |
| **B** | Extension worker | MV3 service worker                                      | L0 structural, L1 lexical, the grammar, tier choice, resolver, receipt check, transport | none                                 |
| **C** | Inference host   | offscreen document (Chrome) / background page (Firefox) | L2 NER, L3 face, L3 OCR, the placeholder allocator, the redaction gate                  | bundled ONNX                         |
| **D** | Ollama           | separate OS process, same laptop                        | Tier 1: tie-break, and reading a sentence the grammar cannot                            | `qwen3:0.6b` / `qwen2.5:1.5b`        |
| **E** | Planner          | another machine                                         | Tier 2 planning                                                                         | `Qwen/Qwen3-VL-4B-Instruct` via vLLM |

**C is not D.** C is inside the browser, holds the bundled weights, owns the allocator and
is the only place `convertToBlob` may be called (invariant 1). D is outside the browser, is
reached over loopback HTTP at `localhost:11434`, holds no bundled weights, and answers
exactly one question with exactly one integer.

Two consequences that follow only from that distinction:

- **C is never optional.** If it is missing, no placeholder can be allocated and no token can
  be resolved, so nothing can be typed. D is entirely optional — `local.ts` treats "Ollama
  is not running" as a normal outcome and falls through.
- **D may see raw values; E may not.** D is a process on the user's own machine, so the
  sentence goes to it as typed. That is not a relaxation of the privacy rule, it is the rule:
  what matters is the device boundary, and D is inside it.

---

## The ladder, tier by tier

### Tier 0 — the device answers

The grammar in `worker/intent.ts` reads the sentence, `worker/resolve.ts` scores every
element against it, and if one field wins clear of the runner-up by `CLEAR_MARGIN` the step
is a plan already.

**The survey.** `perceive` is viewport-bound, because what leaves the machine is a
photograph of the visual viewport and a box outside it cannot be redacted in that frame.
The same list is what the resolver scores against, so until M16 the agent could only act on
fields that happened to be on screen: the identical instruction on the identical page
succeeded or escalated depending on the scrollbar. When a sentence parses and its field
scores `below-floor`, the worker now asks A for a `SURVEY` — every control in the document,
values stripped — scores it with the _same_ resolver, asks for the winner to be `REVEAL`ed
by `scrollIntoView`, and perceives again. The viewport rule is unchanged; every action still
comes from a real in-viewport walk with a real index, and the survey's own indices never
leave `worker/reveal.ts`. Bounded at `REVEAL_ATTEMPTS` scrolls per step.

| Runs                               | Does not run                   |
| ---------------------------------- | ------------------------------ |
| A — DOM walk, then the executor    | — no screenshot is taken       |
| B — grammar, resolver, tier choice | — no detection pass            |
| C — allocator only (see below)     | — no gate, no seal, no receipt |
|                                    | C's **models** — L2, L3        |
|                                    | D, E                           |

Nothing is posted. Nothing is encoded. The `capture`, `detect`, `seal` and `plan` phases all
begin with the same early return, and the step reaches `execute` having never built a
request.

**Reading `as` both ways.** "Enter Asha Menon as full name" names the value then the field;
"select state as telangana" names the field then the value. A pattern must commit to one,
and whichever it commits to is wrong half the time. Three things settle it, in order: the
alias table, when it recognises exactly one half; the _page_, when `chooseTier` finds that
the other reading resolves and the first does not — which needs no vocabulary and so works
on a site nobody has seen; and Tier 1, when both halves name a real field and the question
is genuinely a judgement.

**Reading a sentence with no verb.** "date of birth 24/06/2000", "DL Number 10001000193",
"subject as Write Something" — a field name and a value with nothing between them is the
commonest shorthand anybody types, and none of the five patterns has a verb to match. Read
_after_ every pattern has declined, so an explicit verb always wins, and on two kinds of
evidence: the alias table recognising the opening words, or a value-shaped tail (a number, a
date, an email) ending a verbless clause, whose head is then what it goes into. The second
needs no vocabulary, which is what makes it work on a site nobody has seen. Buttons are
excluded as openers — "apply with x@y.in" is a thing to click and an address, not a field.

**Shaping the value to the field.** `content/format.ts`, applied to every `type` from every
tier. A field states its own format in its placeholder, its title, `type="date"` or
`pattern`, and "DOB is 24th jan 2000" reached the right box on the real parivahan form and
left it empty because nothing read that statement. Dates are the case with real variance and
are handled; everything else is trimmed and passed through. Deterministic, because a parser
has no opinion about which of 06/07 is the month — it reads the order off the field, and
when the field does not say, it does not guess.

**Choosing an option.** `findOption` matches by value, then by text, then by a unique
containment, then by nearest — with a floor and a margin, the same discipline the resolver
uses for elements. "andra pradesh" reaches "Andhra Pradesh"; "pradesh", equally true of five
options, reaches nothing.

### Tier 1 — a model on the same laptop

Reached when the resolver finds two plausible fields or none above the floor. D is handed the
user's sentence and a numbered shortlist of candidate elements, and must answer with one
integer inside a JSON schema. A free-text plan is not accepted — the schema is enforced by
the request, not requested in the prompt, because a 0.6B model asked for a number replies
with a sentence containing a number often enough to matter.

| Runs                                     | Does not run                        |
| ---------------------------------------- | ----------------------------------- |
| A, B, C-allocator, as Tier 0             | — still no screenshot, gate or POST |
| D — one integer, or one small typed plan | C's models; E                       |

**Its second job, added after M16.** When the grammar reads _nothing_ (`open-ended`), or
reads something that resolves to nothing on the page (`below-floor`, after the survey has
also failed to find it), D is asked the whole question instead: here is the sentence, here
are the fields, what should happen? The answer is still a small typed object — a list of at
most four `{index, text}` — and it is checked before anything is typed. See
`worker/verify-plan.ts`; the checks are not a formality.

Measured against a real Ollama (`scripts/bench-reader.py`, eight sentences the grammar
cannot read):

| model          | right | partial | escalated | wrong | per call |
| -------------- | ----- | ------- | --------- | ----- | -------- |
| `qwen3:0.6b`   | 1     | 3       | 4         | 1     | 6.8s     |
| `qwen2.5:1.5b` | 3     | 2       | 4         | 0     | 5.4s     |
| `qwen3:4b`     | 5     | 0       | 3         | 1     | 20.4s    |

The reply names its verb — `{index, action: "type" | "click", text}` — rather than
overloading an empty `text` to mean click. That convention reads fine to a person and a 1.5B
does not hold it: asked to fill a name field it answered "click the textbox", which the
guard refused for a reason that was really a prompt defect. Naming the verb took
`qwen2.5:1.5b` from 2/8 to 3/8.

The shortlist the model is shown is ordered by role, not by position. Built by truncation it
was the page's navigation — on the w3schools form the fields are at index 60 and up, so the
model was shown fifty links and asked which to type a name into.

`qwen3:0.6b` stays the tie-break model — picking one of four labelled options is within it.
The reader defaults to `qwen2.5:1.5b`, and the reason is the `wrong` column rather than the
`right` one: the 4B is more capable and produced the one plan that passed every guard and
should not have. On this job the biggest model available is not the safest.

`partial` is a real outcome, not a rounding of failure: the guard drops the actions it
cannot vouch for, the rest run, and `complete.ts` ends the session `incomplete` naming what
was missed. A truthful half-result beats an all-or-nothing refusal that leaves the page
untouched and the step dead at a planner.

A retry — the model told exactly what the guard had refused — was built, measured and
removed. `qwen2.5:1.5b` went from 3/8 to 2/8 and from 3.6s to 10.3s a call: it does not use
the correction, it re-rolls, and one re-roll turned a correct answer into an invented
surname. The model that needs a second chance is the model that cannot use one.

Still nothing sealed and nothing posted. In the step log this reads `tier 1 · nothing sent`,
which is a _stronger_ claim than `tier 0` and used to be displayed as the weaker one.

**D refuses browser extensions by default, and this was invisible.** Ollama's CORS allowlist
contains no `chrome-extension://` origin, so every Tier 1 call from the service worker came
back **403** — and every one was logged as "tier 1 declined", which reads as a model that
considered the question. The rung had never run in a real browser. The failure is now named
(`worker/local.ts`, `LocalFailure`) and shown in the panel. To actually enable Tier 1:

```
OLLAMA_ORIGINS=chrome-extension://* ollama serve
```

The one honest caveat: the request to D is an HTTP request, to `127.0.0.1`. It does not leave
the machine, and there is no remote host involved, but "no network call was made" would be
imprecise and "nothing left the device" is what is actually true.

### Tier 2 — the remote planner

Reached when the sentence is open-ended, when the resolver cannot decide and D declined or
was unreachable, or when the sentence itself is blocked (see _Refusals_). This is the only
tier on which a frame exists.

| Runs                                                 | Does not run                  |
| ---------------------------------------------------- | ----------------------------- |
| A — walk, capture, then execute                      |                               |
| B — L0, L1, receipt verification, POST               |                               |
| C — L2 NER, L3 face, L3 OCR, allocator, **the gate** |                               |
| E — the plan                                         | D, once B has decided to send |

Order within the step: `perceive` → `capture` → `detect` → `seal` → `plan` → `execute` →
`settle`. The gate sits between `detect` and `plan` and is the one-way door: `seal()` records
a receipt against the canvas, `encode()` refuses a canvas without one, and B independently
re-checks the receipt hash against the manifest before posting.

### Why C and the gate are on the Tier 2 path

Because they exist to make an outbound artefact safe, and on Tier 0 and Tier 1 there is no
outbound artefact. Detection is not a policy about what the agent may look at; it is a policy
about what may cross the boundary. When nothing crosses, there is nothing to redact, and a
screenshot taken in order to be thrown away would make the privacy claim slightly less true
for no benefit at all.

**The exception, which is real: the allocator.** It lives in C and it runs on every path,
including Tier 0. It has to. The moment a user types "fill first name with leo" the value
`leo` needs a token — because `«PERSON_1»` is what the action carries, what the step log
holds, and what the panel displays — and the allocator is the only thing that mints one.
`router.ts` calls `ensureHost()` inside `RUN_TASK`, before a tier has been chosen at all.

So the accurate sentence is: **C's models and the gate run only on the Tier 2 path; C's
allocator runs on every path.** See _Disagreements_ below.

---

## What E never receives

Enforced in `buildRequest` and `toWire`, and asserted by a sweep in `router.test.ts` that
greps every outbound surface for a rehydrated value.

- **Any value.** Element values are replaced by placeholders, or masked outright when no
  placeholder exists — the planner is told a field is filled, not what fills it.
- **The raw frame.** Only the sealed bytes, which are the gate's own output. The pre-gate
  frame exists in C's memory for one tick and in the panel's memory while it is open, and
  is never encoded anywhere else.
- **The vault.** `worker/vault.ts` is keyed by origin plus class and has one release path,
  `VAULT_FILL`, which is operator-initiated and passes the value from the vault straight to
  the content script. It never passes through a plan.
- **`«SECRET_*»`.** A SECRET finding is unnumbered by policy, so no token stands for one and
  a plan cannot name one. `content/executor.ts` refuses any `type` whose text matches
  `«SECRET»` or `«SECRET_n»` _before_ it looks the element up.
- **The user's raw sentence.** The goal goes through `placeholderGoal` before the session
  starts, so what reaches E is the tokenised sentence — the same treatment the page gets.

---

## Refusals and escalations

A fact about the _sentence_, decided once in B when the task starts, and checked before a
single element is scored. `worker/intent.ts` produces a `GoalBlock`; `chooseTier` reads it
first.

| Block       | Cause                                                                                                                  | Tier 0 may act        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `negation`  | any of `not`, `don't`, `never`, `without`, `except`, `unless`, `avoid`, `skip`, `instead of`, `rather than`, `but not` | no — refused outright |
| `unparsed`  | a clause no rule read, in a goal where some clause did                                                                 | no                    |
| `ambiguous` | a clause reading two ways, both naming known fields                                                                    | no                    |
| `residue`   | text left over inside a clause that did parse                                                                          | no                    |

The residue rule is **zero**, not a threshold. A goal in which no clause parsed at all is not
blocked — it is open-ended, which is the ordinary case for real work and belongs to E.

Blocked goals go to Tier 2 and skip Tier 1 entirely, because D answers "which index" and a
blocked goal has no candidate list: what failed was comprehension, not resolution.

---

## The completion check

`worker/complete.ts`, run from the `settle` phase, and it is the only thing in the pipeline
that describes the page rather than the agent's intentions. Before a session may end with
"done":

1. Every value-bearing action is verified by **re-reading the element** through
   `VERIFY_FILLED`, in A, after the batch. A successful keystroke is not a filled field.
2. Rehydration and comparison both happen in A. Only a verdict from a closed vocabulary
   (`match`, `differs`, `empty`, `missing`, `unresolved`) crosses back to B.
3. Any intent with no verdict at all counts as never attempted.
4. Residue counts as outstanding unless the goal was actually sent to E, which is the only
   tier that can read the words the grammar could not.

Otherwise the session ends `incomplete`, naming what was not done. Failing to check counts as
not fulfilled: "I could not tell" is not "it worked".

---

## Document intake — NOT BUILT

Sketched here so that when M19 arrives nobody proposes training a model for it. Every part
below already exists; what is missing is the composition, not the capability.

1. **OCR the document region** (C, L3). Opaque regions only — never the whole screenshot.
2. **Run L1 and L2 over the recovered text** (B and C). L1 finds Aadhaar, PAN, IFSC, GSTIN
   and account numbers by shape _and checksum_: Verhoeff for Aadhaar, the PAN and GSTIN
   check characters. A checksum is what makes "this is an Aadhaar number" a fact rather than
   a guess about a twelve-digit string. L2 finds the names and addresses that have no shape.
3. **Offer to store what was found** in the local vault (B), keyed by origin plus class, on
   an explicit confirm. Nothing is stored silently and nothing is stored remotely.
4. **Score class against field** with the M13 resolver (B). The resolver already answers
   "which element does this intent mean"; filling a form from a stored document is the same
   question with the intent coming from the vault instead of from a sentence.
5. **Confirm on a narrow gap.** The resolver reports its margin. A wide margin fills; a
   narrow one asks. This is the same `CLEAR_MARGIN` that governs Tier 0.

No model is trained. No document classifier is needed: the checksums classify, the field
names disambiguate, and the operator confirms.

---

## Disagreements found while deriving this

Recorded rather than smoothed over, per the instruction to derive from the code.

1. **"C and the gate run only on the Tier 2 path" is half true.** C's _models_ and the gate
   do. C's _allocator_ runs on every path, including Tier 0, and must — `RUN_TASK` calls
   `ensureHost()` before any tier is chosen, because the user's own typed value needs a
   token before the first action can be built. Stated correctly above.

2. **Blocked goals escalate to Tier 2, not Tier 1.** M16 asked for residue to escalate to
   Tier 1. Tier 1 as built answers one question — "which of these candidate elements?" — and
   is deliberately held to returning a single integer. A blocked goal has no candidate list,
   because what failed was reading the sentence rather than finding the field, so there is
   nothing to ask it and no shape for an answer. Blocked goals go to the tier that can read
   free text.

3. **Tier 1 makes an HTTP request.** To `127.0.0.1:11434`, which does not leave the machine.
   `sent` is false for a Tier 1 step, which is correct for the claim it is making — nothing
   crossed the device boundary — but "no network call" would be the wrong words for it.

4. **`subject as Write Something` is recorded as `unparsed`, not `ambiguous`.** M16 §4
   presents it as the `as` case. In the code it never reaches the ambiguity check: the clause
   has no verb, so no pattern matches it at all. The ambiguity rule fires on sentences like
   `enter subject as message`, where a pattern _does_ match and both readings name a known
   field. Both escalate; the recorded reasons differ, and the corpus asserts the real one.
