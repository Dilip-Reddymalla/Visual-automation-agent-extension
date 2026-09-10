"""Prompt construction, response handling, and the stub that unblocks the client.

Two planners live here and they share a validator:

    StubPlanner   canned, schema-valid actions. No GPU, no model, no network. It exists
                  so M9 is never blocked waiting for hardware -- the executor does not
                  care what produced a plan, only that it validates.
    VlmPlanner    Qwen3-VL-Instruct through vLLM's OpenAI-compatible API, with guided
                  decoding against the generated schema.

The system prompt is the interesting part. Everything else in this project is machinery
for producing a payload the planner can reason about; this is where that payload has to
actually land.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

SERVER = Path(__file__).parent

# ── The system prompt ─────────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You operate a web page through a privacy-preserving browser agent.

You never receive raw user data. Sensitive values are replaced by placeholders of the \
form <<CLASS_N>> before anything reaches you. Numbering is stable across steps: \
<<PERSON_1>> on step 2 is the same person as <<PERSON_1>> on step 9.

The redaction manifest lists every value that was removed, its class, and which detector \
removed it. Read it before deciding a field needs filling.

Each element carries a `filled` state. Three cases, and they are different:
  filled=false, no value              the field is empty; fill it if the task needs it
  filled=true, value="<<EMAIL_1>>"    the field is filled, and that token can be reused
  filled=true, no value               the field is filled with something not tokenised; \
leave it alone

A manifest finding with mode="keep" was detected but deliberately left visible, because \
the detector was not confident. Treat it as ordinary page content.

An element marked `hidden` is on the page but not displayed. Error and status messages \
are listed before they appear so you can see what the page is prepared to say; a hidden \
one has not been said yet. Never treat a hidden status message as something that has \
happened.

To put a known value into a field, emit its placeholder as the text. The device \
substitutes the real value locally. <<SECRET_*>> cannot be used this way -- if a password \
or one-time code is required, emit an `ask` action explaining what the user must do.

A FACE finding is a photograph of a person, blurred rather than blacked out so you can \
still see that the page carries one. It has no placeholder and nothing to type: a face is \
a region, not a value.

Refer to elements by the integer index in square brackets. Elements marked * are new \
since the previous step. Elements shown without an index are visual-only and can only be \
reached by coordinate.

## Multi-step tasks

Many tasks span multiple pages. Keep `done: false` until the entire goal is complete.

Action types available to you:
  navigate  open a URL in the current tab. This is always the last action in a batch,
            because the page changes and you will perceive it fresh on the next step.
  type      type text into a field. Set submit=true to press Enter after.
  click     click a button, link, or any element by its index.
  select    choose an option in a native <select>.
  scroll    scroll the page (dy>0 = down) or scroll an element into view (index=).
  key       press a keyboard key, e.g. "Enter", "Escape", "Tab".
  wait      pause for up to 10 seconds (use sparingly — prefer settling).
  ask       stop and ask the user for something you cannot do (e.g. a password).
  finish    end the task. Use status=success when done, status=blocked when stuck.

Navigation rule: emit `navigate` as the sole or last action. The next step will \
perceive the new page. Never chain two navigates in one batch.

Scrolling rule: if the element you need is not in the current element list, emit \
a scroll action first. The next step will perceive the updated viewport.

Completion rule: emit `done: true` only when every part of the goal is finished. \
An unfinished sub-goal means `done: false`, even if one part succeeded.

Information extraction & reading tasks:
When asked to check, read, find, or show information (e.g. "show the most liked comment", "find the price of X", "read the summary"):
1. If the required information or section is not visible in the element list, scroll down (e.g. dy=800) with `done: false`.
2. Once the relevant information is visible, answer by emitting a `finish` action with status="success" and summary containing the complete answer, and set `done: true`.

Plan one step at a time. Emit at most four actions, and stop at any action whose result \
you cannot predict -- a click that navigates is the last action in a batch.

## The plan

A long task is a sequence of legs, and the device tracks them for you. When the request \
carries a "Plan:" section, it lists what the device believes this task is made of, which \
leg is current, how many attempts each has had and -- when one went wrong -- an abstract \
reason why. Work on the current leg. Do not start a later one on the strength of what the \
page looked like two steps ago.

You may return a `plan` array to replace that decomposition. Do so when the page turns \
out not to work the way the plan assumed: a filter that does not exist, a search that \
needed a category first, a leg that is already satisfied. Otherwise omit `plan` entirely \
and the device keeps the one it has.

Each entry is:
  id        short and stable. Reuse the id of a leg you are keeping, or its progress is
            lost and the device will run it again. Invent ids only for new legs.
  kind      navigate | search | filter | inspect | select | interact | submit | confirm
  intent    one line, in the same placeholdered vocabulary as everything else
  after     ids that must finish first
  criteria  what the device should *observe* to call the leg done: url-changed,
            element-present, element-gone, field-filled, text-present, action-verified,
            each with a short hint naming a label or a role
  budget    steps this leg may take before the device gives up on it (1-10)

A failure reason on a leg is a fact about the page, not a scolding. `no-effect` means the \
click landed and nothing changed -- try a different control, not the same one. `ambiguous` \
means several candidates fit -- narrow before selecting. `target-missing` means what you \
named is gone -- re-read the element list.

Never encode a value in a plan. `intent` and `hint` are read by humans and stored on the \
device; they take placeholders, never the thing behind them.

Respond only with the provided JSON schema.
"""

