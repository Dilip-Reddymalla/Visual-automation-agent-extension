"""Can a small local model read an instruction the grammar cannot?

    python scripts/bench-reader.py
    python scripts/bench-reader.py --model qwen3:1.7b

Tier 1 now has a second job: when the grammar reads nothing, the model on this machine is
shown the sentence and the fields on the page and asked what should happen. That is a much
larger question than the tie-break it was doing, and "a small model can do this" is a claim
that has to be measured rather than hoped for -- `scripts/bench-planners.py` already found
that a 0.6B asked for a *plan* produces schema-valid nonsense, which is exactly the shape of
answer this feature invites.

So: real sentences, a real field list, the real prompt, against a real Ollama. Every reply is
put through the same two checks the worker applies -- the index must be one that was offered,
and the value must be findable in the user's own sentence -- because a plan that passes the
schema and fails those is not a success, and counting it as one is how the 0.6B looked good
last time.

Prints a table. Nothing here changes any default; picking the model is a deployment decision
and this is the evidence for it.
"""

from __future__ import annotations

import argparse
import json
import re
import time
import urllib.error
import urllib.request

ENDPOINT = "http://localhost:11434/v1/chat/completions"

#: The page, as the worker would describe it. w3schools' contact form, including the
#: Subject box whose caption the page never associated with it.
FIELDS = [
    (1, "First Name", "textbox"),
    (2, "Last Name", "textbox"),
    (3, "Country", "combobox"),
    (4, "Subject", "textbox"),
    (5, "Submit", "button"),
]

#: Sentences the grammar in intent.ts does not read, and what must happen for each.
#:
#: `fill` names the index that must be typed into and the text that must land there.
#: `click` names an index that must be clicked. `refuse` means any answer other than an
#: empty list is wrong -- the sentence supplies no value, so anything typed was invented.
CASES = [
    {
        "goal": "put my name down as Asha",
        "fill": {1: "asha"},
    },
    {
        "goal": "my surname is Menon",
        "fill": {2: "menon"},
    },
    {
        "goal": "the subject should say hello there",
        "fill": {4: "hello there"},
    },
    {
        "goal": "write leo in the first box and then send it",
        "fill": {1: "leo"},
        "click": 5,
    },
    {
        "goal": "I want to be contacted about a refund, put that in the subject",
        "fill": {4: "refund"},
    },
    {
        "goal": "go ahead and submit this",
        "click": 5,
    },
    # A person listing values down a form, one per line, with an action at the end. No
    # verbs, no field names -- the association is positional and visual, and the grammar
    # reads none of it. This is a real transcript.
    {
        "goal": "Leo A\nAustralia\nnone\nThen click submit",
        # "Leo A" onto a form with First Name and Last Name is genuinely ambiguous, and
        # splitting it across the two is a fair reading -- so only the unambiguous half is
        # asserted. Subject is asserted too, and is expected to be missed: the model runs
        # out of sentence and echoes the label, the guard drops that one action, and the
        # case scores `partial` -- which is exactly what the agent then reports.
        "fill": {1: "leo", 4: "none"},
        "select": {3: "australia"},
        "click": 5,
    },
    # The trap. No value anywhere in the sentence, and a model that has seen a million
    # contact forms has a very likely answer for every one of these boxes.
    {
        "goal": "fill in this form for me",
        "refuse": True,
    },
    {
        "goal": "complete the contact form with my details",
        "refuse": True,
    },
]

PROMPT = """A user is looking at a web page and said:
"{goal}"

These are the fields and buttons on the page:
{fields}

Decide what should happen. Reply with a JSON list of actions.
Each action is {{"index": <number from the list above>, "action": "type", "click" or "select", "text": "<what to type>"}}.
Use "click" for buttons and links, with text "".
Use "type" for text fields, with the text taken from the user's sentence.
Use "select" for a dropdown (combobox), with the text being the option to choose.

Rules:
- Only use index numbers from the list above.
- Copy the text to type from the user's sentence word for word. Do not invent names, emails, numbers or any other value.
- If the sentence does not name a value for a field, do not fill that field.
- If the sentence does not say what to do, reply with an empty list."""

RETRY = """

Your previous answer was rejected: {why}
Try again. Every value must appear in the user's sentence above."""

