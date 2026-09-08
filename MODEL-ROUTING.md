# SIH26171 — Model Routing & Resource Profile

> Companion to [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (which covers *where* each
> process runs). This file covers *which model* runs when, and the measured resource cost.

A privacy-preserving browser agent. All visual perception runs on the user's machine.
Exactly one artefact crosses the network per step: a screenshot + element list that have
already passed the one-way redaction gate, plus a manifest of what was removed and why.

This document maps **which model runs when**, and records the **measured resource cost**
on the development machine.

---

## 1. The boundary — four processes, one wire

```
DEVICE (user's machine)                                  │  SERVER (remote planner)
                                                         │
 content script ──┐  DOM snapshot, captureVisible, acts  │
                  ▼                                       │
 offscreen document  (WebGPU / ORT-WASM inference host)  │
   L0 structural │ L1 lexical │ L2 NER │ L3 vision        │
                  │                                       │
                  ▼                                       │
   ██ REDACTION GATE ██  seal() → receipt → encode()      │
                  │                                       │
                  ▼                                       │
 service worker (router; re-verifies receipt) ───────────┼──▶ planner (open-weights model)
                  ▲                                       │      returns typed actions by
                  └───────────────────────────────────────┼──── index + placeholder
                    actions rehydrated locally            │
```

Nothing crosses the wire except the single sanitized POST to `/v1/step`. All model
perception (PII detection, OCR, faces) happens **before** the gate, on-device.

---

## 2. The planning ladder — when each model runs

A step is answered at the cheapest tier that can answer it. The tier that decided is
recorded on every step (`extension/src/worker/tiers.ts`).

| Tier | Where | Model | Fires when | Cost |
|------|-------|-------|-----------|------|
| **0** | device | none (grammar) | Sentence fully parses to concrete field+value actions, e.g. "fill first name with Leo". No model, no network, no screenshot. | ~0 ms |
| **1** | device | local Ollama | Tier 0 resolved the sentence but the *element* is ambiguous (a tie, or below the match floor). A small local model breaks the tie / reads a short goal. | ~4 s |
| **2** | server | remote planner | Sentence is open-ended, negated, unparsed, or Tier 1 could not express the action (e.g. a combobox). The gated screenshot is POSTed. | see §3 |

**Tier 1 local models** (`extension/src/worker/local.ts`, via `localhost:11434`):
- tie-break: `qwen3:0.6b` (`DEFAULT_LOCAL_MODEL`) — pick one index from a shortlist.
- reader: `qwen2.5:1.5b` (`DEFAULT_READER_MODEL`) — read a short goal into actions.

**Escalation is not failure.** Most steps of a real task are open-ended and belong to
Tier 2 on the first look. What Tier 0 buys is that "fill first name with Leo" never leaves
the laptop.

---

## 3. Tier 2 — the two server models, routed per step

The server (`server/app.py`, `server/planner.py`) decides **per step** whether the picture
is needed (`needs_image`). Steps whose DOM fully describes the page take the text path;
steps with content the element list cannot carry (canvas, baked-in image text, faces) take
the vision path.

| Path | Model | Fires when | Measured on dev CPU |
|------|-------|-----------|---------------------|
| **text (fast)** | `qwen2.5:1.5b` | `needs_image == false` — ordinary form, all elements indexed. **Most steps.** | **8–10 s**, valid guided-JSON plan, no reasoning burn |
| **vision** | `qwen3-vl:4b` | `needs_image == true` — reading/extraction, pixels required. | cold-load 61 s, ~2.4 tok/s, thinking variant — **too slow within the 60 s client budget on CPU** (see §6) |

Routing is enabled by setting both env vars:

```bash
PLANNER=ollama OLLAMA_MODEL=qwen2.5:1.5b OLLAMA_VISION_MODEL=qwen3-vl:4b \
  uvicorn app:app --host 127.0.0.1 --port 8000
```

With `OLLAMA_VISION_MODEL` unset, routing collapses to the single text model.

The client's whole-call budget is `PLAN_TIMEOUT_MS = 60_000`
(`extension/src/worker/transport.ts`).

---

## 4. Device perception models (offscreen, pre-gate)

Loaded lazily, refcounted, **unloaded after 60 idle seconds**
(`extension/src/offscreen/sessions.ts`, `IDLE_UNLOAD_MS`). Nothing loads at startup.
DOM-first: vision runs only where the DOM is silent.

| Model | File | Size | Backend | Role | Licence |
|-------|------|------|---------|------|---------|
| PII NER | `ner.onnx` (+ tokenizer 1.4 MB, config) | 107 MB | ORT-WASM | L2 — detect names/PII in text | MIT |
| OCR detect | `ocr-det.onnx` | 4.6 MB | WebGPU | text baked into images | Apache-2.0 |
| OCR recognise | `ocr-rec.onnx` (+ charset 28 KB) | 11 MB | WebGPU | read that text | Apache-2.0 |
| Face | `face-yunet.onnx` | 228 KB | WebGPU | L3 — FACE pixel regions | MIT |
| Smoke | `smoke.onnx` | 512 B | — | backend probe (popup → Check) | MIT |

**Device model total on disk: ~122 MB.** All MIT / Apache-2.0 (invariant 3). All bundled;
`env.allowRemoteModels = false` (invariant 4).

---

## 5. Resource profile — measured on the dev machine

**Hardware:** 2 physical cores / 4 logical · 8 GB RAM (7.56 GiB) · **no discrete GPU**
(`total_vram = 0 B`; WebGPU present via integrated graphics, `webgpu + f16`, 1 thread) ·
disk 238 GB (11 GB free).

### Storage
| Bucket | Size |
|--------|------|
| Device ONNX models (bundled in extension) | ~122 MB |
| Ollama `qwen2.5:1.5b` (text planner) | 986 MB |
| Ollama `qwen3-vl:4b` (vision planner) | 3.3 GB |
| **Ollama blob store total** | **~4.0 GB** |

### RAM (resident while loaded)
| Component | RAM |
|-----------|-----|
| `qwen3-vl:4b` loaded (CPU, 0 VRAM) | ~3.55 GB |
| `qwen2.5:1.5b` loaded | ~1.2 GB (est.) |
| ONNX NER (WASM) | tens of MB, transient |
| Ollama models when idle | **unloaded** (default 5 min keep-alive) |

On an 8 GB machine the 4B vision model alone is ~44% of RAM; running it and the text model
resident together is tight but fits.

### Latency (measured)
| Stage | Time |
|-------|------|
| Inference-host warmup (WebGPU probe) | 465 ms |
| perceive (DOM walk + interactivity) | ~5.7 s (dense form) |
| captureVisible | ~70 ms |
| detect (NER pass) | ~1.3 s |
| seal (gate + encode) | ~100 ms |
| **Tier 2 text step** (`qwen2.5:1.5b`, guided) | **8–10 s** |
| **Tier 2 vision step** (`qwen3-vl:4b`, CPU) | cold 61 s, then ~2.4 tok/s |

### Idle CPU
**~0%.** Capture and perception run on events only — action completion, DOM
mutation-settle after 250 ms quiet, navigation, or a user command. No polling
(invariant 7). Device models unload after 60 s idle; when the last session goes, so does
its timer.

---

## 6. Known limitation on this machine — the vision path

`qwen3-vl:4b` is the **thinking** variant. On this ollama build the thinking channel cannot
be turned off from the OpenAI-compatible `/v1` path (`enable_thinking:false` /
`reasoning_effort:none` are accepted but ignored; the native `/api/chat` `think:false` is
likewise ignored for this model). The model spends its whole token budget in the `reasoning`
channel and returns **empty `content`**.

Combined with **CPU-only inference at ~2.4 tok/s**, a vision step needs minutes, not
seconds, and the client aborts at 60 s. **Result: text/form-fill tasks work; reading tasks
that require pixels do not complete on this hardware.**

Options to make the vision path viable (not yet applied):
1. **Non-thinking small vision model** — e.g. a `qwen2.5-vl:3b` instruct build (MIT/Apache
   only). Removes the reasoning burn; the text path already proves a sub-2B instruct model
   returns valid guided JSON in ~8 s.
2. **GPU** — the 4B vision tower is designed for it; `total_vram = 0 B` here is the ceiling.
3. **Raise `PLAN_TIMEOUT_MS`** — a band-aid; even warm, thinking + 2.4 tok/s blows any
   reasonable client budget.

The text path (`qwen2.5:1.5b`) is unaffected and is the common case for a real form task.

---

## 7. Running it

```bash
# 1. Ollama daemon (serves both models on :11434)
ollama serve

# 2. Planner server with routing (text → 1.5b, vision → 4b)
cd server && PLANNER=ollama OLLAMA_MODEL=qwen2.5:1.5b OLLAMA_VISION_MODEL=qwen3-vl:4b \
  uvicorn app:app --host 127.0.0.1 --port 8000

# 3. Backend probe: open the popup, press Check.
```

`GET /health` reports the live routing:
```json
{"planner":"RoutingPlanner","backend":"ollama qwen2.5:1.5b + qwen3-vl:4b",
 "model":"qwen2.5:1.5b (text) + qwen3-vl:4b (vision)","location":"local (development)"}
```

> `location: local (development)` is stated out loud: when the planner is on the same laptop
> as the browser, redaction is real machinery protecting nobody. A demo that implies
> otherwise is claiming something untrue.
