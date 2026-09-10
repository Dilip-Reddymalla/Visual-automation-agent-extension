"""HTTP surface for the planner.

One endpoint, POST /v1/step. It receives a screenshot that has already been through the
redaction gate plus the manifest describing what was removed, and returns typed actions
that refer to element indices and placeholders.

The server never sees a raw pixel and never sees a value. If it ever needs one, the
design is wrong.

schema.json and schema.request.json are generated from extension/src/shared/contract.ts
by `npm run schema:gen`. They are loaded, never re-declared: a second copy of the
contract is a second contract.

What the server keeps, and what it refuses to keep. A session holds placeholders and
indices -- tokens, not values, because tokens are all it ever receives. Request bodies
are never persisted and never logged. The trace records timings, sizes, action types and
outcomes; an element's name or a field's value would be user data reaching disk on the
one machine in this architecture that was never supposed to hold any.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from planner import (
    Planner,
    RoutingPlanner,
    VlmPlanner,
    build_user_message,
    needs_image,
)


def planner_location() -> str:
    """Is this planner on the same machine as the browser, or a different one?

    Redaction protects data from a planner that is somewhere else. Run the planner on the
    same laptop and every piece of that machinery still works and protects nobody -- which
    is a fine way to develop and a dishonest thing to demonstrate. So the deployment says
    which it is, out loud, and the panel repeats it.

    Loopback is the only case we can be sure about; anything else is named rather than
    assumed, because a bind address is not proof of distance.
    """
    host = os.environ.get("PLANNER_HOST", "").strip()
    if host:
        return f"remote - {host}"
    return "local (development)"


#: Log the rendered prompt and the resulting plan for every step. Debugging only.
DEBUG_PROMPT = os.environ.get("PLANNER_DEBUG_PROMPT", "").lower() in ("1", "true", "yes")

SCHEMA_DIR = Path(__file__).parent
RESPONSE_SCHEMA = SCHEMA_DIR / "schema.json"
REQUEST_SCHEMA = SCHEMA_DIR / "schema.request.json"

log = logging.getLogger("sih.server")

if DEBUG_PROMPT:
    # Uvicorn configures its own loggers and leaves the root one without a handler, so
    # `log.info` from this module goes nowhere by default -- which is fine for a server
    # whose whole point is not to record what it receives. The debugging switch has to
    # bring its own handler or it silently does nothing, which is how the first attempt
    # at this produced a log with the traffic in it and none of the diagnosis.
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    log.setLevel(logging.INFO)

# What the serving stack accepts from the gate.
#
# Declared in the contract, not here: CaptureSchema restricts `mime` to these three, so a
# request carrying anything else is refused by schema validation before this module looks
# at it. This constant exists to document the set and to be asserted against -- adding a
# second runtime check would be a second copy of a rule the contract already owns.
#
# The gate encodes WebP by default. Verified locally that Pillow -- which is what
# Qwen-VL's image preprocessor decodes through -- reads it: a 64x48 WebP round-tripped to
# the same pixels. If a serving stack ever chokes on it anyway, change the default in
# redaction/gate.ts and re-verify. Never transcode here: the bytes the receipt covers and
# the bytes the model sees have to be the same bytes.
ACCEPTED_IMAGE_MIMES = frozenset({"image/webp", "image/jpeg", "image/png"})


def load_schemas() -> tuple[dict, dict]:
    """Read the generated contract. Raises if the build step has not run."""
    if not RESPONSE_SCHEMA.exists() or not REQUEST_SCHEMA.exists():
        raise FileNotFoundError(
            "server/schema.json or schema.request.json is missing. "
            "Run `npm run schema:gen` from the repository root."
        )
    response = json.loads(RESPONSE_SCHEMA.read_text(encoding="utf-8"))
    request = json.loads(REQUEST_SCHEMA.read_text(encoding="utf-8"))
    return request, response


def strip_root_metadata(schema: dict) -> dict:
    """vLLM rejects `$schema` and `$comment` at the root of a guided-decoding schema."""
    return {k: v for k, v in schema.items() if k not in ("$schema", "$comment")}


# ── Session state ─────────────────────────────────────────────────────────────


@dataclass
class Session:
    """
    Everything the server remembers between steps.

    Tokens and indices. No element names, no field values, no page text -- and not
    because they are filtered out here, but because they never arrive: the device
    substituted them before the request was built. This class exists to make that
    visible rather than to enforce it.
    """

    session_id: str
    started_at: float
    steps: int = 0
    placeholders: set[str] = field(default_factory=set)
    last_indices: list[int] = field(default_factory=list)

    def observe(self, request: dict[str, Any]) -> None:
        self.steps += 1
        for finding in request.get("manifest", {}).get("findings", []):
            token = finding.get("placeholder")
            if token:
                self.placeholders.add(token)
        self.last_indices = [
            el["index"] for el in request.get("elements", []) if el.get("index") is not None
        ]


# ── The app ───────────────────────────────────────────────────────────────────


#: The Ollama text model used when nothing else says otherwise.
#:
#: Named rather than repeated so that changing it is one edit and one review. The
#: measurements behind the choice are in MODEL-ROUTING.md; do not change it on a hunch.
DEFAULT_OLLAMA_TEXT_MODEL = "qwen2.5:1.5b"

#: Where a local Ollama lists what it has pulled.
OLLAMA_TAGS_URL = "http://localhost:11434/api/tags"


def discover_ollama_text_model(fetch=None) -> str:
    """Which text model this machine actually has, falling back to the default.

    Asking the daemon means a laptop that has pulled something else still runs, instead
    of failing every request against a model that is not there. It is a *probe*, so it is
    allowed to fail: no daemon, no network, no models -- all of them mean the documented
    default.

    `fetch` is injected rather than reached for so a test can decide what the machine
    looks like. Without it this test could only assert what the machine running it
    happened to have pulled, which is how the assertion it replaces came to be wrong on
    every laptop but one. httpx is imported here rather than at module scope for the same
    reason `build_planner` does it: importing this module must not require it.
    """
    if fetch is None:
        import httpx

        fetch = httpx.get

    try:
        tags = fetch(OLLAMA_TAGS_URL, timeout=1.0).json()
        models = [m.get("name", "") for m in tags.get("models", [])]
    except Exception:
        return DEFAULT_OLLAMA_TEXT_MODEL

    if any(m.startswith(DEFAULT_OLLAMA_TEXT_MODEL) for m in models):
        return DEFAULT_OLLAMA_TEXT_MODEL
    return models[0] if models else DEFAULT_OLLAMA_TEXT_MODEL


def build_planner(guided_schema: dict) -> Planner:
    """
    Which planner, from the environment. Three modes, none of them degraded:

      PLANNER=stub    REMOVED. Tier 0 took this job and does it on the device, where it
                      belongs -- see extension/src/worker/tiers.ts. A canned planner
                      sitting on the server pretending to be a model was never the fast
                      path; it was a placeholder that could not read the user's request at
                      all, and it filled the wrong fields for exactly that reason. Set
                      explicitly, it now fails rather than silently serving canned plans.
      PLANNER=ollama  the same model family on a laptop, over Ollama's OpenAI-compatible
                      endpoint. Local -- invariant 1 holds exactly as it does for vLLM.
                      Two models, routed per step; see below.
      PLANNER=vlm     the target: Qwen3-VL-4B-Instruct on vLLM with xgrammar. Default,
                      so a misconfigured deployment fails loudly rather than quietly
                      serving stub plans.

    The two model modes differ by base URL, model name and timeout. Ollama loads weights
    on the first request after an idle period, which is tens of seconds on a cold start
    and nothing at all afterwards, so its ceiling is generous where vLLM's is tight.

    ## Two models under Ollama, one under vLLM

    A step whose page the DOM fully describes needs no vision tower, and on a laptop that
    is the difference between a demo and a stopwatch. Measured here, no CUDA, on this
    project's own recorded steps: `qwen3:0.6b` at 522 MB answered 4 of 4 with valid,
    in-range plans at a 9.6 s median; the 4B vision model on the same text-only prompts is
    an order of magnitude slower. `needs_image` decides, once, in the request handler, and
    RoutingPlanner follows that decision rather than re-deriving it.

    vLLM serves one model per container and has the GPU to make the vision tower cheap, so
    it stays single. Setting OLLAMA_VISION_MODEL to an empty string collapses the routing
    back to one model, which is what to do when only one has been pulled.
    """
    backend = os.environ.get("PLANNER", "vlm").lower()

    if backend == "stub":
        raise SystemExit(
            "PLANNER=stub was removed. The deterministic fast path is Tier 0 and runs on "
            "the device (extension/src/worker/tiers.ts); this server is the remote planner "
            "and nothing else. Use PLANNER=ollama for a local model or PLANNER=vlm for the "
            "target deployment."
        )

    import httpx

    if backend == "ollama":
        base_url = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1")
        timeout_s = float(os.environ.get("OLLAMA_TIMEOUT_S", "600"))

        def ollama(model: str, name: str) -> VlmPlanner:
            return VlmPlanner(
                base_url=base_url,
                model=model,
                schema=guided_schema,
                timeout_s=timeout_s,
                transport=httpx.Client(timeout=timeout_s),
                name=name,
                # Ollama's qwen3 family ships thinking enabled; the target is plain
                # instruct. Without reasoning off it burns the whole token budget
                # reasoning and returns empty content. Both keys are sent because
                # different builds honour different ones and neither is harmful.
                extra_body={
                    "reasoning_effort": "none",
                    "chat_template_kwargs": {"enable_thinking": False},
                },
            )

        # One model by default, and routing only when a team asks for it.
        #
        # The number that decides this is in MODEL-ROUTING.md: on a laptop with no CUDA,
        # the text model answers an ordinary form step in 8-10 s and the 4B vision model
        # takes 61 s to cold-load before it says anything -- past the client's own 60 s
        # plan budget. So the default is the model that fits the budget on the hardware
        # this is demonstrated on, and `OLLAMA_VISION_MODEL` turns on the pair.
        #
        # The comment that used to be here said the opposite, and had been left behind by
        # the change that measured it. Two of the three places that named the default were
        # string literals; naming it once is what stops the next drift being invisible.
        text_model = os.environ.get("OLLAMA_MODEL")
        if not text_model:
            text_model = discover_ollama_text_model()
        vision_model = os.environ.get("OLLAMA_VISION_MODEL", "")
        if not vision_model:
            return ollama(text_model, "ollama")

        return RoutingPlanner(
            text=ollama(text_model, f"ollama:{text_model}"),
            vision=ollama(vision_model, f"ollama:{vision_model}"),
            name=f"ollama {text_model} + {vision_model}",
        )

    return VlmPlanner(
        base_url=os.environ.get("VLLM_BASE_URL", "http://vllm:8000/v1"),
        model=os.environ.get("VLLM_MODEL", "Qwen/Qwen3-VL-4B-Instruct"),
        schema=guided_schema,
        transport=httpx.Client(timeout=60.0),
        name="vllm",
    )


def create_app(planner: Planner | None = None, *, trace_sink=None) -> FastAPI:
    """FastAPI app exposing POST /v1/step."""
    request_schema, response_schema = load_schemas()
    guided_schema = strip_root_metadata(response_schema)

    app = FastAPI(title="SIH26171 planner", version="1")
    app.state.planner = planner or build_planner(guided_schema)
    app.state.sessions = {}
    app.state.request_schema = request_schema
    app.state.response_schema = response_schema
    app.state.guided_schema = guided_schema
    app.state.trace_sink = trace_sink or (lambda line: log.info(line))

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {
            "ok": True,
            "planner": type(app.state.planner).__name__,
            # Which deployment is answering. "the plans got worse" and "the backend
            # changed" must not look alike from outside.
            "backend": getattr(app.state.planner, "name", "unknown"),
            # Where this planner is, relative to the browser that talks to it.
            #
            # Redaction protects data from a planner somewhere else. When the planner is on
            # the same laptop as the browser, that protection is real machinery doing
            # nothing, and a demo that implies otherwise is claiming something untrue. The
            # server cannot know where its *client* is, so it reports its own address and
            # lets the client draw the conclusion.
            "location": planner_location(),
            "model": getattr(app.state.planner, "model", None),
            "sessions": len(app.state.sessions),
            "protocolVersion": response_schema.get("properties", {})
            .get("protocolVersion", {})
            .get("const", 1),
        }

    @app.post("/v1/step")
    async def step(step: str = Form(...), capture: UploadFile | None = File(None)) -> JSONResponse:
        started = time.perf_counter()

        try:
            request = json.loads(step)
        except json.JSONDecodeError as err:
            raise HTTPException(status_code=400, detail=f"step is not JSON: {err}") from err

        problems = validate(request, request_schema)
        if problems:
            # The client validated this before sending, so a failure here means the two
            # sides disagree about the contract -- worth a loud 400, not a guess.
            raise HTTPException(status_code=400, detail={"invalid_request": problems[:5]})

        session = app.state.sessions.setdefault(
            request["sessionId"], Session(request["sessionId"], time.time())
        )
        session.observe(request)

        # The capture format is already constrained by the request schema above.
        image_bytes = await capture.read() if capture is not None else None
        wants_image = needs_image(request)
        if not wants_image:
            # The fast path: same model, no image. Most steps on an ordinary form.
            image_bytes = None

        try:
            result = app.state.planner.plan(request, image_bytes)
        except Exception as err:  # noqa: BLE001 -- any model failure is a 503 to retry
            log.warning("planner failed: %s", type(err).__name__)
            raise HTTPException(status_code=503, detail="planner unavailable") from err

        problems = validate(result.plan, response_schema)
        if problems:
            # Refuse rather than return a malformed plan. A refusal the client retries
            # beats a plan that clicks the wrong thing on stage, and the retry logic
            # belongs here rather than in the client.
            log.warning("model produced an invalid plan: %s", problems[:2])
            raise HTTPException(status_code=422, detail={"invalid_plan": problems[:5]})

        if DEBUG_PROMPT:
            # The prompt exactly as the model received it, and the plan that came back.
            #
            # Off by default and gated on an environment variable rather than a log
            # level, because it prints the element list -- which carries placeholders and
            # never values, but is still page content and has no business in a default
            # log. It exists because "the agent keeps clicking [8]" is unanswerable from
            # outside: the element list is the only place that says what [8] is, and it
            # is assembled here and nowhere else.
            log.info(
                "step %s\n%s\n-> %s | %s",
                request["stepIndex"],
                build_user_message(request),
                result.plan.get("rationale", ""),
                json.dumps(result.plan["actions"]),
            )

        total_ms = (time.perf_counter() - started) * 1000
        app.state.trace_sink(
            json.dumps(
                {
                    "sessionId": request["sessionId"],
                    "stepIndex": request["stepIndex"],
                    "usedImage": result.used_image,
                    "fastPath": not wants_image,
                    "modelMs": round(result.model_ms, 2),
                    "totalMs": round(total_ms, 2),
                    "promptChars": result.prompt_chars,
                    "imageBytes": len(image_bytes) if image_bytes else 0,
                    "elements": len(request.get("elements", [])),
                    "findings": len(request.get("manifest", {}).get("findings", [])),
                    "actions": [a["type"] for a in result.plan["actions"]],
                    "done": result.plan.get("done", False),
                }
            )
        )

        return JSONResponse(result.plan)

    return app


# ── Validation ────────────────────────────────────────────────────────────────


def validate(instance: Any, schema: dict) -> list[str]:
    """
    Validate against the generated schema, returning readable problems.

    jsonschema when it is available -- it is in the container -- and a structural check
    otherwise, so the stub server runs on a laptop with nothing installed. The fallback
    is deliberately shallow: it catches the shape errors that actually happen (a missing
    field, a wrong type at the top level) and does not pretend to be a validator.
    """
    try:
        import jsonschema
    except ImportError:
        return _shallow_validate(instance, schema)

    validator = jsonschema.Draft202012Validator(strip_root_metadata(schema))
    return [f"{'/'.join(str(p) for p in e.path)}: {e.message}" for e in validator.iter_errors(instance)]


def _shallow_validate(instance: Any, schema: dict) -> list[str]:
    if schema.get("type") == "object" and not isinstance(instance, dict):
        return [f"expected an object, got {type(instance).__name__}"]

    problems = []
    for key in schema.get("required", []):
        if key not in instance:
            problems.append(f"{key}: required")
    return problems


app = create_app()
