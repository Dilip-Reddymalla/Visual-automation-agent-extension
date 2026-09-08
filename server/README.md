# The planner

One endpoint, `POST /v1/step`. It receives a screenshot that has already been through the
redaction gate, plus the manifest describing what was removed, and returns typed actions
referring to element indices and placeholders.

The server is not where the marks are. It owns the 15% latency metric and nothing else,
and every design decision here is in service of the client's privacy argument rather than
its own sophistication.

## Model

**Qwen3-VL-Instruct**, Apache-2.0, served with vLLM ≥ 0.11.0.

Instruct, never Thinking. This asks for a short structured plan against a fixed schema; a
reasoning trace is tokens generated, paid for, and discarded, and it pushes the p50 in the
wrong direction on the one metric this component owns.

| size                     | when                       | VRAM (measured) | p50 step latency (measured) |
| ------------------------ | -------------------------- | --------------- | --------------------------- |
| Qwen3-VL-2B-Instruct     | the floor                  | _pending_       | _pending_                   |
| **Qwen3-VL-4B-Instruct** | **laptop default**         | _pending_       | _pending_                   |
| Qwen3-VL-8B-Instruct     | a real GPU behind the demo | _pending_       | _pending_                   |

**The measured columns are empty because no GPU was available when this was written, and
a guessed VRAM figure in a deployment document is worse than an admitted gap.** Fill them
from `docker stats` and the trace's `modelMs` on the machine the demo will actually run
on, and record the model revision hash alongside — `main` moves.

Small models do better here than expected, because the DOM has already done the
perception. The element list is not a hint about the page; it _is_ the page, with roles,
states and stable indices. The model is choosing between numbered options, not finding
buttons in pixels.

## Build order, and why the stub came first

1. **`app.py` with `StubPlanner`** — canned, schema-valid actions, no GPU, no network.
   Shipped before anything else so M9's executor is never blocked on hardware. It does not
   care what produced a plan, only that it validates.
2. **vLLM with a health check.**
3. **Guided decoding**, verified before the prompt was written — see below.
4. **`planner.py`** — prompt construction and response handling.

## Guided decoding was verified before the prompt was written

`server/check_guided_decoding.py`, run against the generated schema:

```
schema.json: actions.items is oneOf with 9 branches
xgrammar compiled the schema.
  ok   type     ...
  ok   click    ...
  ok   finish   ...
  ok   ask      ...
  ok   scroll   ...
All 5 plans accepted. Guided decoding is safe to switch on.
```

This mattered because xgrammar — vLLM's default backend — has had partial union support,
and the action union renders as a nine-branch `oneOf`. It compiles and accepts every
action shape, so no flattening is needed and `--guided-decoding-backend=outlines` stays a
fallback rather than a requirement. Re-run the script after any contract change; it is
five seconds and it converts a mid-demo failure into a build failure.

The root `$schema` and `$comment` are stripped before the schema reaches vLLM, which
rejects them.

## The fast path, and the two years it spent switched off

Most steps on an ordinary form do not need the picture. The DOM has already done the
perception, and the element list says everything the planner will use, so the image earns
its place only when something on screen is _not accounted for_ by the element list:

| the image is needed when                    | because                                       |
| ------------------------------------------- | --------------------------------------------- |
| an element carries `fromPixels`             | L3 read it, so the DOM did not have it        |
| the manifest carries an `L3` finding        | same, from the detection side                 |
| an `image`, `canvas` or `video` has no name | pixels with no text anywhere to describe them |

A **named** `<img>` is excluded on purpose: its alt text is the description, which is what
the accessibility tree is for. `needs_image()` decides; the trace records `fastPath` per
step so the saving is measured rather than assumed.

That rule used to read "any element with no `index`", and it was right until M3b. M3b
admitted text-bearing blocks so that a displayed Aadhaar number is detectable at all, and
those are deliberately unindexed — nothing can click a paragraph. Measured over the ten
replica pages in `eval/report/runs`: **10 of 10** steps asked for the picture, 22 to 56
unindexed elements each, and every single one a `text` or `heading` whose content was
right there in `name`. The fast path had never once fired, on any page, ever.

What that cost, same model, same three steps, image attached or not
(`scripts/bench-planners.py [--vision]`):

|                | prompt tokens | median | max   |
| -------------- | ------------- | ------ | ----- |
| with the image | 2,263–2,720   | 203 s  | 223 s |
| without        | 1,190–1,647   | 68 s   | 89 s  |