# The guillemets the extension actually uses. Written this way so the file stays ASCII
# and the prompt still shows the real token shape to the model.
SYSTEM_PROMPT = SYSTEM_PROMPT.replace("<<", "«").replace(">>", "»")

# Two worked examples.
#
# Example 1: the redaction / skipping case -- the model must see a filled redacted field
# being *skipped* rather than refilled, or it will treat a masked value as a blank.
#
# Example 2: a multi-step navigation task -- the model must see that it can navigate to
# a URL, that done=false keeps the task alive across page changes, and that it should
# keep acting until the whole goal is achieved (not just the first part).
WORKED_EXAMPLE_USER = """\
Task: Complete the scholarship application from my saved profile
Step 4 on gov.in

Elements:
[3]<input type="text" aria-label="Full name" value="<<PERSON_1>>" filled />
[4]<input type="text" aria-label="Aadhaar number" value="<<AADHAAR_1>>" filled />
[6]<input type="email" placeholder="Email address" required />
*[8]<div role="alert">Email is required</div>
[9]<button type="submit">Save and continue</button>

Redaction manifest: 2 findings
  AADHAAR x1  mask  L0:autocomplete
  PERSON x1   mask  L1:label-person
Placeholders in play: PERSON_1, AADHAAR_1, EMAIL_1
""".replace("<<", "«").replace(">>", "»")

WORKED_EXAMPLE_ASSISTANT = json.dumps(
    {
        "protocolVersion": 1,
        "stepIndex": 4,
        "rationale": (
            "Name and Aadhaar are filled -- the manifest says both were redacted, not "
            "left empty, so they do not need re-entering. Email at [6] is empty and [8] "
            "is complaining about it, so fill it with the known address and submit."
        ),
        "actions": [
            {"type": "type", "index": 6, "text": "«EMAIL_1»", "submit": False},
            {"type": "click", "index": 9},
        ],
        "done": False,
    },
    ensure_ascii=False,
)

# Example 2: multi-step navigation task.
# Step 1 — the agent is on a blank/unrelated page and must navigate first.
MULTI_STEP_EXAMPLE_USER_1 = """\
Task: Open Spotify web and search for Blinding Lights by The Weeknd and play it
Step 1 on about:blank

Elements:
(no interactive elements)

Redaction manifest: 0 redacted, 0 detected but left visible
Redacted 0.0% of the viewport (0.0% of that covered nothing)

History:
No previous steps.
"""

MULTI_STEP_EXAMPLE_ASSISTANT_1 = json.dumps(
    {
        "protocolVersion": 1,
        "stepIndex": 1,
        "rationale": (
            "The task requires Spotify. The current page has no relevant elements. "
            "Navigate to Spotify Web Player first; subsequent steps will handle the search."
        ),
        "actions": [{"type": "navigate", "url": "https://open.spotify.com"}],
        "done": False,
    },
    ensure_ascii=False,
)

# Step 2 — Spotify loaded. Search box is visible. Type and submit.
MULTI_STEP_EXAMPLE_USER_2 = """\
Task: Open Spotify web and search for Blinding Lights by The Weeknd and play it
Step 2 on open.spotify.com -- Spotify Web Player (1280x800)

Elements:
[2]<link aria-label="Home" />
[5]<searchbox aria-label="Search" />
[8]<button aria-label="Create playlist" />

Redaction manifest: 0 redacted, 0 detected but left visible
Redacted 0.0% of the viewport (0.0% of that covered nothing)

History:
  step 1: navigate -> ok
"""

MULTI_STEP_EXAMPLE_ASSISTANT_2 = json.dumps(
    {
        "protocolVersion": 1,
        "stepIndex": 2,
        "rationale": (
            "Spotify loaded. The search box [5] is visible. "
            "Type the song name and press Enter to search."
        ),
        "actions": [
            {"type": "type", "index": 5, "text": "Blinding Lights The Weeknd", "submit": True}
        ],
        "done": False,
    },
    ensure_ascii=False,
)

# Step 3 — Search results are visible. Find the track and click Play.
MULTI_STEP_EXAMPLE_USER_3 = """\
Task: Open Spotify web and search for Blinding Lights by The Weeknd and play it
Step 3 on open.spotify.com -- Search Results (1280x800)

Elements:
[10]<heading>Blinding Lights</heading>
[11]<text>The Weeknd</text>
[12]<button aria-label="Play Blinding Lights by The Weeknd" />
[15]<text>Save Your Tears</text>
[16]<button aria-label="Play Save Your Tears by The Weeknd" />

Redaction manifest: 0 redacted, 0 detected but left visible
Redacted 0.0% of the viewport (0.0% of that covered nothing)

History:
  step 1: navigate -> ok
  step 2: type [5] -> ok
"""

