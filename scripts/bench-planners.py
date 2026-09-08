"""Measure candidate planner models against real recorded steps, and score them.

Model choice for this project has three axes and only one of them is opinion:

    latency      how long a step waits. The client gives the plan phase 60 s
                 (worker/transport.ts, PLAN_TIMEOUT_MS) and a demo wants a small
                 fraction of that.
    validity     does the reply satisfy server/schema.json. A plan that does not is
                 refused by the server, so an invalid model is not a slow model, it is
                 a broken one.
    sense        does the action refer to an element that exists, and is it the one a
                 person would pick. Scored crudely here -- index in range, and not a
                 re-click of something already done -- because the alternative is to
                 trust a vibe.

The inputs are real: `eval/report/runs/*/step.json` is a request the extension actually
sent, and `sealed.webp` beside it is the redacted frame that went with it. Benchmarking
on a synthetic prompt would measure the wrong thing entirely -- these prompts are 2-6 kB
of element list, which is most of what a small model has to chew through.

    python scripts/bench-planners.py --models qwen3:0.6b qwen2.5:1.5b
    python scripts/bench-planners.py --vision --models moondream:1.8b

Ollama only. vLLM is the deployment target and is measured on the machine that has the
GPU; this exists to choose what runs on a laptop.
"""

from __future__ import annotations

import argparse
import base64
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from planner import (  # noqa: E402
    SYSTEM_PROMPT,
    WORKED_EXAMPLE_ASSISTANT,
    WORKED_EXAMPLE_USER,
    build_user_message,
    completion_text,
)

OLLAMA = "http://localhost:11434/v1/chat/completions"
RUNS = ROOT / "eval" / "report" / "runs"

#: Roles that accept typed text. Everything else is a mis-targeted `type`.
TYPEABLE = frozenset({"textbox", "searchbox", "combobox", "spinbutton"})


def load_schema() -> dict:
    schema = json.loads((ROOT / "server" / "schema.json").read_text(encoding="utf-8"))
    return {k: v for k, v in schema.items() if k not in ("$schema", "$comment")}


def cases(limit: int, with_image: bool) -> list[tuple[str, dict, bytes | None]]:
    out: list[tuple[str, dict, bytes | None]] = []
    for folder in sorted(RUNS.glob("*/step.json")):
        request = json.loads(folder.read_text(encoding="utf-8"))
        frame = folder.parent / "sealed.webp"
        image = frame.read_bytes() if (with_image and frame.exists()) else None
        out.append((folder.parent.name, request, image))
        if len(out) >= limit:
            break
    return out


def messages(request: dict, image: bytes | None) -> list[dict]:
    text = build_user_message(request)
    if image is None:
        content: object = text
    else:
        mime = request.get("capture", {}).get("mime", "image/webp")
        encoded = base64.b64encode(image).decode("ascii")
        content = [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{encoded}"}},
        ]
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": WORKED_EXAMPLE_USER},
        {"role": "assistant", "content": WORKED_EXAMPLE_ASSISTANT},
        {"role": "user", "content": content},
    ]


