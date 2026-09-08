#!/usr/bin/env python3
"""Does the generated response schema actually compile for guided decoding?

This is the question to answer before writing a system prompt, not after. vLLM's default
structured-output backend is xgrammar, and `schema.json` renders the action union as a
nine-branch `oneOf` -- historically the shape xgrammar has been least happy with. A
schema that fails to compile does not fail loudly at request time; it falls back or
errors mid-demo.

What this checks, in order:

  1. The schema loads and the root is clean. vLLM rejects `$schema` and `$comment` at the
     root, so strip them and prove the stripped copy is what compiles.
  2. xgrammar compiles it. If that raises, the fallback is `--guided-decoding-backend
     outlines`, and failing that, flattening the union into one object with a `type` enum
     -- regenerated from the Zod source, never by hand-editing this file's input.
  3. A generation actually matches. Compiling proves the grammar is buildable; walking a
     real plan through the matcher proves it accepts what the client will send back.

Run: python server/check_guided_decoding.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

SERVER = Path(__file__).parent
RESPONSE_SCHEMA = SERVER / "schema.json"

# Plans the client must be able to receive. Each is schema-valid by construction; if the
# grammar refuses one of these, guided decoding would make it unreachable at runtime.
SAMPLE_PLANS = [
    {
        "protocolVersion": 1,
        "stepIndex": 4,
        "rationale": "The Aadhaar field already holds a placeholder, so it is filled.",
        "actions": [{"type": "type", "index": 6, "text": "«EMAIL_1»", "submit": False}],
        "done": False,
    },
    {
        "protocolVersion": 1,
        "stepIndex": 5,
        "rationale": "",
        "actions": [{"type": "click", "index": 9}],
        "done": False,
    },
    {
        "protocolVersion": 1,
        "stepIndex": 6,
        "rationale": "Every section is complete.",
        "actions": [{"type": "finish", "status": "success", "summary": "Application submitted."}],
        "done": True,
    },
    {
        "protocolVersion": 1,
        "stepIndex": 7,
        "rationale": "A one-time password is required and cannot be supplied from a placeholder.",
        "actions": [{"type": "ask", "question": "Enter the OTP sent to your phone."}],
        "done": False,
    },
    {
        "protocolVersion": 1,
        "stepIndex": 8,
        "rationale": "Scrolling to reach the rest of the form.",
        "actions": [
            {"type": "scroll", "dx": 0, "dy": 600},
            {"type": "wait", "ms": 250},
        ],
        "done": False,
    },
]


def strip_root_metadata(schema: dict) -> dict:
    """vLLM rejects `$schema` and `$comment` at the root. Remove them, keep the rest."""
    return {k: v for k, v in schema.items() if k not in ("$schema", "$comment")}


def describe_union(schema: dict) -> str:
    actions = schema.get("properties", {}).get("actions", {})
    branches = actions.get("items", {})
    for key in ("oneOf", "anyOf"):
        if key in branches:
            return f"{key} with {len(branches[key])} branches"
    return "no union found in actions.items"


def main() -> int:
    if not RESPONSE_SCHEMA.exists():
        print("schema.json is missing. Run `npm run schema:gen` first.", file=sys.stderr)
        return 1

    raw = json.loads(RESPONSE_SCHEMA.read_text(encoding="utf-8"))
    schema = strip_root_metadata(raw)

    print(f"schema.json: actions.items is {describe_union(schema)}")
    print(f"root keys after stripping: {sorted(schema.keys())}")
    if "$schema" in schema or "$comment" in schema:
        print("FAIL: root metadata survived the strip", file=sys.stderr)
        return 1

    try:
        import xgrammar as xgr
    except ImportError:
        print("xgrammar is not installed; cannot verify the default vLLM backend.")
        print("Install it (`pip install xgrammar`) or run with --guided-decoding-backend outlines.")
        return 2

    try:
        tokenizer_info = xgr.TokenizerInfo([f"<{i}>" for i in range(256)])
        compiler = xgr.GrammarCompiler(tokenizer_info)
        compiled = compiler.compile_json_schema(json.dumps(schema))
    except Exception as err:  # noqa: BLE001 -- the whole point is to see any failure
        print(f"FAIL: xgrammar could not compile the schema: {type(err).__name__}: {err}")
        print()
        print("Fallbacks, in order:")
        print("  1. vLLM --guided-decoding-backend outlines")
        print("  2. Flatten the action union into one object with a `type` enum and")
        print("     optional fields, regenerating from extension/src/shared/contract.ts.")
        return 1

    print("xgrammar compiled the schema.")

    failures = 0
    for plan in SAMPLE_PLANS:
        text = json.dumps(plan, ensure_ascii=False, separators=(",", ":"))
        matcher = xgr.GrammarMatcher(compiled)
        ok = matcher.accept_string(text)
        # Deliberately not asserting is_terminated(): the matcher waits for a stop token
        # that accept_string never emits, so it reads False even for a complete and
        # perfectly valid document. An earlier version of this script checked it and
        # reported all five plans as rejected, which was the script being wrong rather
        # than the grammar.
        action = plan["actions"][0]["type"]
        print(f"  {'ok  ' if ok else 'FAIL'} {action:8s} {text[:64]}...")
        if not ok:
            failures += 1

    if failures:
        print(f"\nFAIL: {failures} of {len(SAMPLE_PLANS)} plans were rejected by the grammar.")
        return 1

    print(f"\nAll {len(SAMPLE_PLANS)} plans accepted. Guided decoding is safe to switch on.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