MULTI_STEP_EXAMPLE_ASSISTANT_3 = json.dumps(
    {
        "protocolVersion": 1,
        "stepIndex": 3,
        "rationale": (
            "Search results show Blinding Lights by The Weeknd at [10]-[12]. "
            "Click the Play button [12] to start the track. Task will be complete."
        ),
        "actions": [{"type": "click", "index": 12}],
        "done": True,
    },
    ensure_ascii=False,
)

# Example 3: scrolling to find information (e.g. comments, reviews, prices) and finishing with a summary
SCROLL_INFO_EXAMPLE_USER_1 = """\
Task: scroll and check comment section and show the most liked comment
Step 1 on youtube.com -- Video Title (1280x800)

Elements:
[1]<video aria-label="Video player" />
[3]<heading>How to Build Autonomous AI Agents</heading>
[4]<button aria-label="Like this video along with 45K other people" />
[5]<button aria-label="Subscribe to TechChannel" />

Redaction manifest: 0 redacted, 0 detected but left visible
Redacted 0.0% of the viewport (0.0% of that covered nothing)

History:
No previous steps.
"""

SCROLL_INFO_EXAMPLE_ASSISTANT_1 = json.dumps(
    {
        "protocolVersion": 1,
        "stepIndex": 1,
        "rationale": (
            "The user wants to find the most liked comment. The comments section is not yet "
            "in the current viewport. Scroll down to trigger loading the comments."
        ),
        "actions": [{"type": "scroll", "dy": 800}],
        "done": False,
    },
    ensure_ascii=False,
)

SCROLL_INFO_EXAMPLE_USER_2 = """\
Task: scroll and check comment section and show the most liked comment
Step 2 on youtube.com -- Video Title (1280x800)

Elements:
[10]<heading>Comments (1,240)</heading>
[12]<text>@code_master</text>
[13]<text>The architecture explanation at 5:20 was gold!</text>
[14]<text>8.4K likes</text>
[16]<text>@dev_user</text>
[17]<text>Great tutorial as always</text>
[18]<text>320 likes</text>

Redaction manifest: 0 redacted, 0 detected but left visible
Redacted 0.0% of the viewport (0.0% of that covered nothing)

History:
  step 1: scroll -> ok
"""

SCROLL_INFO_EXAMPLE_ASSISTANT_2 = json.dumps(
    {
        "protocolVersion": 1,
        "stepIndex": 2,
        "rationale": (
            "Comments are now visible. The most liked comment is by @code_master with 8.4K likes: "
            "'The architecture explanation at 5:20 was gold!'. Finish with this answer."
        ),
        "actions": [
            {
                "type": "finish",
                "status": "success",
                "summary": "Most liked comment by @code_master (8.4K likes): 'The architecture explanation at 5:20 was gold!'",
            }
        ],
        "done": True,
    },
    ensure_ascii=False,
)


# ── Rendering a request into a prompt ─────────────────────────────────────────


def render_elements(elements: list[dict[str, Any]]) -> str:
    """One line per element, the shape the client already serialises for the overlay.

    `hidden` is not decoration. Perception keeps validation-relevant nodes -- anything
    with role=alert, role=status or aria-invalid -- even when they are not displayed,
    because after a failed submit the error message is the most useful thing on the page
    and an agent that cannot see it refills a form it has already filled. That rule has
    a counterpart nobody had written down: page B ships

        <p id="done-note" hidden role="status">Application submitted.</p>

    and this function used to render it as ordinary page content, on a form that had not
    been submitted. The device knew -- `state.visible` was false all along -- and the
    prompt threw the bit away, which is the worst possible place to lose it: a planner
    reading "Application submitted." has every reason to stop.
    """
    lines = []
    for el in elements:
        index = el.get("index")
        marker = "*" if el.get("isNew") else ""
        head = f"{marker}[{index}]" if index is not None else "    "

        attrs = []
        if el.get("name"):
            attrs.append(f'aria-label="{el["name"]}"')
        value = el.get("value")
        if value is not None:
            attrs.append(f'value="{value}"')

        state = el.get("state", {})
        for flag in ("filled", "required", "invalid", "checked", "expanded", "readonly"):
            if state.get(flag):
                attrs.append(flag)
        if not state.get("enabled", True):
            attrs.append("disabled")
        if not state.get("visible", True):
            attrs.append("hidden")
        if el.get("occluded", 0) > 0:
            attrs.append(f'occluded={el["occluded"]:.1f}')

        joined = (" " + " ".join(attrs)) if attrs else ""
        lines.append(f"{head}<{el.get('role', 'other')}{joined} />")
    return "\n".join(lines)


