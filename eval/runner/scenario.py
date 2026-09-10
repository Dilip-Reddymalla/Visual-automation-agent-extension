"""Driving one whole multi-step task through a real Chrome, and keeping the evidence.

`run.py` drives *one perception cycle* per page, which is what the corpus metrics need. A
scenario is the other thing: a goal, a session that lasts as long as the agent thinks it
needs to, and a verdict at the end that has to be earned rather than assumed.

## What counts as evidence

Three things, and a scenario passes only if they agree:

  the agent's own state   the progress ledger and the decomposition, read straight out of
                          `chrome.storage.session`. Statuses and counts, not prose.
  the page                assertions evaluated in the tab after the run -- did the cart
                          actually receive an item, is the status line actually showing.
  the screenshots         one per checkpoint, for a person to look at.

The screenshots are deliberately last on that list. E3's rule is that a picture is not
proof unless it is paired with structured verification, and the reverse mistake -- a suite
that passes because it collected artefacts -- is the easier one to make.

## Checkpoints

A screenshot is taken at the start, at every step boundary the worker announces, and at
the end (or the failure). Step boundaries are found by watching the step log grow rather
than by polling on a timer, so a fast run produces few frames and a slow one does not
produce hundreds.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path

#: The scenarios were written against this size. A box is only ground truth for the
#: layout it was measured at, and a screenshot is only comparable to another at the same
#: viewport.
VIEWPORT = {"width": 1280, "height": 900}

#: How long one scenario gets before it is called stuck. Generous: a run is up to
#: MAX_STEPS steps, each of which may perceive, capture, detect, seal, plan and execute.
SCENARIO_TIMEOUT_S = 180.0

#: How often the agent's state is read while a run is in flight.
POLL_MS = 200

#: A cap, so a pathological run cannot fill a disk with pictures of the same page.
MAX_SHOTS = 24


@dataclass
class Checkpoint:
    """One moment worth a picture, and what the agent had done by then."""

    name: str
    at_ms: float
    step_index: int
    status: str
    phase: str
    note: str = ""
    shot: str = ""


@dataclass
class ScenarioResult:
    scenario_id: str
    goal: str
    url: str
    ok: bool
    #: Why, in one line. Never page content.
    verdict: str = ""
    status: str = ""
    steps: int = 0
    #: What the agent believed about its own progress, at the end.
    progress: dict = field(default_factory=dict)
    #: One entry per step the worker logged: index, outcome, phase, note.
    log: list = field(default_factory=list)
    #: Per-step traces the worker printed.
    traces: list = field(default_factory=list)
    checkpoints: list = field(default_factory=list)
    #: Assertions evaluated against the page after the run.
    checks: list = field(default_factory=list)
    #: What actually crossed the network, per step, without the image bytes.
    #:
    #: Kept because it is the only record of what the planner was shown, and because the
    #: privacy scenarios scan it: a value that must never leave the device would show up
    #: here first. It is safe to store for exactly the reason it was safe to send -- it
    #: has already been through the gate.
    posted: list = field(default_factory=list)
    wall_ms: float = 0.0
    failures: list = field(default_factory=list)


@dataclass
class Scenario:
    """One task, one page, and what has to be true afterwards."""

    id: str
    page: str
    goal: str
    #: Group name, for the report. See eval/scenarios/README.md.
    group: str = ""
    #: JS expressions evaluated in the tab afterwards; each must return true.
    #: Written as `(name, expression)` so a failure names itself.
    page_checks: list = field(default_factory=list)
    #: Statuses the run may legitimately end in. A scenario that can only pass by ending
    #: `stopped` is saying something different from one that must reach `success`.
    accept_status: tuple = ("stopped",)
    #: Leg ids that must have finished, when the scenario is about the decomposition.
    require_legs_done: tuple = ()
    #: Leg ids that must *not* be reported as finished.
    forbid_legs_done: tuple = ()
    #: Substrings that must never appear anywhere in the artefacts.
    forbid_in_artefacts: tuple = ()
    timeout_s: float = SCENARIO_TIMEOUT_S


class ScenarioDriver:
    """A session driver that lets the agent run to its own conclusion."""

    def __init__(self, driver, out: Path) -> None:
        # Reuses run.Driver for the bus plumbing: the envelope shape, the extension page
        # that RUN_TASK is sent from, and the worker console that traces arrive on.
        self.driver = driver
        self.out = out

    # -- reading the agent -----------------------------------------------------

    def _state(self) -> dict:
        """The whole agent record, from the one key it lives under."""
        try:
            record = self.driver.worker.evaluate(
                """async () => {
                     const all = await chrome.storage.session.get('agent-state');
                     return all['agent-state'] ?? null;
                   }"""
            )
            return record or {}
        except Exception:
            return {}

    # -- one scenario ----------------------------------------------------------

    def run(self, scenario: Scenario, url: str) -> ScenarioResult:
        started = time.time()
        folder = self.out / scenario.id
        folder.mkdir(parents=True, exist_ok=True)

        result = ScenarioResult(
            scenario_id=scenario.id, goal=scenario.goal, url=url, ok=False
        )
        tab = self.driver.context.new_page()
        try:
            tab.set_viewport_size(VIEWPORT)
            tab.goto(url, wait_until="load")
            tab.wait_for_timeout(350)
            tab.bring_to_front()
            tab.wait_for_timeout(150)

            self._shoot(tab, folder, result, "initial", started, {})

            tab_id = self.driver.worker.evaluate(
                """async () => {
                     const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
                     return t ? t.id : null;
                   }"""
            )
            if tab_id is None:
                result.verdict = "no active tab to run against"
                result.failures.append(result.verdict)
                return result

            before_traces = len(self.driver.traces)
            reply = self.driver._send(
                self.driver.driver_page, "RUN_TASK", {"goal": scenario.goal, "tabId": tab_id}
            )
            if not isinstance(reply, dict) or not reply.get("ok"):
                message = ""
                if isinstance(reply, dict):
                    message = reply.get("error", {}).get("message", "")
                result.verdict = f"RUN_TASK refused: {message}"
                result.failures.append(result.verdict)
                return result

            session_id = reply["result"]["sessionId"]
            state = self._watch(tab, folder, result, scenario, started)

            result.status = str(state.get("status", "?"))
            result.steps = int(state.get("stepIndex", 0))
            result.progress = state.get("progress", {}) or {}
            result.log = state.get("log", []) or []
            result.traces = [
                t
                for t in self.driver.traces[before_traces:]
                if t.get("sessionId") == session_id
            ]

            result.posted = [
                {
                    "stepIndex": r.step.get("stepIndex"),
                    "elements": r.step.get("elements", []),
                    "plan": r.step.get("plan", []),
                    "intents": r.step.get("intents", []),
                    "goal": r.step.get("goal"),
                    "manifest": {
                        "counts": r.manifest.get("counts", {}),
                        "redactedFraction": r.manifest.get("redactedFraction"),
                        "overRedactedFraction": r.manifest.get("overRedactedFraction"),
                        "findings": [
                            {k: f.get(k) for k in ("cls", "layer", "mode", "reason", "placeholder")}
                            for f in r.findings
                        ],
                    },
                    "imageBytes": len(r.image),
                }
                for r in self.driver.planner.recorder.take()
            ]

            self._shoot(tab, folder, result, "final", started, state)
            result.checks = self._check_page(tab, scenario)
            self._judge(scenario, result)
        except Exception as err:  # noqa: BLE001 -- a broken scenario is a result, not a crash
            result.verdict = f"harness error: {type(err).__name__}: {err}"
            result.failures.append(result.verdict)
        finally:
            self.driver.stop()
            result.wall_ms = (time.time() - started) * 1000
            try:
                tab.close()
            except Exception:
                pass
            self._write(folder, result)
        return result

    # -- watching --------------------------------------------------------------

    def _watch(
        self,
        tab,
        folder: Path,
        result: ScenarioResult,
        scenario: Scenario,
        started: float,
    ) -> dict:
        """Poll the agent record until the run ends, photographing step boundaries.

        `wait_for_timeout` rather than `time.sleep`, and for the reason run.py records:
        Playwright's sync API only pumps events while the caller is inside a Playwright
        call, so a bare sleep makes console messages -- and therefore traces -- arrive in
        a burst at the end.
        """
        deadline = time.time() + scenario.timeout_s
        seen_steps = 0
        state: dict = {}

        while time.time() < deadline:
            state = self._state()
            log = state.get("log", []) or []
            finished = [e for e in log if e.get("outcome") is not None]

            if len(finished) > seen_steps:
                for entry in finished[seen_steps:]:
                    self._shoot(
                        tab,
                        folder,
                        result,
                        f"step-{entry.get('stepIndex', '?')}-{entry.get('outcome', '?')}",
                        started,
                        state,
                        note=str(entry.get("note", ""))[:400],
                    )
                seen_steps = len(finished)

            if state.get("status") in ("stopped", "failed", "incomplete", "idle"):
                return state

            self.driver.driver_page.wait_for_timeout(POLL_MS)

        result.failures.append(f"the run did not end within {scenario.timeout_s:.0f}s")
        self._shoot(tab, folder, result, "timeout", started, state)
        return state or self._state()

    # -- evidence --------------------------------------------------------------

    def _shoot(
        self,
        tab,
        folder: Path,
        result: ScenarioResult,
        name: str,
        started: float,
        state: dict,
        note: str = "",
    ) -> None:
        if len(result.checkpoints) >= MAX_SHOTS:
            return
        shot = ""
        try:
            path = folder / f"{len(result.checkpoints):02d}-{name}.png"
            tab.screenshot(path=str(path))
            shot = path.name
        except Exception:
            # A tab that navigated out from under the screenshot is not a scenario
            # failure. The checkpoint is still recorded, without a picture.
            shot = ""
        result.checkpoints.append(
            Checkpoint(
                name=name,
                at_ms=round((time.time() - started) * 1000, 1),
                step_index=int(state.get("stepIndex", 0) or 0),
                status=str(state.get("status", "")),
                phase=str(state.get("phase", "")),
                note=note,
                shot=shot,
            ).__dict__
        )

    def _check_page(self, tab, scenario: Scenario) -> list:
        """Ask the page itself what happened. The half a screenshot cannot prove."""
        out = []
        for name, expression in scenario.page_checks:
            try:
                value = bool(tab.evaluate(f"() => !!({expression})"))
                out.append({"name": name, "ok": value})
            except Exception as err:  # noqa: BLE001
                out.append({"name": name, "ok": False, "error": str(err)[:200]})
        return out

    # -- the verdict -----------------------------------------------------------

    def _judge(self, scenario: Scenario, result: ScenarioResult) -> None:
        """A scenario passes only when every kind of evidence agrees."""
        failures = result.failures

        if result.status not in scenario.accept_status:
            failures.append(
                f"ended {result.status!r}, expected one of {list(scenario.accept_status)}"
            )

        legs = {leg.get("id"): leg for leg in (result.progress.get("plan") or [])}
        for leg_id in scenario.require_legs_done:
            if legs.get(leg_id, {}).get("status") != "done":
                failures.append(
                    f"leg {leg_id} is {legs.get(leg_id, {}).get('status', 'absent')!r}, not done"
                )
        for leg_id in scenario.forbid_legs_done:
            if legs.get(leg_id, {}).get("status") == "done":
                failures.append(f"leg {leg_id} reported done, and the page disagrees")

        for check in result.checks:
            if not check.get("ok"):
                failures.append(f"page check {check['name']!r} did not hold")

        if scenario.forbid_in_artefacts:
            blob = json.dumps(
                {
                    "progress": result.progress,
                    "log": result.log,
                    "traces": result.traces,
                    "checkpoints": result.checkpoints,
                    # The strongest of the four: this is what actually left the machine.
                    "posted": result.posted,
                },
                ensure_ascii=False,
            )
            for secret in scenario.forbid_in_artefacts:
                if secret in blob:
                    failures.append(f"a value that must not be recorded appeared: {secret[:8]}...")

        result.ok = not failures
        result.verdict = result.verdict or (
            "every check held" if result.ok else "; ".join(failures[:4])
        )

    def _write(self, folder: Path, result: ScenarioResult) -> None:
        """One report per scenario, beside its screenshots."""
        payload = {
            "id": result.scenario_id,
            "goal": result.goal,
            "url": result.url,
            "ok": result.ok,
            "verdict": result.verdict,
            "status": result.status,
            "steps": result.steps,
            "wallMs": round(result.wall_ms, 1),
            "progress": result.progress,
            "log": result.log,
            "checks": result.checks,
            "checkpoints": result.checkpoints,
            "failures": result.failures,
            "traces": result.traces,
            "posted": result.posted,
        }
        (folder / "scenario.json").write_text(
            json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
        )