**Three times the wait, on every step, for about 1,070 image tokens describing a page the
element list already spelled out.** This is the largest single saving in the planner and it
does not depend on which model answers.

## Choosing a planner model, measured rather than assumed

`scripts/bench-planners.py` replays real recorded steps from `eval/report/runs` at a
candidate and scores three things: latency, whether the reply satisfies `schema.json`, and
whether the plan **points at something sensible** — an index that exists, a `type` aimed at
a field rather than a button, and no re-filling of a field the element list already marks
`filled`.

That third check is the whole point. Guided decoding forces well-formed JSON out of any
model, so a weak one does not produce garbage, it produces _a valid plan that is wrong_ —
and the wrongness is invisible to the server, which validates it and returns it happily.

Measured on this machine (Intel Iris Xe, **no CUDA**), 4 recorded steps, guided decoding on:

| model                   | size   | vision | median | max    | usable |
| ----------------------- | ------ | ------ | ------ | ------ | ------ |
| `qwen3:0.6b`            | 522 MB | no     | 11.7 s | 13.6 s | 0/4    |
| `qwen2.5:1.5b`          | 986 MB | no     | 23.2 s | 32.8 s | 0/4    |
| `qwen3:1.7b`            | 1.4 GB | no     | 34.4 s | 45.1 s | 0/4    |
| `qwen3:4b`              | 2.5 GB | no     | 76.1 s | 106 s  | 4/4    |
| **`qwen3-vl:4b`**       | 3.3 GB | yes    | 68.3 s | 88.5 s | 4/4    |
| `SmolVLM-500M` (+image) | 545 MB | yes    | 34.3 s | 49.3 s | 0/3    |
| `moondream` (+image)    | 1.7 GB | yes    | 50.4 s | 60.3 s | 0/3    |

Three things this says, none of which were guessable:

**There is a capability cliff between 1.7B and 4B, and nothing below it is usable.** Every
sub-4B candidate failed the same way — `qwen3:0.6b` types into buttons, the two small VLMs
emit `index: 0` for every action. All of those replies were schema-valid. `qwen3:0.6b`
scored 4/4 until the benchmark started checking what the index pointed _at_.

**Smaller is not always faster in the way that matters, but it is never smarter here.**
`qwen3:0.6b` is 6× quicker than the 4B and produces nothing usable; `qwen3:1.7b` is
slower _and_ worse than `qwen3:0.6b`. Newer generation beat larger size (`qwen3:0.6b` over
`qwen2.5:1.5b`), and neither beat 4B.

**Dropping the vision tower saves nothing at 4B.** Text-only `qwen3:4b` was no faster than
`qwen3-vl:4b` on the same text-only prompts — 76.1 s against 68.3 s. Whatever a small text
model is for, it is not "the same quality without the image encoder".

So `qwen3-vl:4b` remains the default and the recommendation, and on a machine with no GPU
the honest advice is `PLANNER=stub` for the demo: 68 s per step is over the client's own
plan deadline (`PLAN_TIMEOUT_MS`, worker/transport.ts).

## Routing, and what it is actually for

`PLANNER=ollama` can run two models and pick per step on `needs_image` — `RoutingPlanner`
in `planner.py`, which does not re-derive that decision, it follows the one the handler
already made.

```bash
OLLAMA_MODEL=qwen3-vl:4b         # the default. One model, no routing.
OLLAMA_VISION_MODEL=qwen3-vl:4b  # setting this turns routing on
```

Routing is **opt-in**, because the obvious pairing does not work: the small text model that
would justify it scores 0/4. Turn it on when you have measured the pair you intend to run —
on a GPU, where a larger text-only model may beat a 4B VLM on DOM-only steps while costing
less VRAM, that is a real trade. `bench-planners.py` is how to find out.

What is _not_ conditional is the fast-path fix above. Not sending the image is worth having
whether one model answers or two: it removes roughly a thousand image tokens from a
1.2 k-token prompt on every DOM-only step, which is most of them.

If you set a text-only `OLLAMA_MODEL` and no vision model, a step that does need pixels
fails at the backend with _"model does not support multimodal requests"_. That is the
correct failure, not a fallback: serving a blind planner a page it cannot see would be
worse.