def render_manifest(manifest: dict[str, Any]) -> str:
    """
    What was removed, by which detector, and what was deliberately left.

    Without this the agent re-types an Aadhaar number into a field that already has one,
    in front of the judges. It is the reason the manifest is on the wire at all.
    """
    findings = manifest.get("findings", [])
    painted = [f for f in findings if f.get("mode") != "keep"]
    kept = [f for f in findings if f.get("mode") == "keep"]

    lines = [f"Redaction manifest: {len(painted)} redacted, {len(kept)} detected but left visible"]
    for finding in painted[:24]:
        lines.append(
            f"  {finding['cls']:9s} {finding.get('mode', 'mask'):8s} "
            f"{finding.get('layer', '?')}:{finding.get('reason', '')}"
        )
    for finding in kept[:8]:
        lines.append(f"  {finding['cls']:9s} keep     {finding.get('reason', '')}")

    placeholders = sorted({f["placeholder"] for f in findings if f.get("placeholder")})
    if placeholders:
        lines.append("Placeholders in play: " + ", ".join(placeholders))

    redacted = manifest.get("redactedFraction", 0)
    over = manifest.get("overRedactedFraction", 0)
    lines.append(f"Redacted {redacted:.1%} of the viewport ({over:.1%} of that covered nothing)")
    return "\n".join(lines)


# ── History, trimmed ──────────────────────────────────────────────────────────

KEEP_STEPS = 3


def render_history(history: list[dict[str, Any]]) -> str:
    """
    The task, the last three steps, and a count of what came before.

    Twelve full element lists exhaust the context and slow every step after the fourth.
    A summary line costs nothing and keeps step 12 the same size as step 4, which is
    acceptance criterion 6.
    """
    if not history:
        return "No previous steps."

    recent = history[-KEEP_STEPS:]
    earlier = len(history) - len(recent)

    lines = []
    if earlier > 0:
        outcomes = [h.get("outcome", "?") for h in history[:earlier]]
        ok = sum(1 for o in outcomes if o == "ok")
        lines.append(f"{earlier} earlier steps ({ok} succeeded, {earlier - ok} did not).")
    for entry in recent:
        lines.append(f"  step {entry.get('stepIndex')}: {entry.get('action')} -> {entry.get('outcome')}")
    return "\n".join(lines)


def render_intents(intents: list[dict[str, Any]]) -> str:
    """What the device understood the user to want, when it understood anything.

    The device resolves what it can on its own -- a named field with a clear match never
    reaches here at all -- so an intent arriving with a request means the device tried and
    could not decide. Saying so turns "here is a page, guess" into "the user asked to fill
    the first-name field and I could not tell which of these two it is", which is a far
    easier question and a far better answer.

    Verbs and field names only. The value, when there was one, is a placeholder: the
    planner needs to know *where*, never *what*.
    """
    if not intents:
        return ""
    lines = ["The user's request, as the device parsed it:"]
    for intent in intents:
        target = intent.get("target", "")
        ref = intent.get("valueRef")
        lines.append(f"  {intent.get('verb', '?')} {target}" + (f" = {ref}" if ref else ""))
    lines.append(
        "The device could not resolve this on its own, which is why you are being asked."
    )
    return "\n".join(lines)


def render_plan(plan: list[dict[str, Any]]) -> str:
    """The device's decomposition, and what has become of each leg.

    Sent so that replanning is informed rather than blind. A planner told only "the last
    step failed" proposes the leg that just failed; told "select has been attempted twice
    and reports ambiguous", it can propose the filter that would separate the candidates.

    Statuses, counts and abstract failure reasons -- the same enums the device stores. No
    page content passes through here that did not already pass through the element list.
    """
    if not plan:
        return ""

    lines = ["Plan:"]
    for leg in plan:
        status = leg.get("status", "?")
        marker = {
            "done": "x",
            "active": ">",
            "failed": "!",
            "skipped": "-",
        }.get(status, " ")
        detail = f"{leg.get('kind', '?')}: {leg.get('intent', '')}"
        tries = f" ({leg.get('attempts', 0)}/{leg.get('budget', 0)} attempts)"
        why = f" -- {leg['failure']}" if leg.get("failure") else ""
        lines.append(f"  [{marker}] {leg.get('id', '?')} {detail}{tries}{why}")

    current = next((leg for leg in plan if leg.get("status") == "active"), None)
    if current is not None:
        lines.append(f"Current leg: {current.get('id')}. Act on this one.")
    lines.append(
        "Return a `plan` array only if this decomposition no longer fits the page; "
        "keep the ids of any leg you are keeping."
    )
    return "\n".join(lines)


def build_user_message(request: dict[str, Any]) -> str:
    viewport = request.get("viewport", {})
    # Empty sections are dropped rather than joined, or an open-ended task -- which has no
    # intent by definition -- would get a blank paragraph where the instruction should be.
    return "\n\n".join(
        part
        for part in [
            f"Task: {request.get('goal', '')}",
            render_intents(request.get("intents", [])),
            f"Step {request.get('stepIndex')} on {request.get('origin', 'unknown origin')}"
            f" -- {request.get('title', '')}"
            f" ({viewport.get('w')}x{viewport.get('h')})",
            "Elements:\n" + render_elements(request.get("elements", [])),
            render_manifest(request.get("manifest", {})),
            render_plan(request.get("plan", [])),
            "History:\n" + render_history(request.get("history", [])),
        ]
        if part
    )


# ── The fast path ─────────────────────────────────────────────────────────────


#: Roles whose content lives in pixels rather than in the DOM.
VISUAL_ROLES = frozenset({"image", "canvas", "video"})


