"""Driving one corpus page through one perception cycle, and keeping everything it made.

The shape of a page run:

  1. Open the page in its own tab, with the viewport forced to the size the labels were
     measured at. A box is only ground truth for the layout it was measured against.
  2. Photograph the page *before* the extension touches it. That clean frame is what the
     sealed frame is diffed against later, and it is how over-redaction gets measured in
     pixels rather than inferred from the manifest's own arithmetic.
  3. Start a task. RUN_TASK is sent from an extension page, never from the worker: a
     runtime message a worker sends to itself is never delivered, because Chrome fans out
     to every extension context except the sender.
  4. Wait for the step to end, which the worker announces by writing one trace line.
  5. Take the POST the planner recorded -- findings, manifest, elements, sealed pixels --
     and the trace, and write them next to each other.

What is deliberately *not* done here is any scoring. This module produces evidence;
metrics.py decides what it means. Keeping those apart is what makes it possible to
re-score a run without re-running it, which during a tuning week is the difference
between a twenty-second loop and a twenty-minute one.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path

# The corpus was rendered at this size (eval/corpus/generate.py, VIEWPORT).
VIEWPORT = {"width": 1280, "height": 800}

# How long one page gets. A step that takes longer than this has not gone slowly, it has
# gone wrong, and waiting longer only delays finding out.
STEP_TIMEOUT_S = 45.0


@dataclass
class PageRun:
    page_id: str
    url: str
    ok: bool
    note: str = ""
    trace: dict | None = None
    step: dict | None = None
    sealed: bytes = b""
    clean: bytes = b""
    capture_meta: dict = field(default_factory=dict)
    host_stats: dict = field(default_factory=dict)
    heap: dict = field(default_factory=dict)
    wall_ms: float = 0.0


class Driver:
    """Everything that outlives a single page: the browser, the extension, the driver tab."""

    def __init__(self, context, extension_id: str, worker, planner, port: int) -> None:
        self.context = context
        self.extension_id = extension_id
        self.worker = worker
        self.planner = planner
        self.port = port
        self.traces: list[dict] = []
        self._console_buffer: list[str] = []

        worker.on("console", self._on_console)

        # An extension page kept open for the whole run, so every RUN_TASK has a sender
        # that is not the worker.
        self.driver_page = context.new_page()
        self.driver_page.goto(
            f"chrome-extension://{extension_id}/popup.html", wait_until="load"
        )

    # -- worker console --------------------------------------------------------

    def _on_console(self, message) -> None:
        text = message.text
        self._console_buffer.append(text)
        if text.startswith('{"traceVersion"'):
            try:
                self.traces.append(json.loads(text))
            except json.JSONDecodeError:
                pass

    def _trace_for(self, session_id: str) -> dict | None:
        for trace in reversed(self.traces):
            if trace.get("sessionId") == session_id:
                return trace
        return None

    # -- extension calls -------------------------------------------------------

    def _send(self, page, message_type: str, payload: dict, to: str = "worker",
              tab_id: int | None = None):
        """Put one envelope on the bus by hand.

        The envelope shape is shared/messages.ts's `Envelope`, and building it here
        rather than driving the popup's buttons is deliberate: the harness is exercising
        the protocol, and a UI change should not silently change what the eval measures.
        """
        envelope = {
            "id": f"harness-{int(time.time() * 1000)}",
            "from": "popup",
            "to": to,
            "sentAt": int(time.time() * 1000),
            "type": message_type,
            "payload": payload,
        }
        if tab_id is not None:
            envelope["tabId"] = tab_id
        return page.evaluate(
            """async (envelope) => await new Promise((resolve) =>
                 chrome.runtime.sendMessage(envelope, (reply) =>
                   resolve(chrome.runtime.lastError
                     ? { ok: false, error: { message: chrome.runtime.lastError.message } }
                     : reply)))""",
            envelope,
        )

    def host_stats(self) -> dict:
        try:
            reply = self._send(self.driver_page, "HOST_STATS", {}, to="offscreen")
            return reply.get("result", {}) if isinstance(reply, dict) else {}
        except Exception:
            return {}

    def stop(self) -> None:
        try:
            self._send(self.driver_page, "STOP", {})
        except Exception:
            pass

    # -- one page --------------------------------------------------------------

    def run_page(self, page_id: str, url: str, goal: str) -> PageRun:
        started = time.time()
        tab = self.context.new_page()
        try:
            tab.set_viewport_size(VIEWPORT)
            tab.goto(url, wait_until="load")
            # Let the content script attach and the page settle. The extension's own
            # settle detector waits 250 ms of DOM quiet; this is the same order.
            tab.wait_for_timeout(350)
            tab.bring_to_front()
            tab.wait_for_timeout(150)

            clean = tab.screenshot()

            tab_id = self.worker.evaluate(
                """async () => {
                     const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
                     return t ? t.id : null;
                   }"""
            )
            if tab_id is None:
                return PageRun(page_id, url, False, "no active tab to run against",
                               clean=clean)

            before = len(self.traces)
            reply = self._send(self.driver_page, "RUN_TASK", {"goal": goal, "tabId": tab_id})
            if not isinstance(reply, dict) or not reply.get("ok"):
                note = "RUN_TASK refused"
                if isinstance(reply, dict):
                    note = f"RUN_TASK refused: {reply.get('error', {}).get('message', '')}"
                return PageRun(page_id, url, False, note, clean=clean)

            session_id = reply["result"]["sessionId"]

            # The JS heap is read while the step is in flight, because that is when it is
            # largest and the whole point is the peak.
            heap = _heap_snapshot(self.context, self.extension_id, self.port)

            trace = self._await_trace(session_id, before)

            # Host stats are read *after* the step, and that is a correction rather than a
            # preference. Read before it, as this was, the offscreen document has not
            # loaded anything yet: every run reported backend "none", zero resident model
            # bytes and no warm-inference timings at all -- which made `detect`, the stage
            # that turned out to be 93% of the step, the one stage with nothing inside it.
            #
            # After the trace the session has not ended yet (sessions unload 60 idle
            # seconds later), so the models are still resident and the timing ring still
            # holds what they cost.
            host_stats = self.host_stats()

            steps = self.planner.recorder.take()

            self.stop()

            if trace is None:
                return PageRun(page_id, url, False, "the step never finished", clean=clean,
                               host_stats=host_stats, heap=heap,
                               wall_ms=(time.time() - started) * 1000)

            if not steps:
                # No POST. Two very different things look like this, and calling both a
                # failure cost an afternoon: a step that fell over before the plan phase,
                # and a step the *device answered on its own* -- no screenshot, no gate,
                # nothing sent, which is the behaviour this whole project is for.
                #
                # Neither can be scored here, because the corpus metrics are computed from
                # the sealed payload and a device-only step never makes one. But only one
                # of them is a defect, and the report has to be able to say which.
                phase = trace.get("events", [])
                last = phase[-1]["phase"] if phase else "?"
                local = trace.get("outcome") == "ok" and not trace.get("sent", True)
                tier = (trace.get("tier") or {}).get("tier")
                note = (
                    f"answered on the device (tier {tier}); nothing was sealed, so there "
                    "is nothing for the corpus metrics to score"
                    if local
                    else (
                        f"no step reached the planner (last phase {last}: "
                        f"{trace.get('error', 'unknown')})"
                    )
                )
                return PageRun(
                    page_id, url, False, note,
                    trace=trace, clean=clean, host_stats=host_stats, heap=heap,
                    wall_ms=(time.time() - started) * 1000,
                )

            recorded = steps[-1]
            return PageRun(
                page_id=page_id, url=url, ok=trace.get("outcome") == "ok",
                note=trace.get("error", ""), trace=trace, step=recorded.step,
                sealed=recorded.image, clean=clean,
                capture_meta=recorded.step.get("capture", {}),
                host_stats=host_stats, heap=heap,
                wall_ms=(time.time() - started) * 1000,
            )
        finally:
            try:
                tab.close()
            except Exception:
                pass

    def _await_trace(self, session_id: str, before: int) -> dict | None:
        """Wait for the worker to emit this step's trace line.

        The wait is `wait_for_timeout`, not `time.sleep`, and that is not a style
        preference. Playwright's sync API dispatches events only while the caller is
        inside a Playwright call; a bare sleep blocks the pump, so console messages queue
        up and arrive in a burst when the loop finally exits. That produced a step which
        genuinely finished in 806 ms and a harness that declared it dead 60 s later --
        with the trace sitting in the buffer, correct and complete, the whole time.

        Diagnosing it from the outside was misleading in a specific way: the extension
        was blameless, the step log said `ok`, and every symptom pointed at the browser.
        """
        deadline = time.time() + STEP_TIMEOUT_S
        while time.time() < deadline:
            for trace in self.traces[before:]:
                if trace.get("sessionId") == session_id:
                    return trace
            # Yields to the event loop, which is the entire point.
            self.driver_page.wait_for_timeout(50)
        return None


def _heap_snapshot(context, extension_id: str, port: int) -> dict:
    """JS heap across the extension's contexts, at the moment a step is running."""
    from . import cdp, resources

    per = resources.js_heap_bytes(context, extension_id)
    worker_bytes = cdp.worker_heap_bytes(port, extension_id)
    if worker_bytes:
        per["byContext"]["worker"] = worker_bytes
        per["totalBytes"] = sum(per["byContext"].values())
    return per