def ask(model: str, msgs: list[dict], schema: dict, timeout: float, guided: bool) -> dict:
    body = {
        "model": model,
        "messages": msgs,
        "max_tokens": 512,
        "temperature": 0.2,
        # Thinking off. Every Qwen3 in the library ships it enabled, and a 0.6B that
        # spends its whole budget reasoning returns empty content -- a model failure
        # that arrives looking like a transport bug.
        "reasoning_effort": "none",
        "chat_template_kwargs": {"enable_thinking": False},
    }
    if guided:
        body["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "step_response", "schema": schema, "strict": True},
        }

    started = time.perf_counter()
    request = urllib.request.Request(
        OLLAMA, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as reply:
            payload = json.loads(reply.read())
    except (urllib.error.URLError, OSError, TimeoutError) as err:
        return {"ms": (time.perf_counter() - started) * 1000, "error": str(err)[:120]}

    ms = (time.perf_counter() - started) * 1000
    message = payload["choices"][0]["message"]
    usage = payload.get("usage", {})
    return {
        "ms": ms,
        "text": completion_text(message),
        "thinking": len(message.get("reasoning") or ""),
        "in": usage.get("prompt_tokens", 0),
        "out": usage.get("completion_tokens", 0),
    }


def score(text: str, request: dict, validate) -> tuple[bool, str]:
    """Valid against the contract, and pointing at something that exists."""
    try:
        plan = json.loads(text)
    except json.JSONDecodeError as err:
        return False, f"not JSON ({err.msg})"

    plan.setdefault("protocolVersion", 1)
    plan.setdefault("stepIndex", request.get("stepIndex", 0))
    problems = validate(plan)
    if problems:
        return False, f"schema: {problems[0]}"[:80]

    by_index = {
        el["index"]: el for el in request.get("elements", []) if el.get("index") is not None
    }
    for action in plan["actions"]:
        index = action.get("index")
        if index is None:
            continue
        target = by_index.get(index)
        if target is None:
            # The signature of a model that cannot map the prompt's [3] notation onto the
            # schema's `index` field: guided decoding still has to emit an integer, so it
            # emits the smallest legal one. Every model that failed here failed this way,
            # and every one of those replies was schema-valid. Validity alone would have
            # passed all of them.
            return False, f"index [{index}] is not on the page"
        if action["type"] == "type" and target.get("role") not in TYPEABLE:
            # Schema-legal and nonsense: `index` only has to be an integer that exists,
            # so a model that has not understood the element list can type into a button
            # and still validate. The smallest model tested did exactly this on pages
            # whose only indexed elements were buttons, and scored 4/4 until this check
            # existed.
            return False, f"types into [{index}], a {target.get('role')}"
        if action["type"] == "type" and target.get("state", {}).get("filled"):
            # The element list says `filled` and carries the placeholder already in the
            # box; the system prompt spends four lines on what that means. Re-typing into
            # it is not a formatting slip, it is the model not reading the state it was
            # given -- and it is what stalls a real run, because the page does not change
            # and the next step looks identical to this one.
            return False, f"re-types into [{index}], already filled"
    return True, ", ".join(a["type"] for a in plan["actions"])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", required=True)
    ap.add_argument("--cases", type=int, default=6)
    ap.add_argument("--vision", action="store_true", help="send the sealed frame too")
    ap.add_argument("--timeout", type=float, default=300.0)
    ap.add_argument("--no-guided", action="store_true", help="drop the JSON schema")
    args = ap.parse_args()

    sys.path.insert(0, str(ROOT / "server"))
    from app import load_schemas, validate  # noqa: E402

    _, response_schema = load_schemas()
    guided_schema = load_schema()
    work = cases(args.cases, args.vision)
    if not work:
        raise SystemExit(f"no recorded steps under {RUNS}. Run python eval/harness.py first.")

    print(f"{len(work)} case(s), image={'yes' if args.vision else 'no'}, "
          f"guided={'no' if args.no_guided else 'yes'}\n")

    for model in args.models:
        times: list[float] = []
        good = 0
        print(f"-- {model}")
        for name, request, image in work:
            result = ask(
                model,
                messages(request, image),
                guided_schema,
                args.timeout,
                not args.no_guided,
            )
            if "error" in result:
                print(f"  {name:26s} {result['ms']/1000:6.1f}s  FAILED {result['error']}")
                continue

            ok, note = score(result["text"], request, lambda p: validate(p, response_schema))
            times.append(result["ms"])
            good += ok
            think = f" think={result['thinking']}" if result["thinking"] else ""
            print(f"  {name:26s} {result['ms']/1000:6.1f}s  "
                  f"{'ok  ' if ok else 'BAD '}{note[:52]:52s} "
                  f"in={result['in']:5d} out={result['out']:3d}{think}")

        if times:
            print(f"  {'':26s} median {statistics.median(times)/1000:5.1f}s  "
                  f"max {max(times)/1000:5.1f}s  usable {good}/{len(work)}\n")
        else:
            print("  no successful calls\n")


if __name__ == "__main__":
    main()