def needs_image(request: dict[str, Any]) -> bool:
    """
    Does this step need the picture at all?

    Most steps on an ordinary form do not: the DOM has already done the perception, and
    the element list says everything the planner will use. The image earns its place only
    when something on screen is *not* accounted for by the element list.

    ## What "not accounted for" means, and what it used to mean

    This asked whether any element had no `index`, and that was right until M3b. M3b added
    a third admission class -- text-bearing blocks, which carry a page's prose and are the
    only reason a displayed Aadhaar number is ever detected. Those are deliberately
    unindexed: they are content, not controls, and nothing can click one. But their text
    is right there in `name`, so they are *described* as completely as anything on the
    page.

    The consequence was not subtle and it was invisible from either end. Measured over the
    ten replica pages in eval/report/runs: 10 out of 10 asked for the image, 22 to 56
    unindexed elements apiece, and **not one** of them anything but `text` or `heading`.
    The fast path -- a headline claim about this design, and the thing that makes a
    text-only model viable at all -- had never once fired.

    So the question is asked properly now: is there something on screen whose content the
    list cannot carry?

      an element recovered from pixels     L3 read it, so the DOM did not have it
      an L3 finding                        same, from the detection side
      an unnamed image, canvas or video    pixels with no text anywhere to describe them

    A named `<img>` is excluded on purpose: its alt text is the description, and that is
    exactly the case the accessibility tree exists to serve. An unnamed one is a
    photograph, a scanned document, a chart -- and no amount of DOM will say what is in it.
    """
    elements = request.get("elements", [])

    for el in elements:
        if el.get("fromPixels"):
            return True
        if el.get("role") in VISUAL_ROLES and not (el.get("name") or "").strip():
            return True

    findings = request.get("manifest", {}).get("findings", [])
    return any(f.get("layer") == "L3" for f in findings)


# ── Planners ──────────────────────────────────────────────────────────────────


@dataclass
class PlanResult:
    plan: dict[str, Any]
    used_image: bool
    model_ms: float
    prompt_chars: int
    retries: int = 0


class Planner(Protocol):
    def plan(self, request: dict[str, Any], image: bytes | None) -> PlanResult: ...


#: Buttons that carry a form forward, and buttons that undo the last thing that happened.
#: Accessible names only -- the stub sees exactly what the planner sees, which is the
#: element list, so it cannot cheat by looking at the DOM.
#:
#: A bare `save` is deliberately not here. Page A's actions row is `Save draft` beside
#: `Save and continue`, in that order, and matching `save` picks the first: a button that
#: is genuinely inert, clicked over and over, with every click reported as a success
#: because clicking it *did* succeed. `save and` is the phrase that means progress.
ADVANCING_BUTTON = re.compile(
    r"\b(continue|submit|next|proceed|apply|confirm|finish|done|save and)\b", re.I
)

#: Undo, dismiss, or otherwise leave. Preferred last, and never over an advancing button.
#: `draft` is here because saving one is the opposite of submitting the form.
RETREATING_BUTTON = re.compile(
    r"\b(cancel|close|back|dismiss|reject|reset|clear|draft|logout|sign out)\b", re.I
)