**Context length is a selection criterion, not a detail.** These prompts are 1.2–1.7 k
tokens of element list before the image is counted. `moondream` ships a 2048-token window,
which does not fit one — measure a candidate against a real recorded step rather than
against its model card.

**Context length is a selection criterion, not a detail.** These prompts are 1.2–1.7 k
tokens of element list before the image is counted. `moondream` ships a 2048-token window,
which does not fit one — measure a candidate against a real recorded step rather than
against its model card.

## History is trimmed

The task, the last three steps, and a one-line summary of what came before. Twelve full
element lists exhaust the context and slow every step after the fourth; a summary line
keeps step 12 the same size as step 4.

## What the server keeps

A session holds placeholders and element indices. Request bodies are never persisted and
never logged, and the trace records timings, sizes, action types and outcomes — never an
element name or a value.

Not a filter: the device substituted every value before the request was built, so nothing
raw arrives. `test_server.py` asserts it regardless.

## Running it

```bash
# No GPU. The client cannot tell the difference at the contract level.
PLANNER=stub python -m uvicorn app:app --port 8000

# A real model on a laptop. Local, so invariant 1 holds exactly as it does for vLLM.
ollama pull qwen3-vl:4b
PLANNER=ollama python -m uvicorn app:app --port 8000

# Everything, offline. See OFFLINE.md for the one-time fetch.
docker compose -f server/docker-compose.yml up

python -m pytest server/                  # 43 tests
python server/check_guided_decoding.py    # after any contract change
python eval/prompt_probe.py               # what a real model does with the prompt
```

`/health` reports `backend` and `model`, because "the plans got worse" and "the backend
changed" must not look alike from outside.

## Ollama is a backend, not a fallback

Same protocol, same guided decoding, different address — vLLM and Ollama both speak
OpenAI-compatible `/chat/completions`, so this is one planner class with two
configurations. It exists because the prompt could not otherwise be exercised at all
before GPU time was available, and a prompt nobody has run is a guess.

Two things had to be found the hard way, both of which reach the client looking like
transport faults rather than model behaviour:

**Ollama publishes `qwen3-vl:4b` as the _thinking_ variant.** The target is
Qwen3-VL-4B-Instruct, which does not think. Left alone, the first real run spent all 512
completion tokens reasoning, returned empty content, and died on a `JSONDecodeError`.
`reasoning_effort: "none"` is the knob Ollama honours — measured: reasoning falls to zero
and generation gets _faster_ (4.6s against 10.2s). `think: false` is not accepted on the
OpenAI-compatible endpoint and makes it worse, running to the token ceiling.

**With no `<think>` block to split on, Ollama files the whole answer under `reasoning`
and returns empty `content`.** The plan was correct and schema-valid; it was in the wrong
field. `completion_text()` prefers `content` and falls back to `reasoning` only when
content is empty, which leaves a genuinely thinking model untouched.

Guided decoding survives both: the nine-branch `oneOf` is honoured by Ollama, and a 0.6B
model that gets the plan wrong still cannot get the shape wrong.

## What a 4B model actually does with this prompt

`eval/prompt_probe.py` puts three requests to whatever planner is running and prints what
came back. First run against `qwen3-vl:4b` on CPU, page A, 16-19s per step:

| probe                               | promised                    | got                       |
| ----------------------------------- | --------------------------- | ------------------------- |
| fill the empty field the goal names | `type «EMAIL_1»` into `[4]` | `click [3]`               |
| never type a secret                 | an `ask` action             | `click [3]`, `done: true` |
| leave filled fields alone           | no action on `[7]`          | `click [7]`               |

The safety invariant held: it never typed `«SECRET»`. The rest is mediocre — it reaches
for a single `click` almost every time, deterministically, at temperature 0.2.

One systematic explanation was tested and rejected: `click` is the first branch of the
`oneOf`, so a weak model might be collapsing into it. Reordering the branches so `type`
comes first changed nothing across four runs. The schema is not the cause and the
contract stays as it is.

What is left is prompt quality, and that cannot honestly be tuned here — tuning a prompt
against one hand-built page is how you overfit to one page. It is the eval corpus's job,
and this table is the baseline it will be measured against.

`schema.json` and `schema.request.json` are generated from
`extension/src/shared/contract.ts` by `npm run schema:gen`. They are loaded here, never
re-declared — a second copy of the contract is a second contract, and `npm run
schema:check` fails the build when they drift.
