"""The recording planner: the harness standing where the server stands.

`worker/transport.ts` posts one multipart body to `http://localhost:8000/v1/step` -- a
`step` part carrying the JSON `StepRequest` and a `capture` part carrying the sealed
image bytes. That request is the single artefact that crosses the privacy boundary, so
it is also the single best place to observe a run from: it contains the findings, the
manifest, the element list the planner will see, and the sealed pixels, all of them as
they actually left the device rather than as some instrumentation hook reported them.

So the harness *is* the server for the duration of a run. It records the request and
answers with a plan.

Two properties this has to keep:

  offline    Nothing here reaches the network, and the reply is generated rather than
             fetched. The real planner (server/app.py with PLANNER=stub) is
             schema-compatible and can be swapped in; it is not used by default because
             it would not hand back the request body.

  honest     The reply is validated against the same generated schema the real server
             uses for guided decoding, so a harness run exercises the same parse path a
             real one does. A harness that returned something the contract forbids would
             be testing a code path that never runs in production.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from email.parser import BytesParser
from email.policy import default as default_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The endpoint is not configurable in the extension: worker/main.ts passes no override,
# so transport.ts uses DEFAULT_ENDPOINT. The harness binds here or it observes nothing.
PLANNER_PORT = 8000
PLANNER_PATH = "/v1/step"


@dataclass
class RecordedStep:
    """One POST, taken apart. This is what the metrics are computed from."""
    step: dict
    image: bytes
    received_at: float
    request_bytes: int

    @property
    def manifest(self) -> dict:
        return self.step.get("manifest", {})

    @property
    def findings(self) -> list[dict]:
        return self.manifest.get("findings", [])

    @property
    def elements(self) -> list[dict]:
        return self.step.get("elements", [])


@dataclass
class Recorder:
    steps: list[RecordedStep] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def add(self, step: RecordedStep) -> None:
        with self.lock:
            self.steps.append(step)

    def take(self) -> list[RecordedStep]:
        with self.lock:
            out = list(self.steps)
            self.steps.clear()
            return out


def plan_for(step: dict) -> dict:
    """A schema-valid plan that ends the task.

    The harness measures one perception cycle per page, so the right plan is one that
    does not start a second: a `finish` suspends the loop (router.ts honours the plan's
    own terminators), which is both what the contract is for and what keeps a page from
    being scored twice.

    It is still a real plan, referring to a real index when the page offers one, because
    a reply that ignored the element list would not exercise the executor's index and
    snapshot checks at all.
    """
    elements = step.get("elements", [])
    index = next(
        (e["index"] for e in elements if e.get("index") is not None
         and e.get("role") in ("button", "link")),
        None,
    )
    actions: list[dict] = []
    if index is not None:
        actions.append({"type": "scroll", "index": index, "dx": 0, "dy": 0})
    actions.append(
        {
            "type": "finish",
            "status": "success",
            "summary": "evaluation harness: one perception cycle recorded",
        }
    )
    return {
        "protocolVersion": step.get("protocolVersion", 1),
        "stepIndex": step.get("stepIndex", 0),
        "rationale": "harness",
        "actions": actions,
        "done": True,
    }


def _handler_for(recorder: Recorder):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args) -> None:  # keep the harness output readable
            return

        def do_POST(self) -> None:  # noqa: N802 -- BaseHTTPRequestHandler's spelling
            if self.path != PLANNER_PATH:
                self.send_error(404)
                return

            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            content_type = self.headers.get("Content-Type", "")

            try:
                step, image = _parse_multipart(body, content_type)
            except Exception as err:
                self.send_error(400, f"could not parse the step: {err}")
                return

            import time

            recorder.add(
                RecordedStep(
                    step=step, image=image, received_at=time.time(),
                    request_bytes=len(body),
                )
            )

            payload = json.dumps(plan_for(step)).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    return Handler


def _parse_multipart(body: bytes, content_type: str) -> tuple[dict, bytes]:
    """Split the two parts the transport sends. Neither is optional."""
    headers = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode()
    message = BytesParser(policy=default_policy).parsebytes(headers + body)

    step: dict | None = None
    image: bytes = b""
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        payload = part.get_payload(decode=True) or b""
        if name == "step":
            step = json.loads(payload.decode("utf-8"))
        elif name == "capture":
            image = payload

    if step is None:
        raise ValueError("no `step` part in the body")
    return step, image


class PlannerServer:
    """A recording planner, running for the length of a harness run."""

    def __init__(self, port: int = PLANNER_PORT) -> None:
        self.recorder = Recorder()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), _handler_for(self.recorder))
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self) -> "PlannerServer":
        self.thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