@dataclass
class StubPlanner:
    """
    Canned, schema-valid plans. No GPU, no model, no network.

    Shipped first on purpose: M9's executor does not care what produced a plan, and a
    client team blocked on hardware is a week lost. The actions are chosen to exercise
    the interesting paths rather than to be clever -- fill the first empty field, then
    press on through the form, then finish.

    "Press on" is doing real work in that sentence, and both halves of it were learned
    from watching this planner drive the demo.

    It used to click the first button it found, which on the demo's own page A is
    `Verify identity` in the header: that opens a modal, the modal's OTP box becomes the
    first empty field, the stub fills it, the next button is `Cancel`, and the run
    oscillates between the two until the step budget ends it. So a button that carries a
    form forward is preferred over one that merely happens to be first.

    And perception is viewport-bounded by design -- the planner is shown what the
    screenshot shows -- so on a form longer than the window, `Save and continue` is not
    in the element list at all until the page is scrolled. A stub that cannot scroll
    cannot finish any real form, which made the one planner that needs no GPU the one
    that could not complete the demo.
    """

    calls: int = 0
    #: Consecutive scrolls that found nothing new. Two is the whole page's worth on the
    #: demo forms; past that the stub is scrolling because it has run out of ideas, and
    #: saying so is better than riding the step budget down to zero.
    barren_scrolls: int = 0
    #: Sessions in which a custom dropdown has already been operated.
    #:
    #: A custom combobox reports no value. A native <select> exposes `selectedIndex`, but
    #: `<button role="combobox"><span>Select a scheme</span></button>` puts its value in
    #: its own text, and the device does not put page text on the wire -- `value` carries
    #: a placeholder or nothing, which is what keeps raw content off the network. So
    #: after choosing an option the element list looks exactly as it did before, and a
    #: planner going by the page alone reopens the dropdown for ever.
    #:
    #: A real planner has its own history to remember by. The stub keeps this instead --
    #: one bit per session, and it stays on the server, where the request already says
    #: which session it belongs to.
    operated_combobox: set = field(default_factory=set)
    #: session -> (what the page looked like, what we did about it) on the previous step.
    #:
    #: The stub is a pure function of the element list, which means that once the page
    #: stops responding it re-derives the same action for ever. On page B that is exactly
    #: what happens: `Submit application` works on the first click, the confirmation
    #: appears as a text element, the form itself is unchanged, and the stub -- having no
    #: memory -- clicks Submit again, and again, until the client's step budget ends the
    #: run twenty-five steps later.
    #:
    #: One step of memory is enough to notice. If the page came back identical *and* we
    #: are about to repeat ourselves, the last action achieved nothing and saying so is
    #: the honest end of the run.
    last_move: dict = field(default_factory=dict)

    def plan(self, request: dict[str, Any], image: bytes | None) -> PlanResult:
        started = time.perf_counter()
        self.calls += 1
        elements = request.get("elements", [])
        step = request.get("stepIndex", 0)

        empty = next(
            (
                el
                for el in elements
                if el.get("index") is not None
                and el.get("role") in ("textbox", "searchbox")
                and not el.get("state", {}).get("filled")
            ),
            None,
        )
        buttons = [
            el for el in elements if el.get("index") is not None and el.get("role") == "button"
        ]
        button = next(
            (el for el in buttons if ADVANCING_BUTTON.search(el.get("name", "") or "")),
            None,
        ) or next(
            (el for el in buttons if not RETREATING_BUTTON.search(el.get("name", "") or "")),
            None,
        )

        advancing = button is not None and ADVANCING_BUTTON.search(button.get("name", "") or "")

        # A custom dropdown, mid-operation. Its options do not exist in the DOM until it
        # is opened, so this is the one thing the stub does that is genuinely two steps:
        # click, let the page settle, look again, click what is now there. Handled before
        # buttons because an open listbox is a page waiting on an answer.
        option = next(
            (el for el in elements if el.get("index") is not None and el.get("role") == "option"),
            None,
        )
        # `expanded is False` -- explicitly, not falsy. A native <select> is also role
        # combobox and carries no aria-expanded at all, so `not expanded` is true for it
        # for ever: the stub clicked page A's State dropdown until the step budget ran
        # out, because a native select opens a popup the DOM does not contain and there
        # was never an option element to find. `aria-expanded="false"` is precisely the
        # signature of the custom dropdown this branch is for.
        session = request.get("sessionId", "")
        combobox = next(
            (
                el
                for el in elements
                if el.get("index") is not None
                and el.get("role") == "combobox"
                and el.get("state", {}).get("expanded") is False
                and session not in self.operated_combobox
            ),
            None,
        )

        if option is not None:
            self.barren_scrolls = 0
            self.operated_combobox.add(session)
            actions = [{"type": "click", "index": option["index"]}]
            rationale = f"[stub] A listbox is open; choosing [{option['index']}]."
            done = False
        elif combobox is not None:
            self.barren_scrolls = 0
            actions = [{"type": "click", "index": combobox["index"]}]
            rationale = (
                f"[stub] [{combobox['index']}] is an unset dropdown; opening it. Its "
                "options are not in the DOM until it is."
            )
            done = False
        elif empty is not None:
            self.barren_scrolls = 0
            token = _first_placeholder(request, "EMAIL")
            text = token or "applicant@example.in"
            actions = [{"type": "type", "index": empty["index"], "text": text, "submit": False}]
            rationale = (
                f"[stub] Field [{empty['index']}] is empty; filling it with "
                + (f"{token}." if token else "a literal, no EMAIL placeholder in play.")
            )
            done = False
        elif advancing:
            self.barren_scrolls = 0
            actions = [{"type": "click", "index": button["index"]}]
            rationale = f"[stub] Nothing left to fill in view; clicking [{button['index']}]."
            done = False
        elif elements and self.barren_scrolls < 2:
            # Nothing to fill and nothing that carries the form forward -- but the form
            # may simply continue below the fold, where perception correctly cannot see
            # it. Look further before concluding there is nothing to do.
            #
            # Only when the page showed *something*. An empty element list is not a page
            # whose interesting part is elsewhere, it is a page with nothing on it, and
            # scrolling an empty page twice before saying so helps nobody.
            self.barren_scrolls += 1
            actions = [{"type": "scroll", "dy": 600}]
            rationale = "[stub] Nothing actionable in view; scrolling down to look."
            done = False
        elif button is not None:
            self.barren_scrolls = 0
            actions = [{"type": "click", "index": button["index"]}]
            rationale = f"[stub] Nothing better in reach; clicking [{button['index']}]."
            done = False
        else:
            actions = [{"type": "finish", "status": "success", "summary": "[stub] nothing to do"}]
            rationale = "[stub] No actionable elements."
            done = True

        # One step of memory, applied last so it can veto whatever the rules above chose.
        # An unchanged page plus the same action is an action that did nothing, and the
        # stub has no other way to find that out -- it is a pure function of the element
        # list, so it will keep deriving the same move until something stops it.
        fingerprint = json.dumps(elements, sort_keys=True)
        move = json.dumps(actions, sort_keys=True)
        repeating = self.last_move.get(session) == (fingerprint, move)
        self.last_move[session] = (fingerprint, move)

        if repeating:
            actions = [
                {
                    "type": "finish",
                    "status": "blocked",
                    "summary": (
                        "[stub] the page did not change after the last action, and this "
                        "planner has nothing else to try"
                    ),
                }
            ]
            rationale = "[stub] Repeating myself against an unchanged page; stopping."
            done = True

        plan = {
            "protocolVersion": 1,
            "stepIndex": step,
            "rationale": rationale,
            "actions": actions,
            "done": done,
        }
        return PlanResult(
            plan=plan,
            used_image=image is not None,
            model_ms=(time.perf_counter() - started) * 1000,
            prompt_chars=0,
        )


