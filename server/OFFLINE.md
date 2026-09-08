# Running the planner offline

ISRO's brief requires offline deployability, and the privacy argument the extension makes
for twenty minutes is undone by one hosted API call. So the stack has to start with the
network cable out, and that has to have been _demonstrated_ rather than asserted — a judge
will ask, and "it should work" is not an answer.

This is the one-time fetch, what runs where, the resource floor, and the disconnection
test.

## What runs where

```
extension  ──POST /v1/step──▶  api (FastAPI)  ──chat/completions──▶  vllm  ──▶  GPU
                                    │
                              schema.json, generated from the TypeScript contract
```

The API holds the contract and the session state. vLLM holds the weights and the GPU.
They are separate so the API can start and answer `/health` on a machine with no GPU at
all — the stub planner is a supported mode, and the client team develops against it.

## One-time fetch

Everything downloaded here is pinned. Do this once, on a connected machine, and the rest
of the demo never touches the network.

```bash
# 1. The model. Pick the size from README.md; 4B is the laptop default.
pip install huggingface_hub
hf download Qwen/Qwen3-VL-4B-Instruct \
  --local-dir server/models/Qwen3-VL-4B-Instruct \
  --revision main

# 2. The serving image, pinned to the same tag docker-compose.yml names.
docker pull vllm/vllm-openai:v0.11.0

# 3. The API image.
docker compose -f server/docker-compose.yml build api
```

Record the revision hash you actually downloaded in README.md next to the size. "main"
moves; a demo that worked last week and not today is usually this.

## Starting it

```bash
docker compose -f server/docker-compose.yml up
```

First start is slow — the model load is minutes, not seconds, which is why the healthcheck
allows a five-minute `start_period`. Do not shorten it because it looks slow on a machine
with a warm cache.

No GPU on hand:

```bash
PLANNER=stub docker compose -f server/docker-compose.yml up api
```

The stub returns schema-valid canned actions. The client cannot tell the difference at the
contract level, which is exactly the property that makes it useful.

## The disconnection test

This is a demo beat, not a formality. Run it before the demo, not on the day.

```bash
# 1. Everything pulled, everything started once, then stopped.
docker compose -f server/docker-compose.yml down

# 2. Disconnect. Actually disconnect -- pull the cable, disable the adapter.
#    A firewall rule proves less than a cable does.

# 3. Start again, from cold.
docker compose -f server/docker-compose.yml up

# 4. Verify.
curl -s http://localhost:8000/health
python server/check_guided_decoding.py
```

What fails when something was not pinned: vLLM tries to reach huggingface.co for the
tokenizer, hangs for its timeout, and then dies. `HF_HUB_OFFLINE=1` in the compose file
turns that hang into an immediate, readable error — which is why it is set even though
the machine is supposed to be offline anyway.

## Resource floor

Measured figures go in README.md; these are the floors to plan hardware against.

|                      | VRAM   | System RAM | Disk    |
| -------------------- | ------ | ---------- | ------- |
| Qwen3-VL-2B-Instruct | ~6 GB  | 8 GB       | ~5 GB   |
| Qwen3-VL-4B-Instruct | ~11 GB | 16 GB      | ~9 GB   |
| Qwen3-VL-8B-Instruct | ~20 GB | 32 GB      | ~17 GB  |
| Stub planner         | none   | 512 MB     | ~200 MB |

The extension itself is the other half of the resource story and it is deliberately not on
this machine: models run on the user's device, and this server holds no weights for
perception at all.

## What the server keeps

Nothing that came from a page. A session holds placeholders and element indices, and the
trace holds timings, sizes, action types and outcomes. Request bodies are never persisted
and never logged.

This is not a filter applied on the way in — the device substituted every value before the
request was built, so there is nothing to filter. `server/test_server.py` asserts it
anyway, because the assertion is cheap and the claim is load-bearing.
