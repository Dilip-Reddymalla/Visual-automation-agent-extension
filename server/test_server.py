"""Server tests. `python -m pytest server/`

Two things worth stating about what is tested here.

The stub planner is tested as a *product*, not as scaffolding. It is what M9 develops
against for however long the GPU takes to arrive, so "the stub returns something
schema-valid for every reasonable page" is a real requirement rather than a placeholder.

The prompt-rendering functions are tested for what they must never emit. A prompt is
built from a request that has already been through the gate, so nothing raw should be
reachable -- but the rendering is the last place a mistake could put a value in front of
the model, and it is worth an assertion rather than an assumption.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import (
    ACCEPTED_IMAGE_MIMES,
    DEFAULT_OLLAMA_TEXT_MODEL,
    discover_ollama_text_model,
    Session,
    build_planner,
    create_app,
    load_schemas,
    strip_root_metadata,
    validate,
)
from planner import (
    completion_text,
    KEEP_STEPS,
    PlanResult,
    RoutingPlanner,
    SYSTEM_PROMPT,
    StubPlanner,
    VlmPlanner,
    build_user_message,
    needs_image,
    render_elements,
    render_history,
    render_manifest,
    render_plan,
)

SERVER = Path(__file__).parent


def element(**over):
    base = {
        "index": 1,
        "role": "textbox",
        "name": "Full name",
        "box": {"x": 10, "y": 10, "w": 200, "h": 30},
        "state": {"visible": True, "enabled": True, "focused": False, "filled": False},
        "occluded": 0,
        "fromPixels": False,
        "isNew": False,
    }
    base.update(over)
    return base


def finding(**over):
    base = {
        "id": "f1",
        "cls": "AADHAAR",
        "box": {"x": 10, "y": 10, "w": 100, "h": 20},
        "layer": "L0",
        "confidence": 0.99,
        "mode": "mask",
        "reason": "autocomplete-cc-number",
        # Where the value came from. 'agent' means this extension typed it, and the
        # session counter deliberately excludes those -- see Finding.origin.
        "origin": "page",
    }
    base.update(over)
    return base


class _FakeTagsResponse:
    """Just enough of an httpx response for the Ollama tags probe."""

    def __init__(self, names):
        self._names = names

    def json(self):
        return {"models": [{"name": n} for n in self._names]}


def _tags(names):
    return lambda *_args, **_kwargs: _FakeTagsResponse(names)


def _raises(*_args, **_kwargs):
    raise RuntimeError("no daemon")


def request_body(**over):
    base = {
        "protocolVersion": 1,
        "sessionId": "s1",
        "stepIndex": 0,
        "goal": "Complete the scholarship application",
        # Open-ended: nothing parsed, so the planner owns the step. A request that *did*
        # parse would carry verbs and field names here, never values.
        "intents": [],
        "origin": "http://localhost:8080",
        "title": "Application",
        "viewport": {"w": 1280, "h": 720},
        "capture": {
            "mime": "image/webp",
            "width": 1024,
            "height": 576,
            "scale": 0.8,
            "sha256": "a" * 64,
        },
        "elements": [element()],
        "manifest": {
            "findings": [finding()],
            "counts": {"AADHAAR": 1},
            # Set-of-Mark: how many element indices are drawn on the frame. Not findings
            # -- a mark is not a redaction -- but the payload says what is in the picture.
            "marks": 0,
            "redactedFraction": 0.05,
            "overRedactedFraction": 0.01,
            "policyVersion": "p1",
            "receipt": {
                "algo": "SHA-256",
                "hash": "b" * 64,
                "manifestHash": "c" * 64,
                "sealedAt": 1700000000000,
            },
        },
        "history": [],
        # How the device broke the task up, and how far it got. Empty for a single-step
        # task; the device always sends the field. See extension/src/shared/contract.ts.
        "plan": [],
    }
    base.update(over)
    return base


@pytest.fixture
def client():
    traces = []
    app = create_app(StubPlanner(), trace_sink=traces.append)
    with TestClient(app) as c:
        c.traces = traces
        yield c


# ── The contract is loaded, not redeclared ────────────────────────────────────


def test_schemas_load():
    request_schema, response_schema = load_schemas()
    assert request_schema["title"]
    assert "actions" in response_schema["properties"]


def test_root_metadata_is_stripped_for_vllm():
    _, response_schema = load_schemas()
    stripped = strip_root_metadata(response_schema)
    assert "$schema" not in stripped
    assert "$comment" not in stripped
    # And nothing else was lost on the way.
    assert stripped["properties"] == response_schema["properties"]


# ── The stub ──────────────────────────────────────────────────────────────────


def test_health(client):
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["planner"] == "StubPlanner"


def test_stub_returns_a_schema_valid_plan(client):
    reply = client.post("/v1/step", data={"step": json.dumps(request_body())})
    assert reply.status_code == 200

    _, response_schema = load_schemas()
    assert validate(reply.json(), response_schema) == []


def test_stub_fills_an_empty_field_then_clicks(client):
    empty = element(index=6, role="textbox", name="Email address")
    button = element(index=9, role="button", name="Save and continue")

    first = client.post(
        "/v1/step", data={"step": json.dumps(request_body(elements=[empty, button]))}
    ).json()
    assert first["actions"][0]["type"] == "type"
    assert first["actions"][0]["index"] == 6

    filled = element(
        index=6,
        role="textbox",
        state={"visible": True, "enabled": True, "focused": False, "filled": True},
    )
    second = client.post(
        "/v1/step", data={"step": json.dumps(request_body(elements=[filled, button]))}
    ).json()
    assert second["actions"][0]["type"] == "click"
    assert second["actions"][0]["index"] == 9


def test_stub_prefers_the_button_that_submits_over_the_one_that_saves_a_draft(client):
    """Page A's actions row, in document order, and only one of them makes progress.

    Taking the first button was how the stub spent a whole step budget clicking `Save
    draft` -- an inert control, clicked over and over, every click correctly reported as
    a success.
    """
    draft = element(index=11, role="button", name="Save draft")
    submit = element(index=12, role="button", name="Save and continue")

    reply = client.post(
        "/v1/step", data={"step": json.dumps(request_body(elements=[draft, submit]))}
    ).json()
    assert reply["actions"][0] == {"type": "click", "index": 12}


def test_stub_looks_below_the_fold_before_giving_up(client):
    """Perception is viewport-bounded, so `not in the list` and `not on the page` differ.

    A form longer than the window has its submit button outside the element list until
    something scrolls, which is why the stub has to look rather than conclude.
    """
    header = element(index=1, role="link", name="Help")
    reply = client.post(
        "/v1/step", data={"step": json.dumps(request_body(elements=[header]))}
    ).json()
    assert reply["actions"][0]["type"] == "scroll"
    assert reply["actions"][0]["dy"] > 0


def test_stub_finishes_when_there_is_nothing_to_do(client):
    reply = client.post("/v1/step", data={"step": json.dumps(request_body(elements=[]))}).json()
    assert reply["actions"][0]["type"] == "finish"
    assert reply["done"] is True


def test_stub_reuses_a_placeholder_from_the_manifest(client):
    body = request_body(
        elements=[element(index=6, role="textbox")],
        manifest={
            **request_body()["manifest"],
            "findings": [finding(cls="EMAIL", placeholder="«EMAIL_1»")],
        },
    )
    reply = client.post("/v1/step", data={"step": json.dumps(body)}).json()
    assert reply["actions"][0]["text"] == "«EMAIL_1»"


def test_a_hundred_consecutive_plans_all_validate(client):
    """Acceptance criterion 2, for the stub. The model path is the same validator."""
    _, response_schema = load_schemas()
    for i in range(100):
        reply = client.post(
            "/v1/step", data={"step": json.dumps(request_body(stepIndex=i))}
        )
        assert reply.status_code == 200, reply.text
        assert validate(reply.json(), response_schema) == []


# ── Refusing, rather than returning something wrong ───────────────────────────


def test_a_malformed_request_is_a_400(client):
    assert client.post("/v1/step", data={"step": "not json"}).status_code == 400


def test_a_request_that_fails_the_schema_is_a_400(client):
    body = request_body()
    del body["manifest"]
    assert client.post("/v1/step", data={"step": json.dumps(body)}).status_code == 400


def test_an_invalid_plan_is_refused_rather_than_returned():
    """
    The retry belongs here, not in the client.

    A refusal the client can retry beats a plan that clicks the wrong thing on stage.
    """

    class BadPlanner:
        def plan(self, request, image):
            from planner import PlanResult

            return PlanResult(
                plan={"protocolVersion": 1, "actions": []},  # no stepIndex, empty actions
                used_image=False,
                model_ms=1.0,
                prompt_chars=0,
            )

    with TestClient(create_app(BadPlanner(), trace_sink=lambda _: None)) as c:
        reply = c.post("/v1/step", data={"step": json.dumps(request_body())})
        assert reply.status_code == 422
        assert "invalid_plan" in reply.json()["detail"]


def test_a_planner_that_throws_is_a_503():
    class BrokenPlanner:
        def plan(self, request, image):
            raise RuntimeError("vLLM is not up")

    with TestClient(create_app(BrokenPlanner(), trace_sink=lambda _: None)) as c:
        assert c.post("/v1/step", data={"step": json.dumps(request_body())}).status_code == 503


# ── The fast path ─────────────────────────────────────────────────────────────


def test_an_ordinary_form_does_not_need_the_image():
    assert needs_image(request_body()) is False


def test_an_unnamed_image_needs_the_image():
    """Pixels with no text anywhere to describe them. The whole reason for the vision path."""
    body = request_body(elements=[element(index=None, role="image", name="")])
    assert needs_image(body) is True


def test_a_named_image_does_not():
    """Alt text is the description. That is what the accessibility tree is for."""
    body = request_body(elements=[element(index=None, role="image", name="Applicant photo")])
    assert needs_image(body) is False


def test_a_canvas_needs_the_image():
    body = request_body(elements=[element(index=None, role="canvas", name="")])
    assert needs_image(body) is True


def test_prose_does_not_need_the_image_merely_for_being_unclickable():
    """
    The regression that killed the fast path outright.

    M3b admitted text-bearing blocks so that a displayed Aadhaar number is detectable at
    all. Those have no index -- nothing can click a paragraph -- and `needs_image` read
    "no index" as "not in the list". Over the ten replica pages in eval/report/runs the
    result was 10 of 10 steps asking for the picture, 22 to 56 unindexed elements each,
    and every one of them a `text` or `heading` whose content was right there in `name`.
    """
    body = request_body(
        elements=[
            element(index=None, role="text", name="Aadhaar number 9194 4273 6092"),
            element(index=None, role="heading", name="Your profile"),
            element(index=3, role="button", name="Save"),
        ]
    )
    assert needs_image(body) is False


def test_text_recovered_from_pixels_needs_the_image():
    body = request_body(elements=[element(fromPixels=True)])
    assert needs_image(body) is True


def test_an_l3_finding_needs_the_image():
    body = request_body(
        manifest={**request_body()["manifest"], "findings": [finding(layer="L3")]}
    )
    assert needs_image(body) is True


def test_the_fast_path_is_recorded_in_the_trace(client):
    client.post(
        "/v1/step",
        data={"step": json.dumps(request_body())},
        files={"capture": ("capture", b"not really an image", "image/webp")},
    )
    trace = json.loads(client.traces[-1])
    assert trace["fastPath"] is True
    # The image arrived and was deliberately not forwarded.
    assert trace["usedImage"] is False
    assert trace["imageBytes"] == 0


# ── History trimming ──────────────────────────────────────────────────────────


def test_step_twelve_costs_no_more_than_step_four():
    """Acceptance criterion 6, measured rather than asserted."""
    four = build_user_message(
        request_body(stepIndex=4, history=[{"stepIndex": i, "action": f"click [{i}]", "outcome": "ok"} for i in range(4)])
    )
    twelve = build_user_message(
        request_body(stepIndex=12, history=[{"stepIndex": i, "action": f"click [{i}]", "outcome": "ok"} for i in range(12)])
    )
    # Same element list, same manifest; only the history differs, and it is trimmed.
    assert len(twelve) <= len(four) + 80


def test_history_keeps_the_last_three_and_summarises_the_rest():
    history = [{"stepIndex": i, "action": f"click [{i}]", "outcome": "ok"} for i in range(10)]
    rendered = render_history(history)
    assert "7 earlier steps" in rendered
    assert rendered.count("  step ") == KEEP_STEPS
    assert "step 9:" in rendered
    assert "step 6:" not in rendered


# ── Rendering ─────────────────────────────────────────────────────────────────


def test_elements_render_with_index_state_and_marker():
    rendered = render_elements(
        [
            element(index=4, name="Full name", value="«PERSON_1»", state={"visible": True, "enabled": True, "focused": False, "filled": True}),
            element(index=None, role="image", name=""),
            element(index=8, role="text", name="Email is required", isNew=True),
        ]
    )
    assert '[4]<textbox aria-label="Full name" value="«PERSON_1»" filled />' in rendered
    assert "*[8]" in rendered
    # Visual-only: indented, unnumbered, reachable by coordinate only.
    assert "\n    <image" in rendered


def test_an_element_the_page_is_not_displaying_says_so():
    """Page B's `<p hidden role="status">Application submitted.</p>`, exactly.

    Perception keeps validation-relevant nodes while they are hidden, on purpose. The
    prompt dropped `visible`, so the planner was shown a success message on a form that
    had not been submitted -- with nothing in the line to say it was not on screen.
    """
    rendered = render_elements(
        [
            element(
                index=1,
                role="text",
                name="Application submitted.",
                state={"visible": False, "enabled": True, "focused": False, "filled": False},
            ),
            element(index=2, role="text", name="Choose a scheme"),
        ]
    )
    assert '[1]<text aria-label="Application submitted." hidden />' in rendered
    assert "hidden" not in rendered.splitlines()[1]


def test_the_manifest_renders_what_was_removed_and_what_was_kept():
    rendered = render_manifest(
        {
            "findings": [
                finding(cls="AADHAAR", placeholder="«AADHAAR_1»"),
                finding(id="f2", cls="ORG", mode="keep", reason="below-confidence-floor"),
            ],
            "redactedFraction": 0.12,
            "overRedactedFraction": 0.03,
        }
    )
    assert "1 redacted, 1 detected but left visible" in rendered
    assert "«AADHAAR_1»" in rendered
    assert "keep" in rendered
    assert "12.0%" in rendered


def test_the_prompt_explains_the_three_filled_states():
    for phrase in ["filled=false", 'filled=true, value="«EMAIL_1»"', "filled=true, no value"]:
        assert phrase in SYSTEM_PROMPT, phrase


def test_the_prompt_forbids_rehydrating_a_secret():
    assert "«SECRET_*» cannot be used this way" in SYSTEM_PROMPT


def test_nothing_raw_reaches_the_prompt():
    """
    The last place a value could reach the model.

    Everything in a request has already been through the gate, so this should be
    impossible -- which is exactly why it is worth asserting rather than assuming.
    """
    body = request_body(
        elements=[element(index=4, name="Full name", value="«PERSON_1»")],
        manifest={
            **request_body()["manifest"],
            "findings": [finding(placeholder="«AADHAAR_1»")],
        },
    )
    rendered = build_user_message(body)
    for raw in ["Asha Menon", "7237 2429 6561", "hunter2"]:
        assert raw not in rendered


# ── Sessions ──────────────────────────────────────────────────────────────────


def test_a_session_holds_tokens_and_indices_only():
    session = Session("s1", 0.0)
    session.observe(
        request_body(
            elements=[element(index=4, name="Full name", value="«PERSON_1»")],
            manifest={
                **request_body()["manifest"],
                "findings": [finding(placeholder="«AADHAAR_1»")],
            },
        )
    )

    assert session.placeholders == {"«AADHAAR_1»"}
    assert session.last_indices == [4]

    # Nothing about the page's content survived.
    state = json.dumps(session.__dict__, default=list)
    assert "Full name" not in state
    assert "Application" not in state


def test_the_trace_carries_no_element_names(client):
    client.post(
        "/v1/step",
        data={"step": json.dumps(request_body(elements=[element(name="Aadhaar number")]))},
    )
    assert "Aadhaar number" not in client.traces[-1]


# ── The model planner, without a model ────────────────────────────────────────


def test_the_vlm_planner_omits_the_image_on_the_fast_path():
    planner = VlmPlanner(schema={})
    messages = planner.messages(request_body(), None)
    assert isinstance(messages[-1]["content"], str)


def test_the_vlm_planner_attaches_the_image_when_there_is_one():
    planner = VlmPlanner(schema={})
    messages = planner.messages(request_body(), b"\x00\x01\x02")
    parts = messages[-1]["content"]
    assert isinstance(parts, list)
    assert parts[1]["type"] == "image_url"
    assert parts[1]["image_url"]["url"].startswith("data:image/webp;base64,")


def test_the_worked_example_shows_a_filled_field_being_skipped():
    """
    The example is what makes the scheme land.

    A model that has never seen a masked value treated as *filled* will treat it as
    blank and re-enter it, which is the failure this whole architecture is arranged to
    avoid.
    """
    planner = VlmPlanner(schema={})
    messages = planner.messages(request_body(), None)
    assistant = json.loads(messages[2]["content"])

    typed = [a for a in assistant["actions"] if a["type"] == "type"]
    assert [a["index"] for a in typed] == [6]  # only the empty field
    assert "«EMAIL_1»" in typed[0]["text"]
    assert "do not need re-entering" in assistant["rationale"]


def test_the_model_does_not_get_to_renumber_the_step():
    class FakeTransport:
        def post(self, url, json=None, timeout=None):
            class Reply:
                status_code = 200

                @staticmethod
                def raise_for_status():
                    return None

                @staticmethod
                def json():
                    return {
                        "choices": [
                            {
                                "message": {
                                    "content": json_dumps(
                                        {
                                            "protocolVersion": 1,
                                            "stepIndex": 999,
                                            "rationale": "",
                                            "actions": [{"type": "click", "index": 1}],
                                            "done": False,
                                        }
                                    )
                                }
                            }
                        ]
                    }

            return Reply()

    from json import dumps as json_dumps

    planner = VlmPlanner(schema={}, transport=FakeTransport())
    result = planner.plan(request_body(stepIndex=7), None)
    assert result.plan["stepIndex"] == 7


# ── The image format, and the planner switch ─────────────────────────────────


def test_webp_is_accepted_because_that_is_what_the_gate_produces():
    # gate.encode defaults to WebP. If a serving stack ever chokes on it, the fix is to
    # change the default there and re-verify -- transcoding here would mean the bytes the
    # receipt covers and the bytes the model sees are different bytes.
    assert "image/webp" in ACCEPTED_IMAGE_MIMES
    assert "image/jpeg" in ACCEPTED_IMAGE_MIMES


def test_an_unknown_capture_format_is_refused_by_the_contract(client):
    # Not by a runtime check here: CaptureSchema restricts the format, so an unknown one
    # never gets as far as the planner. An earlier version of this test expected a 415
    # from a guard in app.py and got a 400 from the schema instead -- which was the
    # schema being right and the guard being a second copy of its rule.
    body = request_body(elements=[element(index=None)])
    body["capture"]["mime"] = "image/avif"
    reply = client.post(
        "/v1/step",
        data={"step": json.dumps(body)},
        files={"capture": ("capture", b"bytes", "image/avif")},
    )
    assert reply.status_code == 400


def test_pillow_decodes_what_the_gate_encodes():
    """
    Amendment 6, answered rather than assumed.

    Qwen-VL's preprocessor decodes through Pillow, and the gate emits WebP. A format the
    serving stack cannot read would fail as a blank image rather than as an error, which
    is the worst way for it to fail.
    """
    from io import BytesIO

    from PIL import Image, features

    assert features.check("webp")

    buf = BytesIO()
    Image.new("RGB", (64, 48), (200, 30, 30)).save(buf, format="WEBP", quality=85)
    decoded = Image.open(BytesIO(buf.getvalue()))
    decoded.load()

    assert decoded.format == "WEBP"
    assert decoded.size == (64, 48)


def test_planner_stub_is_no_longer_a_backend(monkeypatch):
    """The deterministic fast path moved to the device and must not have a copy here.

    A canned planner on the server could not read the user's request -- it was a pure
    function of the element list, and it filled the wrong fields for exactly that reason.
    Tier 0 does that job now, on the device, where the sentence is. Leaving the switch in
    place would leave a way to run a build that looks like it is planning and is not.
    """
    monkeypatch.setenv("PLANNER", "stub")
    with pytest.raises(SystemExit, match="Tier 0"):
        build_planner({})

def routed(planner):
    """Both legs of a routing planner, or the one planner there is."""
    return [planner.text, planner.vision] if isinstance(planner, RoutingPlanner) else [planner]


def test_planner_ollama_is_local_and_generous_with_time(monkeypatch):
    """Ollama is a first-class backend, not a fallback: same protocol, same guided
    decoding, different address. It loads weights on the first request after an idle
    period, so its timeout has to clear a cold start that vLLM never has."""
    monkeypatch.setenv("PLANNER", "ollama")
    planner = build_planner({})

    assert "ollama" in planner.name
    for leg in routed(planner):
        assert "11434" in leg.base_url
        assert leg.timeout_s >= 120, "a cold Ollama start does not fit in vLLM's ceiling"


def test_ollama_routes_a_small_text_model_and_a_vision_model(monkeypatch):
    """
    The measurement this exists for, on a laptop with no CUDA and this project's own
    recorded steps: qwen3:0.6b at 522 MB answered 4 of 4 with valid, in-range plans at a
    9.6 s median; qwen3-vl:4b at 3.3 GB answered the same four text-only prompts at a
    73.5 s median. Same validity, 7.7x the wait, for a vision tower no DOM-only step uses.
    """
    monkeypatch.setenv("PLANNER", "ollama")
    monkeypatch.setenv("OLLAMA_MODEL", "qwen3:0.6b")
    monkeypatch.setenv("OLLAMA_VISION_MODEL", "qwen3-vl:4b")
    planner = build_planner({})

    assert isinstance(planner, RoutingPlanner)
    assert planner.text.model == "qwen3:0.6b"
    assert planner.vision.model == "qwen3-vl:4b"
    # /health has to distinguish a routing change from a model change.
    assert "qwen3:0.6b" in planner.model and "qwen3-vl:4b" in planner.model


def test_routing_is_opt_in(monkeypatch):
    """
    A default matters more than an option, and this is the half of it that is a promise:
    without OLLAMA_VISION_MODEL you get one planner, not a pair. Turning routing on is
    something a team does after measuring the two models they intend to run.

    This used to assert a model name as well, and the name it asserted had stopped being
    the default some time before -- `app.py` probes the local daemon and falls back to
    DEFAULT_OLLAMA_TEXT_MODEL, which MODEL-ROUTING.md measures at 8-10 s a step against
    the 4B vision model's 61 s cold load. The assertion was also quietly reaching the
    network, so it passed or failed depending on what the machine running it had pulled.
    Both halves are now tested, separately, and neither needs a daemon.
    """
    monkeypatch.setenv("PLANNER", "ollama")
    monkeypatch.delenv("OLLAMA_MODEL", raising=False)
    monkeypatch.delenv("OLLAMA_VISION_MODEL", raising=False)
    planner = build_planner({})

    assert not isinstance(planner, RoutingPlanner)


def test_the_text_model_falls_back_to_the_documented_default():
    """No daemon, no models, no network: the documented default, not an exception."""
    assert discover_ollama_text_model(fetch=_raises) == DEFAULT_OLLAMA_TEXT_MODEL


def test_the_text_model_prefers_what_the_machine_has_pulled():
    """A laptop that pulled something else still runs, rather than failing every request.

    The default wins when it is present; otherwise the first model the daemon lists is
    better than one that is definitely not installed.
    """
    both = _tags([DEFAULT_OLLAMA_TEXT_MODEL, "llama3.2:1b"])
    assert discover_ollama_text_model(fetch=both) == DEFAULT_OLLAMA_TEXT_MODEL
    assert discover_ollama_text_model(fetch=_tags(["llama3.2:1b"])) == "llama3.2:1b"
    assert discover_ollama_text_model(fetch=_tags([])) == DEFAULT_OLLAMA_TEXT_MODEL


def test_an_explicit_model_beats_the_probe(monkeypatch):
    monkeypatch.setenv("PLANNER", "ollama")
    monkeypatch.setenv("OLLAMA_MODEL", "some-other-model")
    monkeypatch.delenv("OLLAMA_VISION_MODEL", raising=False)
    # The probe is not reached at all when the environment names a model.
    assert build_planner({}).model == "some-other-model"


def test_the_image_alone_decides_which_model_answers():
    """
    RoutingPlanner does not re-derive `needs_image`. The handler already asked, and
    already dropped the image when the answer was no; a second copy of a rule that
    decides what crosses the network is one copy too many.
    """
    calls: list[str] = []

    class Leg:
        def __init__(self, tag):
            self.tag = tag

        def plan(self, request, image):
            calls.append(self.tag)
            return PlanResult(plan={}, used_image=image is not None, model_ms=0, prompt_chars=0)

    planner = RoutingPlanner(text=Leg("text"), vision=Leg("vision"))
    planner.plan({}, None)
    planner.plan({}, b"webp")
    assert calls == ["text", "vision"]


def test_one_model_is_still_allowed(monkeypatch):
    """An empty vision model collapses the routing -- what to do when only one is pulled."""
    monkeypatch.setenv("PLANNER", "ollama")
    monkeypatch.setenv("OLLAMA_MODEL", "qwen3:0.6b")
    monkeypatch.setenv("OLLAMA_VISION_MODEL", "")
    planner = build_planner({})

    assert not isinstance(planner, RoutingPlanner)
    assert planner.name == "ollama"


def test_planner_defaults_to_the_real_backend(monkeypatch):
    """A deployment that forgets to set PLANNER must fail reaching for a GPU, not
    quietly serve deterministic stub plans that look like a working agent."""
    monkeypatch.delenv("PLANNER", raising=False)
    planner = build_planner({})

    assert planner.name == "vllm"
    assert "Qwen" in planner.model


def test_no_backend_points_at_a_hosted_api(monkeypatch):
    """Invariant 1, checked rather than trusted. Every model backend must be a loopback
    or in-cluster address -- a hosted endpoint would put page pixels on someone else's
    machine, which is the one thing this project exists not to do."""
    for backend in ("vlm", "ollama"):
        monkeypatch.setenv("PLANNER", backend)
        for leg in routed(build_planner({})):
            assert any(
                marker in leg.base_url
                for marker in ("localhost", "127.0.0.1", "vllm", "[::1]")
            ), f"{backend} points somewhere off-device: {leg.base_url}"


def test_health_names_the_backend_and_model():
    """"The plans got worse" and "the backend changed" must not look alike from
    outside, so /health says which is answering."""
    client = TestClient(create_app(StubPlanner()))
    body = client.get("/health").json()

    assert body["backend"] == "unknown"
    assert "model" in body
    # Where it is running, because the redaction claim depends on the answer.
    assert body["location"] in ("local (development)",) or body["location"].startswith("remote")


def test_ollama_turns_thinking_off():
    """Not a preference. Ollama publishes qwen3-vl as the thinking variant, and left
    alone it spends the entire token budget reasoning and returns empty content -- which
    reaches the client as a JSONDecodeError and looks like a transport bug rather than a
    model one. vLLM is pointed at Instruct weights and must not be sent the flag."""
    import os

    os.environ["PLANNER"] = "ollama"
    try:
        for leg in routed(build_planner({})):
            assert leg.extra_body.get("reasoning_effort") == "none"
        os.environ["PLANNER"] = "vlm"
        assert build_planner({}).extra_body == {}
    finally:
        os.environ.pop("PLANNER", None)


def test_backend_extras_reach_the_request_body():
    """extra_body has to land in the JSON that goes out, or the setting above is a
    comment. Checked against a fake transport rather than a live model."""

    class Recorder:
        sent: dict = {}

        def post(self, url, json, timeout):  # noqa: A002
            Recorder.sent = json

            class R:
                status_code = 200

                @staticmethod
                def raise_for_status():
                    return None

                @staticmethod
                def json():
                    return {
                        "choices": [
                            {"message": {"content": '{"protocolVersion":1,"stepIndex":0,"actions":[]}'}}
                        ]
                    }

            return R()

    planner = VlmPlanner(
        schema={}, transport=Recorder(), name="ollama", extra_body={"reasoning_effort": "none"}
    )
    planner.plan({"stepIndex": 0, "goal": "g", "elements": []}, None)

    assert Recorder.sent["reasoning_effort"] == "none"


def test_completion_text_prefers_content():
    assert completion_text({"content": '{"a":1}', "reasoning": "musing"}) == '{"a":1}'


def test_completion_text_falls_back_when_the_backend_misfiles_the_plan():
    """Ollama splits output on a <think> block. With reasoning_effort off, qwen3-vl
    emits no such block, so the parser files the entire plan under `reasoning` and
    returns empty content -- observed with finish_reason "stop" and a schema-valid plan
    sitting in the wrong field. Without this the step dies on a JSONDecodeError that
    looks like a transport fault."""
    plan = '{"protocolVersion":1,"stepIndex":1,"actions":[]}'
    assert completion_text({"content": "", "reasoning": plan}) == plan
    assert completion_text({"content": "   ", "reasoning": plan}) == plan


def test_completion_text_is_empty_when_the_model_said_nothing():
    assert completion_text({"content": "", "reasoning": ""}) == ""
    assert completion_text({}) == ""


# ── The decomposition, as the planner sees it ─────────────────────────────────


def test_the_plan_is_rendered_when_the_device_sent_one():
    """A planner asked to replan needs to know what has already been tried.

    Told only "the last step failed" it proposes the leg that just failed. Told "select
    has been attempted twice and reports ambiguous", it can propose the filter that would
    separate the candidates.
    """
    prompt = build_user_message(
        request_body(
            plan=[
                {
                    "id": "search-1",
                    "kind": "search",
                    "intent": "search for permits",
                    "after": [],
                    "criteria": [],
                    "budget": 2,
                    "status": "done",
                    "attempts": 1,
                },
                {
                    "id": "select-1",
                    "kind": "select",
                    "intent": "choose the one that fits",
                    "after": ["search-1"],
                    "criteria": [],
                    "budget": 3,
                    "status": "active",
                    "attempts": 2,
                    "failure": "ambiguous",
                },
            ]
        )
    )

    assert "Plan:" in prompt
    assert "search-1" in prompt and "select-1" in prompt
    assert "2/3 attempts" in prompt
    assert "ambiguous" in prompt
    assert "Current leg: select-1" in prompt


def test_a_device_that_decomposed_nothing_gets_the_prompt_it_always_got():
    """The whole reason `plan` defaults rather than being required."""
    assert "Plan:" not in build_user_message(request_body())


def test_the_rendered_plan_carries_no_page_content():
    """Ids, kinds, counts and the user's own words. Nothing read off the page."""
    line = render_plan(
        [
            {
                "id": "interact-1",
                "kind": "interact",
                "intent": "fill the email field with «EMAIL_1»",
                "status": "active",
                "attempts": 1,
                "budget": 3,
            }
        ]
    )
    assert "«EMAIL_1»" in line
    assert "asha" not in line.lower()


def test_the_system_prompt_explains_how_to_replan():
    """Adding a field to the schema without telling the model what it is for is a field
    nothing ever fills in."""
    for phrase in ("## The plan", "`plan` array", "navigate | search | filter"):
        assert phrase in SYSTEM_PROMPT