def _first_placeholder(request: dict[str, Any], cls: str) -> str | None:
    """A token of this class that the device actually issued, or None.

    Both places one can appear are checked, and the second is not optional. The manifest
    lists what the gate removed from the *picture*; the goal carries what the device
    substituted out of the operator's own sentence (extension/src/worker/goal.ts), and an
    empty email field on a page whose email is empty has no manifest finding to offer --
    the value the demo types comes from the goal.

    Returning None rather than a plausible guess is the whole point. A stub that emits
    «EMAIL_1» on the assumption that one exists produces `unknown-placeholder`, which is
    the extension correctly refusing a token this session never issued -- a real failure
    with an invented cause, in the one part of the demo that is meant to show the
    rehydration working.
    """
    for finding in request.get("manifest", {}).get("findings", []):
        token = finding.get("placeholder")
        if token and finding.get("cls") == cls:
            return token

    match = re.search(rf"«{cls}_\d+»", str(request.get("goal", "")))
    return match.group(0) if match else None


def completion_text(message: dict[str, Any]) -> str:
    """
    The model's answer, from whichever field the backend put it in.

    Normally `content`. But Ollama splits a thinking model's output into `reasoning` and
    `content` by looking for a <think> block, and `reasoning_effort: "none"` makes
    qwen3-vl stop emitting one -- at which point the parser classifies the *entire*
    answer as reasoning and hands back empty content.

    Measured, not guessed: with reasoning off the model returned
    `{"protocolVersion":1,"stepIndex":1,"actions":[{"type":"type","index":4,...}]}` --
    a correct, schema-valid plan -- in `reasoning`, with `content` an empty string and
    finish_reason "stop". A perfectly good plan, in the wrong envelope.

    So: prefer content, fall back to reasoning only when content is empty. A model that
    genuinely thinks fills content too, and keeps this path untouched.
    """
    content = (message.get("content") or "").strip()
    if content:
        return content
    return (message.get("reasoning") or "").strip()