SCHEMA = {
    "type": "object",
    "properties": {
        "actions": {
            "type": "array",
            "maxItems": 4,
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "action": {"type": "string", "enum": ["type", "click", "select"]},
                    "text": {"type": "string"},
                },
                "required": ["index", "action", "text"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["actions"],
    "additionalProperties": False,
}


def normalise(text: str) -> str:
    """The worker's own `normalise`, so the guard is measured as it is enforced."""
    text = text.lower()
    text = re.sub(r"[_\-.]+", " ", text)
    text = re.sub(r"[^a-z0-9@ ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def ask(model: str, goal: str, timeout: float, correction: str | None = None) -> tuple[list | None, float]:
    body = json.dumps(
        {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": PROMPT.format(
                        goal=goal,
                        fields="\n".join(f"{i}: {label} ({role})" for i, label, role in FIELDS),
                    ),
                }
            ],
            "max_tokens": 256,
            "temperature": 0,
            "reasoning_effort": "none",
            "chat_template_kwargs": {"enable_thinking": False},
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "plan", "schema": SCHEMA, "strict": True},
            },
        }
    ).encode()

    started = time.time()
    request = urllib.request.Request(
        ENDPOINT, data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
        return None, time.time() - started
    elapsed = time.time() - started

    content = (payload.get("choices") or [{}])[0].get("message", {}).get("content")
    if not content:
        return None, elapsed
    try:
        return (json.loads(content) or {}).get("actions"), elapsed
    except json.JSONDecodeError:
        return None, elapsed


STOP_WORDS = set(
    "a an and as at be by do for from i in into is it me my of on or that the then there this to with you your box button click enter field fill form input page press put select set submit type write".split()
)


def guard(case: dict, actions: list) -> tuple[list, str | None]:
    """
    `verify-plan.ts`, applied exactly.

    Returns the actions that survive, and -- when the *answer* is refused rather than one
    action in it -- why. Per-action faults drop that action and keep the rest; the collapse
    signals refuse everything; an answer with nothing left is refused.
    """
    offered = {i for i, _, _ in FIELDS}
    roles = {i: role for i, _, role in FIELDS}
    goal = normalise(case["goal"])
    kept: list = []
    dropped: list[str] = []

    for action in actions:
        index, verb, text = action["index"], action.get("action"), action["text"]

        if index not in offered:
            dropped.append("unknown-index")
            continue

        role = roles[index]
        wanted = {"click": "button", "type": "textbox", "select": "combobox"}.get(verb)
        if role != wanted:
            dropped.append("wrong-role")
            continue

        if verb == "click":
            kept.append(action)
            continue

        value = normalise(text)
        if value and value not in goal:
            dropped.append("invented-value")
            continue
        words = [w for w in value.split(" ") if w]
        if words and all(w in STOP_WORDS for w in words):
            dropped.append("not-a-value")
            continue
        label = next(lb for i, lb, _ in FIELDS if i == index)
        if value and value == normalise(label):
            dropped.append("echoed-label")
            continue

        kept.append(action)

    values = [normalise(a["text"]) for a in kept if a.get("action") in ("type", "select")]
    values = [v for v in values if v]

    counts: dict[str, int] = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    if counts and max(counts.values()) >= 3:
        return [], f"smeared over {max(counts.values())} fields"

    if len(values) >= 2:
        covered = sum(len(v) for v in values) / max(1, len(goal))
        if covered > 0.7:
            return [], f"shredded {covered:.0%} of the sentence"

    if not kept:
        return [], (dropped[0] if dropped else "nothing proposed")
    return kept, None


def judge(case: dict, actions: list | None) -> tuple[str, str]:
    """
    Four outcomes, and only one of them is unsafe.

      right    every action the sentence asked for, and nothing dropped
      partial  every action that ran was safe, and something the case wanted is missing.
               The agent reports this as `incomplete`, naming what was not done -- a
               truthful half-result, which is not the same as a failure and not the same
               as success
      esc      the whole answer was refused; the step escalates to a planner
      WRONG    an action ran that should not have

    Counting `partial` as a failure would say the system did nothing when it did most of the
    job and said so. Counting it as `right` would hide a model that never finishes.
    """
    if actions is None:
        return "esc", "no answer"

    kept, refused = guard(case, actions)
    if refused:
        return "esc", refused

    if not kept and not case.get("refuse"):
        return "esc", "declined"

    if case.get("refuse"):
        return ("right", "refused") if not kept else ("WRONG", f"typed into {len(kept)}")

    typed = {a["index"]: a["text"] for a in kept if a.get("action") == "type"}
    chosen = {a["index"]: a["text"] for a in kept if a.get("action") == "select"}
    clicked = {a["index"] for a in kept if a.get("action") == "click"}

    missing: list[str] = []
    for index, expected in (case.get("fill") or {}).items():
        if index not in typed:
            missing.append(f"[{index}] not filled")
        elif normalise(expected) not in normalise(typed[index]):
            return "WRONG", f"[{index}] got the wrong text"
    for index, expected in (case.get("select") or {}).items():
        if index not in chosen:
            missing.append(f"[{index}] not chosen")
        elif normalise(expected) not in normalise(chosen[index]):
            return "WRONG", f"[{index}] chose the wrong option"
    if case.get("click") and case["click"] not in clicked:
        missing.append(f"[{case['click']}] not clicked")

    dropped = len(actions) - len(kept)
    if missing:
        return "partial", f"did {len(kept)}, missing {', '.join(missing)}"
    return "right", "ok" if not dropped else f"ok ({dropped} dropped)"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="qwen3:0.6b")
    parser.add_argument("--timeout", type=float, default=60.0)
    args = parser.parse_args()

    print(f"\n  {args.model}\n")
    tally = {"right": 0, "partial": 0, "esc": 0, "WRONG": 0}
    total_ms = 0.0

    for case in CASES:
        actions, elapsed = ask(args.model, case["goal"], args.timeout)
        verdict, why = judge(case, actions)
        tally[verdict] += 1
        total_ms += elapsed * 1000
        mark = {"right": "ok  ", "partial": "part", "esc": "esc ", "WRONG": "BAD "}[verdict]
        label = case["goal"].replace(chr(10), " / ")
        print(f"  {mark} {elapsed:5.1f}s  {label[:52]:<54} {why}")
        if verdict != "right" and actions:
            print(f"         -> {json.dumps(actions)[:400]}")

    print()
    print(
        f"  {tally['right']} right, {tally['partial']} partial, {tally['esc']} escalated, "
        f"{tally['WRONG']} WRONG   ({total_ms / len(CASES) / 1000:.1f}s per call)"
    )
    print(
        "  WRONG is the column that decides safety: a plan the guard let through"
        " that does the wrong thing to the page."
    )
    print()


if __name__ == "__main__":
    main()