def write_artifacts(out: Path, run: PageRun) -> None:
    """One directory per page, holding everything the run produced.

    Written even for a failure, and especially then: a page that produced no findings and
    no explanation is the one case where a report can be confidently wrong.
    """
    folder = out / run.page_id
    folder.mkdir(parents=True, exist_ok=True)

    summary = {
        "id": run.page_id,
        "url": run.url,
        "ok": run.ok,
        "note": run.note,
        "wallMs": round(run.wall_ms, 1),
        "capture": run.capture_meta,
        "hostStats": run.host_stats,
        "heap": run.heap,
    }
    (folder / "run.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    if run.trace is not None:
        (folder / "trace.json").write_text(json.dumps(run.trace, indent=2), encoding="utf-8")
    if run.step is not None:
        (folder / "step.json").write_text(json.dumps(run.step, indent=2), encoding="utf-8")
        (folder / "manifest.json").write_text(
            json.dumps(run.step.get("manifest", {}), indent=2), encoding="utf-8"
        )
    if run.sealed:
        mime = run.capture_meta.get("mime", "image/webp")
        ext = {"image/webp": "webp", "image/png": "png", "image/jpeg": "jpg"}.get(mime, "bin")
        (folder / f"sealed.{ext}").write_bytes(run.sealed)
    if run.clean:
        (folder / "clean.png").write_bytes(run.clean)
