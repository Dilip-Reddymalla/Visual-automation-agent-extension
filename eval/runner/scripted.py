"""A deterministic planner for the scenario suite.

## Why not the shipped stub

`server/planner.py`'s `StubPlanner` is the right thing for the demo and the wrong thing
here for one reason: it fills the first empty text box it finds with a canned email
address. On a page whose first empty box is a search field that turns every scenario into
a test of what happens when you search for `applicant@example.in`.

## Why not a model

A scenario suite that varies between runs cannot be a regression test. Every failure would
have to be re-run to find out whether it was the extension or the weather. So this is a
grammar over the element list and the plan the device sent -- no GPU, no weights, no
network -- and it returns the same actions for the same page every time.

It is still a *real* planner in the sense that matters: it sees exactly what the shipped
planner sees (the redacted element list, the manifest, the decomposition and its statuses)
and nothing else. If the payload does not carry enough to act on, this cannot act either,
which is the property the suite is testing.

## What it refuses to do

No purchases, no payment details, no account creation, no password entry. The fixtures
stop at a mock cart on purpose (eval/scenarios/README.md), and a `SECRET`-classed field is
never typed into -- the extension would refuse it anyway (invariant 6), and a harness that
tried would be testing the refusal rather than the flow.
"""

from __future__ import annotations

import json
import re
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

#: Buttons that carry a page forward. Imported from the shipped planner rather than
#: restated, so the suite and the demo agree about what "advancing" means.
def _advancing_pattern() -> re.Pattern:
    server = str(ROOT / "server")
    if server not in sys.path:
        sys.path.insert(0, server)
    from planner import ADVANCING_BUTTON  # noqa: PLC0415 -- deferred so import order is simple

    return ADVANCING_BUTTON


#: Fields nothing here will ever type into, whatever the page calls them.
NEVER_TYPE = re.compile(r"\b(password|passcode|otp|cvv|pin|secret|card number)\b", re.I)

#: How the device names a search control, in the roles the wire format has.
SEARCHY = re.compile(r"\bsearch\b", re.I)


def _quoted_or_after(goal: str) -> str | None:
    """The term the goal asked to search for, if it said.

    `search for phones` gives `phones`. Nothing clever: the scenario goals are written in
    this shape on purpose, and a planner that guessed harder would be guessing about the
    harness rather than about the page.
    """
    match = re.search(r"\b(?:search|look)\s+(?:for|up)\s+([^,.;]+)", goal, re.I)
    if not match:
        return None
    term = match.group(1).strip()
    # Stop at the next instruction: "search for phones and add one" is not a search for
    # "phones and add one".
    term = re.split(r"\b(?:and|then)\b", term, maxsplit=1)[0].strip()
    return term or None


#: Words too common to identify a control. Short on purpose: a longer list starts
#: deciding which of the user's own words matter.
STOPWORDS = frozenset(
    "the a an and or of to for in on at by with it its this that them one my me your "
    "then next please".split()
)


def _words(text: str) -> set[str]:
    """Words worth matching a control on."""
    return {
        w
        for w in re.split(r"[^a-z0-9]+", text.lower())
        if len(w) >= 3 and w not in STOPWORDS
    }


def _elements(step: dict) -> list[dict]:
    return [e for e in step.get("elements", []) if e.get("index") is not None]


def _active_leg(step: dict) -> dict | None:
    return next((leg for leg in step.get("plan", []) if leg.get("status") == "active"), None)


def _plan_done(step: dict) -> bool:
    plan = step.get("plan", [])
    if not plan:
        return False
    return all(leg.get("status") in ("done", "skipped", "failed") for leg in plan)


