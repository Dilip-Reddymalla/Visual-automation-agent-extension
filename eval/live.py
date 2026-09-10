"""The extension against real websites, read-only.

    python eval/live.py                      # every site, read-only
    python eval/live.py --only amazon-*      # a subset
    python eval/live.py --headed             # watch it work
    python eval/live.py --allow-search       # also type into a site's own search box

## What this is for, and what it is not

`eval/harness.py` scores perception and redaction against a corpus whose ground truth was
measured by hand. `eval/scenarios.py` drives whole tasks against local fixtures that never
change. Both are reproducible, and neither tells you whether the thing works on a page
somebody else built.

This does. It is a *smoke test against reality*: does the content script attach, does the
walker survive a real page's DOM, does anything reach the gate, and does the payload that
leaves the machine carry what it should. It scores nothing, because there is no ground
truth for amazon.in and inventing one would be worse than having none.

Live sites change without telling anyone, so a failure here is a lead rather than a
verdict. Nothing in this file gates a release.

## What it will not do

Read-only by construction, not by good intentions. The planner used here can emit exactly
two actions -- `scroll` and `finish` -- so there is no path through this code that clicks,
types, submits, or navigates anywhere the site was not already going. `--allow-search`
adds one more: typing into a control the page itself calls a search box, on sites listed
as allowing it.

Beyond that:

  no sign-in, no passwords, no one-time codes, no payment details
  no carts, no bookings, no orders, no account changes
  no CAPTCHA solving -- a page that asks for one is recorded as blocked and skipped
  no crawling: one page per entry, no following links

The URL list is fixed in this file and every entry is a page a signed-out visitor sees.
`FORBIDDEN_PATH` refuses to open anything that looks like a checkout, a login or an
account page even if someone adds one later.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
import shutil
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from runner import browser, build, planner as planner_mod  # noqa: E402
from runner import run as runner_run  # noqa: E402

REPORT_DIR = HERE / "report"
RUNS = REPORT_DIR / "live"
REPORT = REPORT_DIR / "live.json"

#: Paths this will not open, whatever a caller asks for.
#:
#: Belt and braces: the site list below contains none of these, and this is what stops a
#: later edit from quietly adding one.
FORBIDDEN_PATH = re.compile(
    r"/(checkout|payment|pay|billing|order|orders|cart|basket|signin|sign-in|login|"
    r"log-in|register|signup|sign-up|account|profile|settings|logout|book|booking)\b",
    re.I,
)

#: How long one page gets: load, attach, perceive, capture, detect, seal, post.
#:
#: Generous compared with the corpus, and deliberately. A real page loads third-party
#: script for several seconds after `load` fires, and the thing being measured is whether
#: the extension copes with that rather than how fast it is.
PAGE_TIMEOUT_S = 120.0

#: How long a `--task` run gets instead.
#:
#: A read-only pass is one step. A real goal is a plan with several legs, and every leg
#: that tier 0's grammar cannot answer costs a local-model call -- ~30 s per step on a
#: machine with no GPU, which is the machine this was written on. Six legs at that rate do
#: not fit in two minutes, and a timeout that fires mid-plan reports "the plan did not
#: finish" about a harness clock rather than about the agent.
TASK_TIMEOUT_S = 420.0

VIEWPORT = {"width": 1366, "height": 900}


@dataclass
class Site:
    id: str
    url: str
    #: What this page is here to exercise, for the report.
    why: str
    #: May the agent type into this page's own search box? Never a login field.
    search: str | None = None


#: Public, signed-out pages. One per entry; nothing is followed.
SITES: list[Site] = [
    Site(
        id="wikipedia-article",
        url="https://en.wikipedia.org/wiki/Aadhaar",
        why="a long, stable, text-heavy page: the walker's baseline against real markup",
    ),
    Site(
        id="amazon-in-home",
        url="https://www.amazon.in/",
        why="a dense commercial page with a search box, carousels and lazy images",
        search="mobiles under 30000",
    ),
    Site(
        id="amazon-in-search",
        url="https://www.amazon.in/s?k=mobiles",
        why="a results grid: repeated cards with prices, which the candidate reader is for",
    ),
    Site(
        id="irctc-train-search",
        url="https://www.irctc.co.in/nget/train-search",
        why="an Angular single-page app that renders after load: the settle detector's hard case",
    ),
    Site(
        id="indianrail-enquiry",
        url="https://www.indianrail.gov.in/enquiry/StaticPages/StaticEnquiry.jsp",
        why="an old-style government page: table layout, frames, inline styles",
    ),
    Site(
        id="india-gov-home",
        url="https://www.india.gov.in/",
        why="a government portal index: many links, few controls",
    ),
    Site(
        id="uidai-home",
        url="https://uidai.gov.in/",
        why="the Aadhaar authority's own site, where the lexical detectors are most likely to fire",
    ),
    Site(
        id="incometax-home",
        url="https://www.incometax.gov.in/iec/foportal/",
        why="a heavy government SPA with a login entry point the agent must not touch",
    ),
]


# -- The planner: two actions, and that is the whole of it ---------------------


def read_only_plan(step: dict) -> dict:
    """Scroll a bit, then stop.

    The read-only guarantee lives here rather than in a policy document. A planner that
    can only emit `scroll` and `finish` cannot click a Buy button on the third step
    because of a page it misread, and no amount of care elsewhere gives that assurance as
    cheaply.

    Two steps per page: one to look, one to look slightly further down and finish. That is
    enough to exercise perception, capture, detection, the gate and the POST twice, which
    is what this is for.
    """
    index = step.get("stepIndex", 0)
    if index >= 1:
        return {
            "protocolVersion": step.get("protocolVersion", 1),
            "stepIndex": index,
            "rationale": "read-only smoke test: seen enough",
            "actions": [
                {"type": "finish", "status": "success", "summary": "read-only pass complete"}
            ],
            "done": True,
        }
    return {
        "protocolVersion": step.get("protocolVersion", 1),
        "stepIndex": index,
        "rationale": "read-only smoke test: looking further down the page",
        "actions": [{"type": "scroll", "dx": 0, "dy": 600}],
        "done": False,
    }


#: Controls this will never type into, whatever a page calls them.
NEVER_TYPE = re.compile(
    r"\b(password|passcode|otp|cvv|cvc|pin|secret|captcha|card|account|aadhaar|pan|"
    r"user\s*id|username|email|mobile|phone)\b",
    re.I,
)


def searching_plan(term: str):
    """Read-only plus one typed query into the page's own search box.

    Still no clicking: the query is typed with `submit` so the page's own form handles it,
    and if the page has no search box the plan degrades to the read-only one. A control
    whose name looks like a credential is never typed into -- the extension would refuse a
    SECRET-classed field anyway (CLAUDE.md invariant 6), and a harness that tried would be
    testing the refusal rather than the search.
    """

    def plan(step: dict) -> dict:
        index = step.get("stepIndex", 0)
        elements = [e for e in step.get("elements", []) if e.get("index") is not None]

        if index == 0:
            box = next(
                (
                    e
                    for e in elements
                    if e.get("role") in ("searchbox", "textbox")
                    and not e.get("state", {}).get("filled")
                    and not NEVER_TYPE.search(e.get("name", "") or "")
                    and (
                        e.get("role") == "searchbox"
                        or re.search(r"\bsearch\b", e.get("name", "") or "", re.I)
                    )
                ),
                None,
            )
            if box is not None:
                return {
                    "protocolVersion": step.get("protocolVersion", 1),
                    "stepIndex": index,
                    "rationale": f"typing the query into [{box['index']}]",
                    "actions": [
                        {"type": "type", "index": box["index"], "text": term, "submit": True}
                    ],
                    "done": False,
                }
        return read_only_plan(step)

    return plan


class PlanSwitch:
    """One callable for the planner server, whose behaviour is chosen per site.

    `PlannerServer` binds a single plan function for its lifetime, and the read-only
    guarantee is worth more than the convenience of a second server: whatever is set here,
    the *only* things that can come out are the actions `read_only_plan` and
    `searching_plan` emit.
    """

    def __init__(self) -> None:
        self.plan = read_only_plan

    def __call__(self, step: dict) -> dict:
        return self.plan(step)


#: Controls a live task will never operate, whatever a plan says.
#:
#: The read-only planner cannot click at all, so this exists for `--task`, where a real
#: goal drives a real planner against somebody else's site. A plan is post-filtered
#: against this before it is answered: matching actions are dropped and the step is
#: finished instead.
#:
#: Belt and braces on top of the goal. A goal that says "search for mobiles" has no
#: business clicking Buy now, and the way that goes wrong is never a deliberate decision --
#: it is a planner misreading a page and a harness that had nothing to stop it.
NEVER_OPERATE = re.compile(
    r"\b(buy|buy now|add to (cart|basket)|cart|basket|checkout|check out|place (your )?order|"
    r"order now|pay|payment|proceed to (pay|buy|checkout)|sign in|signin|log in|login|"
    r"register|sign up|subscribe|delete|remove|cancel booking|book now|continue to)\b",
    re.I,
)


def guarded(inner):
    """Wrap a planner so it cannot operate anything on the deny list.

    The filter is on the *answer*, not on the prompt, because that is the only place it
    is reliable: a planner asked to search may still return a click on whatever the page
    put under its nose, and the goal it was given says nothing about what it did.
    """

    def plan(step: dict) -> dict:
        answer = inner(step)
        by_index = {
            e["index"]: (e.get("name") or "")
            for e in step.get("elements", [])
            if e.get("index") is not None
        }

        kept, refused = [], []
        for action in answer.get("actions", []):
            index = action.get("index")
            name = by_index.get(index, "") if index is not None else ""
            if action.get("type") in ("click", "type", "select") and NEVER_OPERATE.search(name):
                refused.append(f"{action['type']} [{index}] {name[:40]!r}")
                continue
            kept.append(action)

        if refused:
            answer = dict(answer)
            answer["actions"] = [
                {
                    "type": "finish",
                    "status": "blocked",
                    "summary": "refused an action on a control this harness will not operate",
                }
            ]
            answer["rationale"] = "refused: " + "; ".join(refused)[:200]
            answer["done"] = True
        elif not kept:
            answer = dict(answer)
            answer["actions"] = [
                {"type": "finish", "status": "blocked", "summary": "nothing left to do"}
            ]
            answer["done"] = True
        else:
            answer = dict(answer)
            answer["actions"] = kept
        return answer

    return plan


# -- One site -----------------------------------------------------------------


@dataclass
class LiveResult:
    site_id: str
    url: str
    why: str
    ok: bool = False
    verdict: str = ""
    attached: bool = False
    status: str = ""
    steps: int = 0
    elements: int = 0
    posts: int = 0
    findings_by_class: dict = field(default_factory=dict)
    findings_by_layer: dict = field(default_factory=dict)
    redacted_fraction: float | None = None
    over_redacted_fraction: float | None = None
    phase_ms: dict = field(default_factory=dict)
    blocked: bool = False
    #: The phrase that decided it, when blocked.
    blocked_by: str = ""
    #: The site never served us a page at all. Not the same as a defect in the extension.
    unreachable: bool = False
    #: Steps that failed and were retried successfully. Not failures of the run.
    recovered: list = field(default_factory=list)
    console_errors: list = field(default_factory=list)
    #: The worker's own step log. Notes only -- field names, counts and enum values --
    #: and the only place the *reason* a phase failed is written in words.
    log: list = field(default_factory=list)
    #: How each leg of the decomposition ended. `--task` runs only.
    plan: list = field(default_factory=list)
    problems: list = field(default_factory=list)
    wall_ms: float = 0.0


#: Text that means the site is refusing a robot rather than serving a page.
BOT_WALL = re.compile(
    r"(enter the characters you see|type the characters|are you a robot|unusual traffic|"
    r"access denied|captcha|verify you are human)",
    re.I,
)


class LiveDriver:
    def __init__(self, driver, out: Path, task: bool = False, headed: bool = False) -> None:
        self.driver = driver
        self.out = out
        #: A real goal is being run, rather than the read-only reading pass.
        self.task = task
        #: Reported when a site refuses us, because for at least one site it is the reason.
        self.headed = headed

    def _state(self) -> dict:
        try:
            return (
                self.driver.worker.evaluate(
                    """async () => {
                         const all = await chrome.storage.session.get('agent-state');
                         return all['agent-state'] ?? null;
                       }"""
                )
                or {}
            )
        except Exception:
            return {}

    def run(self, site: Site, goal: str) -> LiveResult:
        started = time.time()
        folder = self.out / site.id
        folder.mkdir(parents=True, exist_ok=True)
        result = LiveResult(site_id=site.id, url=site.url, why=site.why)

        if FORBIDDEN_PATH.search(site.url):
            result.verdict = "refused: the URL looks like a checkout, login or account page"
            result.problems.append(result.verdict)
            return result

        tab = self.driver.context.new_page()
        errors: list[str] = []
        tab.on(
            "console",
            lambda m: errors.append(m.text[:300]) if m.type == "error" else None,
        )
        try:
            tab.set_viewport_size(VIEWPORT)
            try:
                tab.goto(site.url, wait_until="domcontentloaded", timeout=45_000)
            except Exception as err:
                # The message, not just the class. Playwright raises a bare `Error` for
                # a timeout, a DNS failure, a TLS refusal and a redirect loop alike, so
                # "could not load the page: Error" is a line nobody can act on -- which is
                # exactly what it produced the first time a real site refused to load.
                detail = " ".join(str(err).split())[:300]
                # A site that will not serve us is the world's business, not ours, and
                # filing it beside a real defect is how a report stops being read.
                # irctc.co.in refuses this machine outright -- curl gets nothing over
                # HTTP/2 or HTTP/1.1, on the root URL as well -- so there is no page here
                # for the extension to have failed on.
                result.unreachable = True
                result.verdict = f"the site did not serve a page: {detail}"
                # Measured: irctc.co.in serves this machine perfectly well in a headed
                # window and answers `net::ERR_HTTP2_PROTOCOL_ERROR` to the same Chrome
                # started with `--headless=new`. That is a fingerprint check at their edge,
                # not a defect here -- and it is worth saying out loud, because the
                # difference between the two runs is one flag.
                if not self.headed:
                    result.verdict += " (try --headed: some sites refuse headless Chrome)"
                self._shoot(tab, folder, "load-failed")
                return result

            # Real pages keep loading long after `domcontentloaded`. This is not a settle
            # detector -- the extension has its own -- it is only enough quiet to make the
            # first screenshot meaningful.
            tab.wait_for_timeout(2500)
            tab.bring_to_front()
            tab.wait_for_timeout(300)

            try:
                text = tab.evaluate("() => document.body ? document.body.innerText : ''")
            except Exception:
                text = ""
            # Only a real site can refuse us. A page we are serving ourselves cannot, and
            # a demo form with a field captioned "Captcha" was being skipped for saying so.
            local = urlparse(site.url).hostname in ("localhost", "127.0.0.1", "::1")
            wall = None if local else BOT_WALL.search(text or "")
            if wall:
                # Not a defect and not something to work around. A site asking for a
                # CAPTCHA has said no, and the honest result is to record that and leave.
                result.blocked = True
                # The matched phrase, so the judgement can be checked rather than taken on
                # trust. A regex that decides to skip a site is one that should have to
                # show its evidence -- "access denied" appears in plenty of ordinary page
                # furniture.
                result.blocked_by = wall.group(0)[:80]
                result.verdict = (
                    "the site served a bot check; skipped without answering it "
                    f"(matched {result.blocked_by!r})"
                )
                self._shoot(tab, folder, "blocked")
                return result

            self._shoot(tab, folder, "initial")

            tab_id = self.driver.worker.evaluate(
                """async () => {
                     const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
                     return t ? t.id : null;
                   }"""
            )
            if tab_id is None:
                result.verdict = "no active tab"
                result.problems.append(result.verdict)
                return result

            before = len(self.driver.traces)
            reply = self.driver._send(
                self.driver.driver_page, "RUN_TASK", {"goal": goal, "tabId": tab_id}
            )
            if not isinstance(reply, dict) or not reply.get("ok"):
                message = reply.get("error", {}).get("message", "") if isinstance(reply, dict) else ""
                result.verdict = f"RUN_TASK refused: {message}"
                result.problems.append(result.verdict)
                return result

            session = reply["result"]["sessionId"]
            state = self._wait(tab, folder, result)

            result.status = str(state.get("status", "?"))
            result.steps = int(state.get("stepIndex", 0))
            result.log = state.get("log", []) or []
            result.plan = [
                {"id": leg.get("id"), "kind": leg.get("kind"), "status": leg.get("status")}
                for leg in ((state.get("progress") or {}).get("plan") or [])
            ]
            traces = [
                t for t in self.driver.traces[before:] if t.get("sessionId") == session
            ]
            posts = self.driver.planner.recorder.take()
            result.posts = len(posts)

            for trace in traces:
                for event in trace.get("events", []):
                    result.phase_ms.setdefault(event["phase"], []).append(event["ms"])
                result.elements = max(result.elements, trace.get("elements") or 0)
                found = trace.get("findings") or {}
                for cls, n in (found.get("byClass") or {}).items():
                    result.findings_by_class[cls] = result.findings_by_class.get(cls, 0) + n
                for layer, n in (found.get("byLayer") or {}).items():
                    result.findings_by_layer[layer] = result.findings_by_layer.get(layer, 0) + n

            if posts:
                manifest = posts[-1].manifest
                result.redacted_fraction = manifest.get("redactedFraction")
                result.over_redacted_fraction = manifest.get("overRedactedFraction")
                (folder / "step.json").write_text(
                    json.dumps(posts[-1].step, indent=2, ensure_ascii=False), encoding="utf-8"
                )
                if posts[-1].image:
                    (folder / "sealed.webp").write_bytes(posts[-1].image)

            (folder / "traces.json").write_text(
                json.dumps(traces, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            self._shoot(tab, folder, "final")

            result.attached = self._attached(traces)
            result.console_errors = [e for e in errors if _ours(e)][:8]
            self._judge(result, traces)
        except Exception as err:  # noqa: BLE001 -- a broken page is a result, not a crash
            result.verdict = f"harness error: {type(err).__name__}: {err}"
            result.problems.append(result.verdict)
        finally:
            self.driver.stop()
            result.wall_ms = (time.time() - started) * 1000
            try:
                tab.close()
            except Exception:
                pass
            (folder / "result.json").write_text(
                json.dumps(_as_dict(result), indent=2, ensure_ascii=False), encoding="utf-8"
            )
        return result

    @staticmethod
    def _attached(traces: list) -> bool:
        """Did the extension's content script land on this page?

        Answered from the run rather than from a marker in the DOM. The first version of
        this looked for an overlay root, which the content script installs only when the
        debug overlay is switched on -- so it reported "the content script did not attach"
        about a page the walker had just found 106 elements on and sealed two frames from.
        A probe that can be wrong in that direction is worse than no probe: it turns a
        working run into a red line and sends someone looking at manifest permissions.

        `perceive` cannot complete unless the content script answered DOM_SNAPSHOT, so a
        perceive event with elements behind it *is* the attachment, measured rather than
        sniffed.
        """
        return any((t.get("elements") or 0) > 0 for t in traces)

    def _wait(self, tab, folder: Path, result: LiveResult) -> dict:
        budget = TASK_TIMEOUT_S if self.task else PAGE_TIMEOUT_S
        deadline = time.time() + budget
        seen = 0
        state: dict = {}
        while time.time() < deadline:
            state = self._state()
            log = state.get("log", []) or []
            done = [e for e in log if e.get("outcome") is not None]
            if len(done) > seen:
                for entry in done[seen:]:
                    self._shoot(tab, folder, f"step-{entry.get('stepIndex')}")
                seen = len(done)
            if state.get("status") in ("stopped", "failed", "incomplete", "idle"):
                return state
            self.driver.driver_page.wait_for_timeout(250)
        result.problems.append(f"the run did not end within {budget:.0f}s")
        return state or self._state()

    def _shoot(self, tab, folder: Path, name: str) -> None:
        try:
            tab.screenshot(path=str(folder / f"{name}.png"))
        except Exception:
            pass

    def _judge(self, result: LiveResult, traces: list) -> None:
        """What counts as working, on a page nobody has ground truth for."""
        if not result.attached:
            result.problems.append(
                "the content script never answered a DOM snapshot on this page"
            )
        # What counts as working depends on what was asked for.
        #
        # The read-only pass exists to prove the pipeline end to end, so a run that sealed
        # nothing proved nothing. A `--task` run is the opposite: the tier ladder answering
        # on the device and never reaching the server is the *best* outcome it has, and
        # calling it a failure would teach the report to lie in the flattering direction.
        # So a task run is judged on its plan instead.
        if not self.task:
            if result.posts == 0:
                result.problems.append("nothing reached the gate: no sealed frame was posted")
        else:
            if result.plan:
                unfinished = [leg for leg in result.plan if leg.get("status") != "done"]
                if unfinished:
                    result.problems.append(
                        "the plan did not finish: "
                        + ", ".join(f"{leg['id']} {leg.get('status')}" for leg in unfinished[:3])
                    )

            # The plan finishing is the loop's opinion of its own work. The completion
            # check is not: `complete.ts` re-reads the fields the user named and refuses to
            # let the session claim success over an empty one. When the two disagree it is
            # the completion check that is right, and a harness that reported `ok` here
            # would be quoting the flattering half of its own evidence -- which is exactly
            # what it did on the first irctc.co.in run, over a form where two of the three
            # things asked for had never happened.
            last = result.log[-1] if result.log else {}
            if last.get("outcome") == "incomplete":
                residue = str(last.get("note", ""))
                at = residue.find("not done:")
                result.problems.append(
                    residue[at:at + 160] if at != -1 else "the run ended incomplete"
                )
        # A failed step that the loop retried into success is the loop working.
        #
        # Judging every `trace.error` as a problem reported uidai.gov.in as a failure for
        # a step that failed once with `scrollY 428 -> 512` -- the page was still
        # smooth-scrolling from the previous step's own scroll, the geometry guard
        # correctly refused the frame, and the retry then succeeded and the run finished.
        # Counting that as a broken site is how a harness teaches people to ignore it.
        ended_cleanly = result.status in ("stopped", "incomplete")
        for trace in traces:
            if not trace.get("error"):
                continue
            step = trace.get("stepIndex")
            later_ok = any(
                t.get("stepIndex") == step and not t.get("error") for t in traces
            )
            if later_ok and ended_cleanly:
                result.recovered.append(f"step {step}: {trace['error']} (retried, succeeded)")
            else:
                result.problems.append(f"step {step}: {trace['error']}")
        if result.over_redacted_fraction is not None and result.over_redacted_fraction > 0.5:
            result.problems.append(
                f"over-redaction {result.over_redacted_fraction:.0%} of what was painted "
                "covered nothing detected"
            )
        result.ok = not result.problems
        if self.task:
            done = "every leg of the plan finished"
            if result.posts == 0:
                done += "; answered on the device, nothing sent"
        else:
            done = "attached, perceived, sealed and posted"
        result.verdict = result.verdict or (
            done if result.ok else "; ".join(result.problems[:3])
        )


#: Console noise that belongs to the site, not to us. A real page produces plenty.
def _ours(message: str) -> bool:
    return bool(re.search(r"chrome-extension://|sih|offscreen|redaction|gate", message, re.I))


def _as_dict(result: LiveResult) -> dict:
    out = dict(result.__dict__)
    out["phase_ms"] = {
        phase: {"n": len(v), "max": max(v), "total": sum(v)}
        for phase, v in result.phase_ms.items()
    }
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", nargs="*", help="glob(s) over site ids")
    parser.add_argument("--headed", action="store_true", help="watch it work")
    parser.add_argument("--chrome", help="path to a Chrome binary")
    parser.add_argument(
        "--allow-search",
        action="store_true",
        help="also type a query into a site's own search box (never a login field)",
    )
    parser.add_argument(
        "--task",
        help=(
            "run a real multi-step goal instead of the read-only pass. The planner may "
            "type and click, but never on a control matching NEVER_OPERATE."
        ),
    )
    parser.add_argument(
        "--url",
        help=(
            "run one URL that is not in SITES -- a demo page on localhost, a staging "
            "build, a page a judge asks about. Everything else applies unchanged."
        ),
    )
    parser.add_argument("--run-dir", type=Path, default=RUNS)
    args = parser.parse_args()

    sites = SITES
    if args.url:
        # An id that names the page rather than the run, so the report folder is legible.
        stem = args.url.rstrip("/").rsplit("/", 1)[-1] or "page"
        stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).removesuffix(".html")
        sites = [Site(id=stem or "url", url=args.url, why="named on the command line")]
    elif args.only:
        sites = [s for s in SITES if any(fnmatch.fnmatch(s.id, p) for p in args.only)]
        if not sites:
            raise SystemExit(f"no site matches {args.only}")

    dist = ROOT / "dist" / "chrome"
    if not (dist / "manifest.json").exists():
        raise SystemExit("dist/chrome is missing. Run `npm run build` first.")
    eval_build = build.make_eval_build(dist, REPORT_DIR / "build")

    if args.run_dir.exists():
        shutil.rmtree(args.run_dir)
    args.run_dir.mkdir(parents=True, exist_ok=True)

    if args.task:
        # A real goal drives the real planner. Everything it returns still goes through
        # `guarded`, so nothing on the deny list can be operated however the page reads.
        goal = args.task
        sys.path.insert(0, str(HERE / "runner"))
        from runner import scripted

        default_plan = guarded(scripted.ScenarioPlanner())
        mode = f"task: {goal!r}"
    else:
        # A reading task, so the step reaches the gate rather than being answered on the
        # device. See the note on GOAL in eval/harness.py.
        goal = "Describe what this page is asking for"
        default_plan = read_only_plan
        mode = "read-only"

    print(f"running {len(sites)} live site(s), {mode}\n")
    results: list[LiveResult] = []

    switch = PlanSwitch()
    switch.plan = default_plan
    with planner_mod.PlannerServer(plan=switch) as plan_server:
        launched = browser.launch_chrome(headless=not args.headed, executable=args.chrome)
        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as pw:
                connected = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{launched.port}")
                context = connected.contexts[0]
                extension_id = browser.load_unpacked(connected, eval_build)
                worker = browser.wake_worker(context, extension_id)
                base = runner_run.Driver(
                    context, extension_id, worker, plan_server, launched.port
                )
                driver = LiveDriver(
                    base, args.run_dir, task=bool(args.task), headed=bool(args.headed)
                )

                for i, site in enumerate(sites, 1):
                    # Swapped per site, so a site that allows a search gets one typed
                    # query and every other site cannot type at all.
                    switch.plan = (
                        default_plan
                        if args.task
                        else (
                            searching_plan(site.search)
                            if args.allow_search and site.search
                            else read_only_plan
                        )
                    )
                    result = driver.run(site, goal)
                    results.append(result)
                    mark = (
                "ok  "
                if result.ok
                else ("skip" if (result.blocked or result.unreachable) else "FAIL")
            )
                    print(
                        f"  [{i}/{len(sites)}] {mark} {site.id:<24} "
                        f"{result.wall_ms:7.0f}ms  els {result.elements:3d}  "
                        f"posts {result.posts}  {result.verdict}"
                    )
        finally:
            launched.stop()

    summary = {
        "mode": mode,
        "goal": goal,
        "sites": len(results),
        "ok": sum(1 for r in results if r.ok),
        "blocked": sum(1 for r in results if r.blocked),
        "unreachable": sum(1 for r in results if r.unreachable),
        # Only what the extension is answerable for.
        "failed": sum(
            1 for r in results if not r.ok and not r.blocked and not r.unreachable
        ),
        "results": [_as_dict(r) for r in results],
    }
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")

    print(
        f"\n  {summary['ok']} ok, {summary['failed']} failed, "
        f"{summary['blocked']} blocked by the site, "
        f"{summary['unreachable']} unreachable"
    )
    print(f"  {REPORT}")
    print(f"  {args.run_dir}")


if __name__ == "__main__":
    main()
