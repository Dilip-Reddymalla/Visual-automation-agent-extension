# SIH26171 — Redaction Gate

A privacy-preserving browser agent. All visual perception happens on the user's machine.
Exactly one artefact crosses the network per agent step: a screenshot and an element list
that have already passed through a one-way redaction gate, plus a manifest telling the
server what was removed and why.

ISRO / Department of Space — "On-device Visual Perception for Light-weight Browser Agents."

`CLAUDE.md` is the design document: nine invariants, the architecture, and the mistakes
this project has a reason to expect. Read it before changing anything.

---

## Three processes, and all three have to be running

A step fails if any one of them is missing. This is the single most common way a working
build looks broken:

| #   | What                | Where                   | Why it exists                            |
| --- | ------------------- | ----------------------- | ---------------------------------------- |
| 1   | the extension       | loaded in the browser   | perception, detection, the gate          |
| 2   | the demo page       | `http://localhost:8080` | the page the agent drives                |
| 3   | the **planner API** | `http://localhost:8000` | the one network call the extension makes |

The extension POSTs to `http://localhost:8000/v1/step` and nowhere else
(`extension/src/worker/transport.ts`). If nothing is listening there, the step gets as far
as `plan` — doing all the real work first — and then dies. See
[Troubleshooting](#troubleshooting).

## Setup, once

```bash
npm install
pip install fastapi 'uvicorn[standard]' httpx jsonschema python-multipart
```

The eval harness additionally wants `playwright` and `pillow`, and the ONNX weights under
`extension/models/` are gitignored — they are too large for a plain clone, so a fresh
machine regenerates or re-fetches them (see `extension/models/README.md`).

## Run it

Three terminals. Nothing here reaches the internet.

```bash
npm run build
```

Then load `dist/chrome` unpacked at `chrome://extensions` (or `dist/firefox` via
`about:debugging` after `npm run build:firefox`).

```bash
python -m http.server 8080 --directory demo
```

Open `http://localhost:8080/page-a-enrolment.html`. Not `file://` — both manifests dropped
`file:///*` deliberately, and the content script will not run there.

```bash
cd server && PLANNER=ollama python -m uvicorn app:app --port 8000
```

On Windows PowerShell, `&&` is not a statement separator and there is no inline
`VAR=value cmd` form. The same three commands are:

```powershell
cd D:\SIH; npm run build
cd D:\SIH; python -m http.server 8080 --directory demo
cd D:\SIH\server; $env:PLANNER = "ollama"; python -m uvicorn app:app --port 8000
```

Three planner backends, none of them degraded:

| `PLANNER=` | What                                      | Needs                                     |
| ---------- | ----------------------------------------- | ----------------------------------------- |
| `stub`     | deterministic canned plans, same contract | nothing                                   |
| `ollama`   | Qwen3-VL-4B on a laptop, local            | `ollama pull qwen3-vl:4b`                 |
| `vlm`      | the target: Qwen3-VL-4B on vLLM, xgrammar | a GPU; `docker compose up` — `OFFLINE.md` |

`vlm` is the default, so a misconfigured deployment fails loudly rather than quietly
serving stub plans. On a machine with no GPU you want `stub` or `ollama` **explicitly**.

### Tier 1, which needs one more thing

The local tie-break and the local reader both talk to Ollama on `localhost:11434`, and
Ollama's CORS allowlist has no browser-extension origin in it. Started normally it answers
the extension with **403**, so Tier 1 silently never runs — the step log said "tier 1
declined" for months before anyone checked. Start it like this instead:

```bash
OLLAMA_ORIGINS='chrome-extension://*' ollama serve
```

```powershell
$env:OLLAMA_ORIGINS = "chrome-extension://*"; ollama serve
```

The panel's "Local model:" line says which state it is in. Two models, two jobs:
`ollama pull qwen3:0.6b` for the tie-break, `ollama pull qwen2.5:1.5b` for the reader.
Neither is required — without them every step escalates to the planner, which is what
happened before Tier 1 existed.

Confirm the planner is up before running a task:

```bash
curl http://localhost:8000/health
```

It reports which backend is answering, because "the plans got worse" and "the backend
changed" must not look alike from outside.

## The panel

Click the Redaction Gate icon and a panel docks beside the page — it stays open while you
click into the page, which a popup does not, and it is where everything now lives. Three
tabs:

| tab               | what it is                                                                   |
| ----------------- | ---------------------------------------------------------------------------- |
| **Agent**         | the goal box, Run/Stop, the overlay toggle, the counter, the step log        |
| **What was sent** | the screen as captured beside the exact bytes POSTed, and every manifest row |
| **Resources**     | backend, resident model bytes, JS heap, and the per-stage latency waterfall  |

The two evidence tabs used to be browser tabs, which meant looking away from the page the
agent was driving in order to see what it had done to it. They are still their own pages —
`sidebyside.html` and `hud.html` open full-screen for a projector, and the harness drives
`popup.html` directly — but nothing makes you switch tabs any more.

Both evidence views are fed by a push per step and hold nothing after the session ends, so
**open the panel before the run, not after**.

### One session, one tab

The panel docks beside the _window_; a session belongs to one _tab_ — the one that was in
front when you pressed Run. Its element indices, its placeholder numbering and its step log
all describe that page and no other.

So switching tabs while a task runs shows a banner naming the site the agent is actually
working on, with a button to go back to it:

> **Running on `http://localhost:8080`** — not the tab in front. **Show it**

Without it the panel read `running - step 4` on every tab in the window, which is
indistinguishable from a task running on the page you happen to be looking at.

Run is disabled while a session is live, and the worker refuses a second one on another tab
rather than only greying out the button — _"already running on http://localhost:8080 — stop
that first"_. There is one state record, so a second session would not run two agents, it
would replace the first mid-step and take its evidence with it. A re-run on the _same_ tab
is allowed: there you can see what you are replacing.

The overlay follows the session too. While a task is running the boxes are drawn on that
task's tab, because they are the boxes that session perceived; with nothing running it
draws on the tab in front.

Then: press **Check** (it probes the inference host and reports the backend, `shader-f16`,
thread count and whether the output values are right), type a goal, press **Run**.

On Firefox there is no `chrome.sidePanel`. The same page is a `sidebar_action`, opened from
Firefox's own sidebar control, and the toolbar action keeps its popup.

The toolbar click is handled by the worker rather than by Chrome, and that is load-bearing
rather than stylistic. `setPanelBehavior({openPanelOnActionClick: true})` has Chrome open
the panel itself, `action.onClicked` never fires, the click is therefore not an
_invocation_ of the extension, and `activeTab` is never granted — so every page outside
`host_permissions` fails at content-script injection with a sentence about the manifest
that reads as a build defect. Handling `onClicked` restores the grant and opens the same
panel from the same click.

## Troubleshooting

**`no access to this site yet`.** The extension asks for `activeTab` and
`http://localhost/*` at install and nothing more, so a site outside that has to be allowed
before the agent can touch it. Two ways, and they are different bargains:

|                                    | what you get              | what it costs                                                                         |
| ---------------------------------- | ------------------------- | ------------------------------------------------------------------------------------- |
| Click the toolbar icon on that tab | `activeTab` for that page | lapses the moment the page navigates — including a navigation the agent itself caused |
| **Site access → Allow any site**   | `<all_urls>`, permanently | a broad grant, visible in `chrome://extensions` and revocable from the same button    |

`captureVisibleTab` accepts nothing narrower than those two. A host permission for the
exact origin in front of you does _not_ satisfy it — the API takes `<all_urls>` or
`activeTab`, and that is the whole list — which is why there is no per-site option here.

The panel says which of the two is in force, and the second is why the multi-page demo
works at all: `activeTab` is revoked by the page A → page B submit that the agent performs.

**`this extension may only photograph a tab you have pointed it at`.** The step failed at
`capture`, and it is the first thing a fresh install does. `chrome.tabs.captureVisibleTab`
takes either `<all_urls>` or `activeTab`, and this extension ships `activeTab` on purpose:
it is the permission that lets "what can this see?" be answered with "the tab you pointed
it at, while you are pointing at it". Chrome grants it when **you** invoke the extension —
clicking the toolbar icon counts, opening `popup.html` in a tab does not — and revokes it
when the tab navigates.

So: click the Redaction Gate icon in the toolbar **while the tab you want driven is in
front**, then Run. If a page load happens that the agent did not cause, click the icon
again — and note that the same click toggles the panel, so if the panel was already open
you will need a second click to bring it back. The eval harness
cannot produce that gesture at all, which is why `eval/runner/build.py` widens exactly that
one field in a copy of the build, and says so in the manifest and in the report.

**`failed at plan` / `Failed to fetch`.** The planner API is not running. This is the error
you get from an otherwise entirely healthy build, and the step burns its full perception
budget first, so it looks like a deep failure rather than a missing process. Check with
`curl http://localhost:8000/health`; start it with the command above. The transport names
the endpoint in the message for exactly this reason.

**`failed at plan` after 20–60 s with `PLANNER=ollama`.** Not a fault. `qwen3-vl:4b` on CPU
takes that long per step, and Ollama reloads weights after an idle period. Measured
baseline and what a 4B model actually does with this prompt: `server/README.md`.

**`the planner … did not answer within 60s`.** The planner accepted the request and then
said nothing — a model still loading, a wedged worker, a laptop that slept mid-generation.
The plan phase has one deadline for the whole call (`PLAN_TIMEOUT_MS`, worker/transport.ts)
because without it the step hangs for as long as the browser holds the socket, and from the
popup that is indistinguishable from a step that is working. With `PLANNER=ollama` on a
CPU-only machine this is the _expected_ outcome, not a fault: measured here, `qwen3-vl:4b`
took 23–113 s for a two-token reply with no image at all. Use `stub` or a GPU.

**`stopped after 30 steps without the plan finishing`.** The loop's own terminator
(`MAX_STEPS`, shared/agent.ts). `finish` and `ask` belong to the plan, so without a budget
a planner that keeps re-proposing an action it cannot see failing runs until the tab
closes, at a screenshot, a detection pass and a POST per round. Thirty is generous for
anything the demo does. Seeing it means the planner stopped making progress — read the step
log, which names the action it kept repeating.

**`page would not hold still`.** Two captures in a row were invalidated by the page moving
under them. By design — a frame whose geometry drifted is discarded rather than redacted at
coordinates that have moved. Re-run; if it repeats, the page is animating.

**The counter reads 0 after a run ends.** Also by design. The side-by-side panel's evidence
— which includes the _pre-gate_ frame, PII and all — lives in memory in the offscreen
document and is dropped when the session ends. Open the panel during or immediately after
a run, not later.

## Verify

```bash
npm run lint          # eslint incl. the gate rule, and tsc
npm test              # vitest
npm run test:gate     # greps both built bundles for illegal encoders
python -m pytest server/
python eval/harness.py       # scores detection: writes eval/report/report.json
python scripts/demo-smoke.py # drives the actual demo in a real Chrome
```

The last two answer different questions and neither substitutes for the other. The harness
measures **detection** against a labelled corpus and drives one step per page. The smoke
script runs the **demonstration** — both demo pages, the real `server/app.py`, a whole
multi-step session across the page A → page B navigation — and prints the phase every step
reached, what the gate wrote, what the panel is showing, and what the page itself thinks
happened. A build can score well on the first and be unusable in the second; that is how the
loop came to advance no further than one step after every successful `type`.

`npm run test:gate` is the one that matters most: `extension/src/redaction/gate.ts` is the
only module permitted to turn pixels into bytes, and the build fails if any other
first-party file does.

## Layout

```
extension/   the client: content script, offscreen inference host, redaction, worker
server/      FastAPI in front of vLLM or Ollama. One endpoint, POST /v1/step
eval/        corpus, labelling tool, harness, report — 65% of the rubric is measurable
demo/        two static pages the agent drives, and the demo script
prompts/     the Claude Code prompt pack this project was built from
```

`server/schema.json` is generated from `extension/src/shared/contract.ts` by
`npm run schema:gen`; `npm run schema:check` fails the build when they drift. Never
hand-edit it — a second copy of the contract is a second contract.
