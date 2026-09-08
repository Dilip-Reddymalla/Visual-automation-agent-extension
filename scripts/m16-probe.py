"""Did the agent stop doing the opposite of what it was told?

    python scripts/m16-probe.py

Two sentences, both transcripts of real runs, both of which ended with the agent reporting
success:

    "Dont fill last name with Leo"                            -> filled Last Name with Leo
    "Fill last name with leo and subject as Write Something"  -> filled one field, said done

The unit corpus (extension/src/worker/instructions.test.ts) proves `parseGoal` and
`chooseTier` agree about them. It cannot prove the *agent* does: the block has to survive
tokenisation, the state record, a service-worker wake and five message hops before it reaches
the code that decides whether to type. So this drives a real Chrome against the real page and
then asks the page -- not the extension -- what is in the fields.

That last part is the whole point. Every artefact the extension produces was saying `ok` while
Last Name held a value nobody asked for. The only trustworthy witness is the DOM, read
directly by the harness.

The eval build is used because `captureVisibleTab` needs `<all_urls>` and a harness cannot
perform the toolbar click that grants `activeTab`. See eval/runner/build.py: the only manifest
difference is that permission, and none of the assertions below depend on it.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "eval"))

from playwright.sync_api import sync_playwright  # noqa: E402

from runner import browser as browser_mod, build as build_mod, serve  # noqa: E402

PAGE = "https://www.w3schools.com/howto/howto_css_contact_form.asp"

#: The two failures, and what must be true afterwards.
#:
#: `must_stay_empty` is the assertion that matters. "The agent escalated" is easy to fake --
#: any bug that stops it working escalates too. "Last Name is empty" is the actual claim.
CASES = [
    {
        "goal": "Dont fill last name with Leo",
        "must_stay_empty": ["#lname", "#fname", "textarea"],
        "expect_block": "negation",
        "expect_note": "negation is not something a grammar may guess at",
        "expect_panel": ["nothing sent", "negation", "Dont"],
        "expect_counter": ["Nothing was sent this session", "none finished on this device"],
    },
    {
        "goal": "Fill last name with leo and subject as Write Something",
        # Either both fields or neither. The failure being fixed is exactly one of them.
        "must_stay_empty": ["#lname", "textarea"],
        # M16 asked for "both fields or escalate the whole goal, never one field and done".
        # The grammar now reads the whole thing -- "subject as Write Something" opens with a
        # field name, which is a labelled pair -- so it fills both, which is the better half
        # of that criterion. Asserted on the outcome rather than on a block that no longer
        # exists, because the block was only ever the means.
        "must_fill": {"#lname": "leo", "textarea": "Write Something"},
        "expect_note": "tier 0",
        "expect_panel": ["nothing sent"],
        "allow_reader": True,
        # Whatever the reader makes of it, nothing crossed the network.
        "expect_counter": ["Nothing was sent this session"],
    },
]

#: The scroll cases. Same sentence, same page, different scrollbar.
#:
#: This is the failure the screenshots showed: scrolled to the form it filled the field and
#: reported tier 0; scrolled two screens past it, the resolver had nothing above the floor,
#: escalated, and died at plan because no planner was running. The agent could not see a
#: field four hundred pixels above it.
#:
#: Both directions, because they fail for different reasons -- one is text the walk scrolled
#: past, the other is text it has not reached -- and a fix for one is not a fix for the other.
SCROLL_CASES = [
    {
        "goal": "fill first name with leo",
        "scroll": "below",
        "must_fill": {"#fname": "leo"},
        "expect_fulfilled": ["match"],
        "expect_note": "scrolled to reach",
        "expect_panel": ["tier 0", "nothing sent"],
        "expect_counter": ["Nothing was sent this session"],
    },
    {
        "goal": "fill first name with leo",
        "scroll": "top",
        # The contact form sits near the top of that page, so scrolling to 0 is not enough
        # to put it below the fold. A short window is: the nav and the ad above it are
        # taller than 420 pixels on their own.
        "viewport": {"width": 1280, "height": 420},
        "must_fill": {"#fname": "leo"},
        "expect_fulfilled": ["match"],
        "expect_note": "scrolled to reach",
        "expect_panel": ["tier 0", "nothing sent"],
        "expect_counter": ["Nothing was sent this session"],
    },
]

#: The unlabelled field.
#:
#: w3schools' Subject box carries no id, no name and no associated <label> -- the caption
#: above it is a bare <label> with no `for`. Every machine-readable signal a resolver has is
#: absent, so "enter the subject with random" scored below the floor against a page that
#: visibly has a box labelled Subject. A person reads that association off the layout.
UNLABELLED_CASES = [
    {
        "goal": "Enter the Subject with random",
        "must_fill": {"textarea": "random"},
        "expect_fulfilled": ["match"],
        "expect_panel": ["tier 0", "nothing sent"],
    },
]

#: The local reader. Sentences the grammar does not parse at all.
#:
#: Requires Ollama with the reader model pulled; skipped otherwise, because "the model is
#: not installed" is not a failure of the extension. What is asserted is the pair that
#: matters: a sentence the grammar cannot read gets answered on the device, and a sentence
#: with no value in it does not get one invented.
READER_CASES = [
    {
        # No longer needs a model: `as` read backwards is now settled by the alias table
        # ("first name" is inside "my first name down"), so this lands at tier 0. Kept in
        # the reader block because it is the sentence that found the swap.
        "goal": "put my first name down as Asha",
        "must_fill": {"#fname": "asha"},
        "expect_note": "tier 0",
        "expect_panel": ["tier 0", "nothing sent"],
    },
    {
        "goal": "fill in this form for me",
        "needs_ollama": True,
        # Nothing in that sentence is a value. Whatever the model proposes, nothing may be
        # typed: either it declines, or the guard refuses it and the step escalates.
        "must_stay_empty": ["#fname", "#lname", "textarea"],
    },
]

#: A form-filling script: values down the page, an action at the end. No verbs, no field
#: names -- the association is positional, and the grammar reads none of it. A real
#: transcript. "Then click submit" parses and "Leo A" does not, so the goal is `unparsed`,
#: which used to go straight to a planner and die there.
SCRIPT_CASES = [
    {
        "goal": "Leo A\nAustralia\nnone\nThen click submit",
        "needs_ollama": True,
        # Whatever the model makes of the name, nothing invented may reach the page and the
        # country must be chosen. The step is expected to report itself honestly either way.
        "expect_note": "tier 1",
        "expect_panel": ["tier 1", "nothing sent"],
    },
]

#: A government form that labels nothing.
#:
#: parivahan.gov.in's Mobile Number Update page: every field is captioned by adjacent text
#: with no `for`, no aria-label and no accessible name, and the only dropdown is captioned
#: "DL Holder's Last Transaction State". "Select state as telangana" parsed backwards, looked
#: for a field called Telangana, found nothing and died at a planner -- while typing into the
#: same form worked, on the same page, in the same session.
#: Driven against a local replica rather than the live site, which needs a session and
#: serves nothing to automation. `demo/page-c-unlabelled.html` carries that page's exact
#: markup shape: bare <label> captions with no `for`, no aria-label, no accessible name.
UNLABELLED_PAGE = "page-c-unlabelled.html"
SARATHI_CASES = [
    {
        "page": UNLABELLED_PAGE,
        "goal": "select state as telangana",
        "must_select": {"#ddlState": "tg"},
        "expect_note": "tier 0",
        "expect_panel": ["tier 0", "nothing sent"],
    },
    {
        # The half that always worked, kept as the control: if typing breaks, the dropdown
        # result says nothing.
        "page": UNLABELLED_PAGE,
        "goal": "enter DL Number as 10001000193",
        "must_fill": {"#dlNumber": "10001000193"},
        "expect_note": "tier 0",
    },
]

#: A control. If this does not fill the field, the probe is measuring a broken agent rather
#: than a working refusal, and every other result below is worthless.
CONTROL = {
    "goal": "fill first name with leo",
    "must_fill": {"#fname": "leo"},
    # Criterion 8: the check must re-read the field, not trust the keystroke. The trace
    # carries one verdict per verified action, and `match` can only have been produced by
    # reading the element back through the live handle map.
    "expect_fulfilled": ["match"],
    "expect_panel": ["Nothing was sent", "tier 0", "nothing sent", "read 100%"],
    "expect_counter": ["Nothing was sent this session", "answered on this device"],
}


def main() -> None:
    import urllib.error
    import urllib.request

    # Reachable *and* willing to answer a browser extension. Ollama's CORS allowlist does
    # not include one by default and returns 403, which is what made Tier 1 look like a
    # model that kept declining rather than a rung that had never run.
    try:
        req = urllib.request.Request(
            "http://localhost:11434/api/tags",
            headers={"Origin": "chrome-extension://probe"},
        )
        with urllib.request.urlopen(req, timeout=3) as r:
            ollama_up = "qwen2.5:1.5b" in r.read().decode()
    except urllib.error.HTTPError as err:
        print(f"  ollama refused a chrome-extension origin: HTTP {err.code}")
        print("  start it with OLLAMA_ORIGINS=chrome-extension://* to exercise tier 1")
        ollama_up = False
    except (urllib.error.URLError, TimeoutError):
        ollama_up = False
    print(f"  ollama reader model available to the extension: {ollama_up}")

    dist = build_mod.make_eval_build(ROOT / "dist" / "chrome", ROOT / "dist" / "m16-probe")
    launched = browser_mod.launch_chrome(port=9336)
    failures: list[str] = []
    demo = serve.CorpusServer(ROOT / "demo")
    demo.__enter__()

    try:
        with sync_playwright() as pw:
            chrome = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{launched.port}")
            context = chrome.contexts[0]
            extension_id = browser_mod.load_unpacked(chrome, dist)
            worker = browser_mod.wake_worker(context, extension_id)

            # The step trace is one JSON line on the service worker's console. It is the
            # only place `fulfilled` is reported, and it is how criterion 8 is checked.
            traces: list[dict] = []

            def collect(message) -> None:
                text = message.text
                if not text.startswith("{"):
                    return
                try:
                    parsed = json.loads(text)
                except ValueError:
                    return
                if isinstance(parsed, dict) and "traceVersion" in parsed:
                    traces.append(parsed)

            worker.on("console", collect)

            # The evidence panel, open for the whole run. It registers as 'panel' on the
            # bus, so PANEL_TRACE reaches it live -- which is the only way a step that
            # sealed nothing can appear there at all. Criterion 6 is read off this page.
            panel = context.new_page()
            panel.goto(f"chrome-extension://{extension_id}/sidebyside.html", wait_until="load")

            driver = context.new_page()
            driver.goto(f"chrome-extension://{extension_id}/popup.html", wait_until="load")

            def counter_text() -> str:
                driver.reload(wait_until="load")
                driver.wait_for_timeout(400)
                node = driver.locator("#counter")
                return node.inner_text() if node.count() else ""

            def send(kind: str, payload: dict, to: str = "worker"):
                envelope = {
                    "id": f"m16-{int(time.time() * 1000)}",
                    "from": "popup",
                    "to": to,
                    "sentAt": int(time.time() * 1000),
                    "type": kind,
                    "payload": payload,
                }
                return driver.evaluate(
                    """async (e) => await new Promise((r) =>
                         chrome.runtime.sendMessage(e, (reply) =>
                           r(chrome.runtime.lastError
                             ? { ok: false, error: { message: chrome.runtime.lastError.message } }
                             : reply)))""",
                    envelope,
                )

            def agent_state() -> dict:
                return worker.evaluate(
                    """async () => (await chrome.storage.session.get('agent-state'))['agent-state']"""
                ) or {}

            for case in [*SARATHI_CASES, CONTROL, *SCROLL_CASES, *UNLABELLED_CASES, *READER_CASES, *SCRIPT_CASES, *CASES]:
                goal = case["goal"]
                if case.get("needs_ollama") and not ollama_up:
                    print()
                    print(f"  skip     {goal} (ollama not reachable)")
                    continue
                traces.clear()
                tab = context.new_page()
                tab.set_viewport_size(case.get("viewport", {"width": 1280, "height": 900}))
                target = demo.url_for(case["page"]) if case.get("page") else PAGE
                tab.goto(target, wait_until="domcontentloaded")
                tab.bring_to_front()
                tab.wait_for_timeout(1200)

                # The form is on the tutorial page itself, not in the "Try it" iframe.
                if not case.get("page") and tab.locator("#fname").count() == 0:
                    failures.append(f"{PAGE} did not render the contact form; cannot judge")
                    tab.close()
                    break

                # Put the scrollbar where the case wants it. "below" leaves the form two
                # screens above the viewport; "top" leaves it far below.
                where = case.get("scroll")
                if where == "below":
                    tab.evaluate(
                        """() => {
                             document.querySelector('#fname').scrollIntoView();
                             window.scrollBy(0, 1600);
                           }"""
                    )
                elif where == "top":
                    tab.evaluate("() => window.scrollTo(0, 0)")
                if where:
                    tab.wait_for_timeout(700)
                    y = tab.evaluate("() => Math.round(window.scrollY)")
                    on = tab.evaluate(
                        """() => {
                             const r = document.querySelector('#fname').getBoundingClientRect();
                             return r.bottom > 0 && r.top < window.innerHeight;
                           }"""
                    )
                    print()
                    print(f"  scrolled to y={y}; First Name on screen: {on}")
                    if on:
                        failures.append(
                            f"{goal!r}: the probe meant to put First Name off screen and "
                            "did not, so this case proves nothing"
                        )

                tab_id = worker.evaluate(
                    """async () => {
                         const [t] = await chrome.tabs.query({active: true, currentWindow: true});
                         return t ? t.id : null;
                       }"""
                )

                send("STOP", {})
                reply = send("RUN_TASK", {"goal": goal, "tabId": tab_id})
                if not (isinstance(reply, dict) and reply.get("ok")):
                    failures.append(f"{goal!r}: RUN_TASK refused: {json.dumps(reply)[:200]}")
                    tab.close()
                    continue

                # Wait for the session to stop moving. A refusal ends fast; a Tier 0 fill
                # ends fast; a Tier 2 attempt ends when the planner call times out.
                state: dict = {}
                for _ in range(150):
                    state = agent_state()
                    if state.get("status") in {"stopped", "failed", "incomplete"}:
                        break
                    driver.wait_for_timeout(200)

                last = (state.get("log") or [{}])[-1]
                note = str(last.get("note") or "")
                print(f"\n  goal     {goal}")
                print(f"  status   {state.get('status')}   outcome {last.get('outcome')}")
                print(f"  note     {note[:220]}")
                print(f"  coverage {state.get('coverage')}  residue {state.get('residue')}")
                print(f"  block    {json.dumps(state.get('block'))}")

                # The page itself, read directly. This is the only witness that was not
                # already saying `ok` while the bug was live.
                probe_for = (
                    ["#dlNumber", "#dob", "#ddlState", "#captcha"]
                    if case.get("page")
                    else ["#fname", "#lname", "textarea", "#country"]
                )
                values = {
                    sel: tab.locator(sel).first.input_value()
                    for sel in probe_for
                    if tab.locator(sel).count() > 0
                }
                print(f"  fields   {json.dumps(values)}")

                for selector in ([] if case.get("allow_reader") else case.get("must_stay_empty", [])):
                    if values.get(selector):
                        failures.append(
                            f"{goal!r}: {selector} holds {values[selector]!r} and must be empty"
                        )
                for selector, expected in case.get("must_select", {}).items():
                    if values.get(selector) != expected:
                        failures.append(
                            f"{goal!r}: {selector} is {values.get(selector)!r}, "
                            f"expected {expected!r} — the dropdown was not set"
                        )
                for selector, expected in case.get("must_fill", {}).items():
                    # Both sides folded: a page that upper-cases as you type has done what
                    # it was asked, and so has one that keeps the capitals the user gave.
                    if values.get(selector, "").strip().lower() != expected.strip().lower():
                        failures.append(
                            f"{goal!r}: {selector} holds {values.get(selector)!r}, "
                            f"expected {expected!r} — the control did not work, so nothing "
                            "else measured here means anything"
                        )
                # Criterion 5 and 9: the block survives every hop from the parser to the
                # step log, and the log says why in words rather than in a reason code.
                block = (state.get("block") or {}).get("kind")
                if case.get("expect_block") and block != case["expect_block"]:
                    failures.append(
                        f"{goal!r}: block is {block!r}, expected {case['expect_block']!r}"
                    )
                if case.get("expect_note") and case["expect_note"] not in note:
                    failures.append(
                        f"{goal!r}: the note does not mention {case['expect_note']!r}; "
                        f"it says {note[:160]!r}"
                    )
                if case.get("expect_block") and "nothing sent" not in note:
                    failures.append(f"{goal!r}: the note does not say whether anything was sent")
                # Criterion 3: never "done" with work outstanding.
                if "not done" in note and last.get("outcome") != "incomplete":
                    failures.append(f"{goal!r}: named outstanding work but did not end incomplete")
                # Criterion 6, and the sentence that was false: a step nothing was sent on
                # must not credit the planner with the verdict.
                if "nothing sent" in note and "planner reported" in note:
                    failures.append(f"{goal!r}: credited the planner on a step that sent nothing")

                fulfilled = [f for t in traces for f in (t.get("fulfilled") or [])]
                print(f"  verified {json.dumps(fulfilled)}")
                if case.get("expect_fulfilled") and fulfilled != case["expect_fulfilled"]:
                    failures.append(
                        f"{goal!r}: the completion check reported {fulfilled!r}, "
                        f"expected {case['expect_fulfilled']!r} — the field was not re-read"
                    )

                # Criterion 6: the panel shows the tier and whether anything was sent, for a
                # step it has no frames for. That pair used to render as "Run a task, then
                # come back" -- an empty state standing in for the project's strongest claim.
                # Checked per case, because the panel shows the newest step and the cases
                # each start a fresh session at step 0.
                panel.bring_to_front()
                panel.wait_for_timeout(500)
                card = panel.locator("#local")
                shown = "" if card.is_hidden() else card.inner_text()
                print(f"  panel    {' / '.join(l for l in shown.splitlines() if l)[:240]}")
                for wanted in case.get("expect_panel", []):
                    if wanted.lower() not in shown.lower():
                        failures.append(
                            f"{goal!r}: the panel does not show {wanted!r}; it shows {shown[:200]!r}"
                        )
                if "[object" in shown:
                    failures.append(f"{goal!r}: the panel rendered an object: {shown[:160]!r}")

                # The session counter. A run that sent nothing used to show "Values
                # protected this session: 0" -- the same 0 you get when the inference host
                # is down, next to words that read as "the privacy tool did nothing".
                counter = counter_text()
                print(f"  counter  {counter.strip()[:120]}")
                for wanted in case.get("expect_counter", []):
                    if wanted.lower() not in counter.lower():
                        failures.append(
                            f"{goal!r}: the counter does not say {wanted!r}; it says {counter!r}"
                        )

                send("STOP", {})
                tab.close()

    finally:
        launched.stop()
        demo.__exit__(None, None, None)

    print()
    if failures:
        for line in failures:
            print(f"  FAIL  {line}")
        raise SystemExit(1)
    print("  every case behaved. Nothing was filled that was told not to be.")


if __name__ == "__main__":
    main()