class ScenarioPlanner:
    """One instance per suite run. Keeps just enough memory to notice a loop."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        #: session -> (what the page looked like, what we did about it) last time.
        self.last: dict[str, tuple[str, str]] = {}

    def __call__(self, step: dict) -> dict:
        with self.lock:
            return self._plan(step)

    def _plan(self, step: dict) -> dict:
        goal = str(step.get("goal", ""))
        session = str(step.get("sessionId", ""))
        elements = _elements(step)
        leg = _active_leg(step)

        actions, rationale, done = self._choose(goal, elements, leg, step)

        # One step of memory. The planner is otherwise a pure function of the page, so
        # once the page stops responding it re-derives the same action for ever. Saying so
        # is a better end to a run than riding the step budget down to zero.
        fingerprint = json.dumps(elements, sort_keys=True)
        move = json.dumps(actions, sort_keys=True)
        if self.last.get(session) == (fingerprint, move):
            actions = [
                {
                    "type": "finish",
                    "status": "blocked",
                    "summary": "the page did not change after the last action",
                }
            ]
            rationale = "repeating myself against an unchanged page"
            done = True
        self.last[session] = (fingerprint, move)

        return {
            "protocolVersion": step.get("protocolVersion", 1),
            "stepIndex": step.get("stepIndex", 0),
            "rationale": rationale,
            "actions": actions,
            "done": done,
        }

    def _choose(
        self, goal: str, elements: list[dict], leg: dict | None, step: dict
    ) -> tuple[list[dict], str, bool]:
        kind = (leg or {}).get("kind", "")

        # The device's own decomposition says the task is over. It is the thing that has
        # been watching the page all along; agreeing with it is not laziness.
        if _plan_done(step):
            return (
                [{"type": "finish", "status": "success", "summary": "every leg finished"}],
                "the plan the device sent has no legs left",
                True,
            )

        # An open listbox is a page waiting on an answer.
        option = next((e for e in elements if e.get("role") == "option"), None)
        if option is not None:
            return ([{"type": "click", "index": option["index"]}], "choosing an open option", False)

        # A search the goal named, and a box to put it in.
        term = _quoted_or_after(goal)
        if term and kind in ("", "search", "filter"):
            box = next(
                (
                    e
                    for e in elements
                    if e.get("role") in ("searchbox", "textbox")
                    and not e.get("state", {}).get("filled")
                    and (
                        e.get("role") == "searchbox"
                        or SEARCHY.search(e.get("name", "") or "")
                    )
                    and not NEVER_TYPE.search(e.get("name", "") or "")
                ),
                None,
            )
            if box is not None:
                return (
                    [{"type": "type", "index": box["index"], "text": term, "submit": False}],
                    f"searching for what the goal named, in [{box['index']}]",
                    False,
                )

        # Reading is reading. An `inspect` leg is the one read-only kind in the
        # vocabulary (shared/contract.ts), and the first version of this planner answered
        # it by clicking the first link -- which navigated off the results page the leg
        # existed to read, and took the run with it. Looking further down the page is what
        # inspecting means; the leg carries no criteria, so one step of it is enough.
        if kind == "inspect":
            return ([{"type": "scroll", "dx": 0, "dy": 400}], "reading what is on offer", False)

        # Choosing: the things worth choosing between are the links.
        if kind == "select":
            link = next((e for e in elements if e.get("role") == "link"), None)
            if link is not None:
                return (
                    [{"type": "click", "index": link["index"]}],
                    f"opening [{link['index']}] to look at it",
                    False,
                )

        # Acting on the thing the leg names.
        #
        # The leg's `intent` is the user's own clause -- "add it to the cart" -- and the
        # control that carries it out usually shares a word with it. That is a weaker
        # signal than a model reading the page, and it is the strongest one available to a
        # grammar; without it the planner fell back to scrolling and a two-stage form was
        # never opened at all.
        if kind in ("interact", "submit", "confirm") and leg is not None:
            intent = leg.get("intent", "")

            # A leg that names a value wants it typed, not clicked. "fill reference
            # number with AB1234" splits into a field ("reference number") and a value,
            # and the field half is what identifies the box. Without this the planner
            # fell through to clicking, then to scrolling, and a two-stage form was
            # opened and then never filled in.
            value_at = re.search(r"\b(?:with|as|=|:)\s+(.+)$", intent, re.I)
            if value_at is not None:
                field = _words(intent[: value_at.start()])
                box = next(
                    (
                        e
                        for e in elements
                        if e.get("role") in ("textbox", "searchbox", "combobox")
                        and not e.get("state", {}).get("filled")
                        and not NEVER_TYPE.search(e.get("name", "") or "")
                        and field & _words(e.get("name", "") or "")
                    ),
                    None,
                )
                if box is not None:
                    return (
                        [
                            {
                                "type": "type",
                                "index": box["index"],
                                "text": value_at.group(1).strip(),
                                "submit": False,
                            }
                        ],
                        f"[{box['index']}] is the field the leg names",
                        False,
                    )

            wanted = _words(intent)
            match = next(
                (
                    e
                    for e in elements
                    if e.get("role") in ("button", "link", "checkbox", "radio")
                    and not NEVER_TYPE.search(e.get("name", "") or "")
                    and wanted & _words(e.get("name", "") or "")
                ),
                None,
            )
            if match is not None:
                return (
                    [{"type": "click", "index": match["index"]}],
                    f"[{match['index']}] is named after the leg",
                    False,
                )

        # Anything that carries the page forward.
        advancing = _advancing_pattern()
        button = next(
            (
                e
                for e in elements
                if e.get("role") == "button" and advancing.search(e.get("name", "") or "")
            ),
            None,
        )
        if button is not None:
            return (
                [{"type": "click", "index": button["index"]}],
                f"clicking [{button['index']}], which carries the page forward",
                False,
            )

        # The form may simply continue below the fold, where perception correctly cannot
        # see it. Only when the page showed something: scrolling an empty page helps nobody.
        if elements:
            return ([{"type": "scroll", "dx": 0, "dy": 600}], "looking further down", False)

        return (
            [{"type": "finish", "status": "blocked", "summary": "nothing actionable on the page"}],
            "no elements to act on",
            True,
        )