@dataclass
class VlmPlanner:
    """
    Qwen3-VL-Instruct over an OpenAI-compatible /chat/completions endpoint.

    The planner is a VLM and cannot be a text-only model: the image is attached exactly
    when something on screen is not in the element list, and a model without vision input
    fails those steps at the backend ("Multimodal data provided, but model does not
    support multimodal requests"). A text model like `qwen3:0.6b` is only good enough for
    fast-path DOM-only steps -- measure, don't assume. If a step ever needs the picture,
    serve a vision model (`qwen3-vl:4b`).

    Two deployments speak that protocol and both are supported, because they answer
    different questions:

      vLLM     the target. A GPU, the full 4B-Instruct weights, xgrammar doing the
               guided decoding. What the submission runs on.
      Ollama   the same model family on a laptop, and the reason the prompt can be
               exercised at all before GPU time is available. Local, so invariant 1
               holds exactly as it does for vLLM: no hosted API, ever.

    The protocol really is the same -- base URL and model name are the difference -- so
    this is one class with two configurations rather than two classes with one
    difference. `name` exists so /health says which is answering, because "the plans got
    worse" and "the backend changed" must never look alike from outside.

    Instruct, never Thinking: this asks for a short structured plan, and a reasoning
    trace is tokens paid for and thrown away. Guided decoding against the generated
    schema is not optional -- server/check_guided_decoding.py verifies the grammar
    compiles and accepts every action shape before any of this runs. Verified against
    Ollama too: the nine-branch oneOf is honoured there, and a 0.6B model that gets the
    plan wrong still cannot get the *shape* wrong.

    "Instruct, never Thinking" turned out to be a requirement rather than a preference,
    and the two deployments enforce it differently. vLLM is pointed at the Instruct
    weights, which do not think. Ollama publishes `qwen3-vl:4b` as the *thinking*
    variant, and on the first real run it spent all 512 completion tokens reasoning,
    returned empty content, and the step died on a JSONDecodeError -- a model failure
    that arrives looking like a transport bug.

    `reasoning_effort: "none"` is what Ollama honours (measured: reasoning falls to zero
    and generation gets *faster*). `think: false` is not accepted on the OpenAI-compatible
    endpoint and makes it worse -- it ran to the token ceiling. So the setting lives in
    `extra_body`, per backend, rather than being sent to both and hoped for.
    """

    base_url: str = "http://vllm:8000/v1"
    model: str = "Qwen/Qwen3-VL-4B-Instruct"
    schema: dict[str, Any] = field(default_factory=dict)
    timeout_s: float = 30.0
    max_tokens: int = 512
    transport: Any = None  # injected for tests; an httpx.Client in production
    #: Which deployment this is, for /health. Not sent to the model.
    name: str = "vllm"
    #: Backend-specific request fields. The one real difference between the two
    #: deployments, and it is not cosmetic -- see the note on thinking below.
    extra_body: dict[str, Any] = field(default_factory=dict)

    def messages(self, request: dict[str, Any], image: bytes | None) -> list[dict[str, Any]]:
        user_text = build_user_message(request)
        content: list[dict[str, Any]] | str

        if image is None:
            content = user_text
        else:
            import base64

            mime = request.get("capture", {}).get("mime", "image/webp")
            encoded = base64.b64encode(image).decode("ascii")
            content = [
                {"type": "text", "text": user_text},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{encoded}"}},
            ]

        return [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": WORKED_EXAMPLE_USER},
            {"role": "assistant", "content": WORKED_EXAMPLE_ASSISTANT},
            {"role": "user", "content": MULTI_STEP_EXAMPLE_USER_1},
            {"role": "assistant", "content": MULTI_STEP_EXAMPLE_ASSISTANT_1},
            {"role": "user", "content": MULTI_STEP_EXAMPLE_USER_2},
            {"role": "assistant", "content": MULTI_STEP_EXAMPLE_ASSISTANT_2},
            {"role": "user", "content": MULTI_STEP_EXAMPLE_USER_3},
            {"role": "assistant", "content": MULTI_STEP_EXAMPLE_ASSISTANT_3},
            {"role": "user", "content": SCROLL_INFO_EXAMPLE_USER_1},
            {"role": "assistant", "content": SCROLL_INFO_EXAMPLE_ASSISTANT_1},
            {"role": "user", "content": SCROLL_INFO_EXAMPLE_USER_2},
            {"role": "assistant", "content": SCROLL_INFO_EXAMPLE_ASSISTANT_2},
            {"role": "user", "content": content},
        ]

    def plan(self, request: dict[str, Any], image: bytes | None) -> PlanResult:
        messages = self.messages(request, image)
        body = {
            "model": self.model,
            "messages": messages,
            "max_tokens": self.max_tokens,
            "temperature": 0.2,
            # vLLM rejects $schema and $comment at the root.
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "step_response", "schema": self.schema, "strict": True},
            },
            **self.extra_body,
        }

        started = time.perf_counter()
        reply = self.transport.post(f"{self.base_url}/chat/completions", json=body, timeout=self.timeout_s)
        reply.raise_for_status()
        payload = reply.json()
        model_ms = (time.perf_counter() - started) * 1000

        text = completion_text(payload["choices"][0]["message"])
        plan = json.loads(text)
        # The client asked for this step; the model does not get to renumber it.
        plan["stepIndex"] = request.get("stepIndex", plan.get("stepIndex", 0))

        prompt_chars = sum(len(json.dumps(m["content"])) for m in messages)
        return PlanResult(
            plan=plan,
            used_image=image is not None,
            model_ms=model_ms,
            prompt_chars=prompt_chars,
        )


@dataclass
class RoutingPlanner:
    """
    Two models, and one question decides between them: does this step need to see?

    ## Why two

    A step's prompt is 1.2-1.7 k tokens of element list and its answer is fifty tokens of
    JSON. Nothing about that needs vision -- unless the page is showing something the DOM
    cannot describe, which is precisely what `needs_image` is for. Serving those two
    cases from one 4B vision model means every ordinary form step pays for a vision tower
    it does not use.

    Measured on this project's own recorded steps, on a laptop with no CUDA:

        qwen3:0.6b       522 MB   median  9.6 s   4/4 schema-valid, indices real
        qwen3-vl:4b      3.3 GB   see server/README.md -- minutes, on the same prompts

    On a GPU both are fast and the argument is about resident bytes instead: 522 MB
    against 3.3 GB, on the path that runs almost every step.

    ## Why this is not the "two resident models" trade it looks like

    `needs_image` used to be true on every step, so a reader could reasonably conclude
    that routing buys nothing and costs a second model in memory. It was true on every
    step because it was wrong -- it counted unindexed text blocks as unexplained pixels.
    Fixed, it is false on every DOM page in the corpus, which turns the arithmetic around:
    the vision model is not a second resident model, it is one that is *not loaded* until
    a page actually shows something only a picture can carry. Ollama unloads on its own
    keep-alive, so the steady state on a form is the small model alone.

    ## Why the decision is not made here

    `app.py` already asked, and already dropped the image when the answer was no. Asking
    again would be a second copy of a rule that decides what crosses the network, and two
    copies of that rule is one more than this project can defend. So: an image means the
    step needed one.
    """

    text: Planner
    vision: Planner
    #: For /health, which must be able to say what is answering.
    name: str = "routed"

    @property
    def model(self) -> str:
        """Both, named. /health has to distinguish a routing change from a model change."""
        text = getattr(self.text, "model", "?")
        vision = getattr(self.vision, "model", "?")
        return f"{text} (text) + {vision} (vision)"

    def plan(self, request: dict[str, Any], image: bytes | None) -> PlanResult:
        return (self.vision if image is not None else self.text).plan(request, image)
