"""Drive the real demo end to end in a real Chrome, and say what broke.

The eval harness scores detection against a labelled corpus; this does something
different and smaller. It runs the demonstration exactly as a judge would see it --
`demo/page-a-enrolment.html` and `demo/page-b-application.html`, the real
`server/app.py`, the real extension -- and prints the phase every step reached.

It exists because "stuck at plan" is a symptom with at least four causes (no planner
listening, a schema mismatch, a refused fetch, a plan that never returns) and the only
way to tell them apart is to watch one run from the outside.

    python scripts/demo-smoke.py

Assumes the planner is on :8000 and the pages on :8080. Neither is started here: the
point is to test what the README tells someone to run.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "eval"))

from playwright.sync_api import sync_playwright  # noqa: E402

from runner import browser as browser_mod, build as build_mod  # noqa: E402

VIEWPORT = {"width": 1280, "height": 900}
STEP_TIMEOUT_S = 90.0


class Smoke:
    def __init__(self, context, extension_id, worker, port, show_elements=False,
                 watch_panel=False):
        self.show_elements = show_elements
        self.watch_panel = watch_panel
        self.context = context
        self.extension_id = extension_id
        self.worker = worker
        self.port = port
        self.traces: list[dict] = []
        self.console: list[str] = []
        worker.on("console", self._on_console)
        self.driver_page = context.new_page()
        self.driver_page.goto(
            f"chrome-extension://{extension_id}/popup.html", wait_until="load"
        )
        self.driver_page.on("console", lambda m: self.console.append(f"[popup] {m.text}"))

    def _on_console(self, message) -> None:
        text = message.text
        self.console.append(f"[{time.strftime('%H:%M:%S')}] [worker] {text}")
        if text.startswith('{"traceVersion"'):
            try:
                self.traces.append(json.loads(text))
            except json.JSONDecodeError:
                pass

    def send(self, message_type, payload, to="worker", tab_id=None):
        envelope = {
            "id": f"smoke-{int(time.time() * 1000)}",
            "from": "popup",
            "to": to,
            "sentAt": int(time.time() * 1000),
            "type": message_type,
            "payload": payload,
        }
        if tab_id is not None:
            envelope["tabId"] = tab_id
        return self.driver_page.evaluate(
            """async (envelope) => await new Promise((resolve) =>
                 chrome.runtime.sendMessage(envelope, (reply) =>
                   resolve(chrome.runtime.lastError
                     ? { ok: false, error: { message: chrome.runtime.lastError.message } }
                     : reply)))""",
            envelope,
        )

    def state(self) -> dict:
        return self.worker.evaluate(
            "async () => (await chrome.storage.session.get('agent-state'))['agent-state']"
        ) or {}

    def await_trace(self, session_id, before):
        deadline = time.time() + STEP_TIMEOUT_S
        while time.time() < deadline:
            for trace in self.traces[before:]:
                if trace.get("sessionId") == session_id:
                    return trace
            # A session that has stopped will not produce another trace, so waiting the
            # full timeout for one only makes the run longer than the finding.
            if self.state().get("status") in ("stopped", "failed"):
                return None
            self.driver_page.wait_for_timeout(50)
        return None

    def run_page(self, name, url, goal, steps=1):
        print(f"\n=== {name} ===")
        tab = self.context.new_page()
        tab.on("console", lambda m: self.console.append(
                f"[{time.strftime('%H:%M:%S')}] [page] {m.text}"))
        tab.on("pageerror", lambda e: self.console.append(f"[page:error] {e}"))
        try:
            tab.set_viewport_size(VIEWPORT)
            tab.goto(url, wait_until="load")
            tab.wait_for_timeout(400)
            tab.bring_to_front()
            tab.wait_for_timeout(200)

            tab_id = self.worker.evaluate(
                """async () => {
                     const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
                     return t ? t.id : null;
                   }"""
            )
            print(f"tab id: {tab_id}")

            # Opened before the run, the way an operator watching the demo would: the
            # panel's primary path is a push per sealed step, and the PANEL_LIST fallback
            # only covers a panel opened late.
            # One docked panel, all three views, exactly as an operator now sees it.
            # Opened *before* the run and left open: both evidence views are fed by a push
            # per step, and the inference host is released when the session ends, so
            # anything opened afterwards has nothing left to read.
            panel = None
            if self.watch_panel:
                panel = self.context.new_page()
                panel.set_viewport_size({"width": 420, "height": 900})
                panel.goto(
                    f"chrome-extension://{self.extension_id}/panel.html", wait_until="load"
                )
                # Reveal both evidence views so their frames exist and are listening
                # before the first step is sealed.
                for tab_id_name in ("tab-sent", "tab-resources", "tab-agent"):
                    panel.click(f"#{tab_id_name}")
                    panel.wait_for_timeout(400)
                tab.bring_to_front()
                tab.wait_for_timeout(200)

            # One session at a time is enforced by the worker now, so an earlier check
            # that left a session running would refuse this one. Stop and wait for it.
            self.send("STOP", {})
            for _ in range(40):
                if self.state().get("status") not in ("running", "stopping"):
                    break
                self.driver_page.wait_for_timeout(100)

            before = len(self.traces)
            reply = self.send("RUN_TASK", {"goal": goal, "tabId": tab_id})
            if not isinstance(reply, dict) or not reply.get("ok"):
                print(f"RUN_TASK REFUSED: {json.dumps(reply)}")
                return
            session_id = reply["result"]["sessionId"]
            print(f"session: {session_id}")

            for n in range(steps):
                trace = self.await_trace(session_id, before)
                if trace is None:
                    st = self.state()
                    if st.get("status") in ("stopped", "failed"):
                        # The session ended on its own -- a plan that finished, a
                        # failure, or the step budget. Not a stall, and reporting it as
                        # one is how a working run gets read as a broken one.
                        print(f"  session ended after {n} more step(s): "
                              f"{st.get('status')}")
                        break
                    print(f"  step {n}: STALLED -- no trace after {STEP_TIMEOUT_S}s")
                    print("  state: " + json.dumps(
                        {k: v for k, v in st.items() if k != "log"}))
                    print(f"  tab url now: {tab.url}")
                    # Is the loop refusing, or was the event simply lost on the way?
                    # A PERCEIVE by hand answers that in one round trip: accepted means
                    # the loop was willing all along and nothing asked it.
                    poke = self.send("PERCEIVE", {"reason": "smoke-poke"})
                    print(f"  manual PERCEIVE -> {json.dumps(poke)[:200]}")
                    revived = self.await_trace(session_id, before)
                    print(f"  after poke: {'a step ran' if revived else 'still nothing'}")
                    for entry in st.get("log", []):
                        print(f"    log: {json.dumps(entry)}")
                    break
                before = len(self.traces)
                phases = [f"{e['phase']}:{e['ms']:.0f}ms" for e in trace.get("events", [])]
                print(f"  step {trace.get('stepIndex')}: outcome={trace.get('outcome')} "
                      f"total={trace.get('totalMs', 0):.0f}ms")
                print(f"    phases: {' -> '.join(phases)}")
                for key in ("tier", "overlay", "error", "semanticError", "plan", "payload",
                            "findings", "execution", "containers"):
                    if trace.get(key):
                        print(f"    {key}: {json.dumps(trace[key])[:400]}")
                if trace.get("outcome") != "ok":
                    break

            self.send("STOP", {})
            if self.show_elements:
                self.dump_elements(tab_id)
            self.save_sent_frame(tab)
            self.dump_manifests()
            self.report_page_outcome(tab)
            if panel is not None:
                self.report_panel(panel)

            st = self.state()
            print(f"  final state: status={st.get('status')} phase={st.get('phase')} "
                  f"step={st.get('stepIndex')}")
            for entry in st.get("log", []):
                print(f"    log: {json.dumps(entry)}")
        finally:
            self.send("STOP", {})
            try:
                tab.close()
            except Exception:
                pass

    def report_panel(self, panel):
        """What the docked panel is showing, read from inside its own frames.

        Both evidence views at once, because that is now one surface rather than two
        browser tabs -- and reading them through the shell is the only way to prove the
        frames are still live rather than merely present.
        """
        try:
            panel.bring_to_front()
            panel.wait_for_timeout(800)

            sent = next((f for f in panel.frames if f.url.endswith("sidebyside.html")), None)
            if sent is None:
                print("  panel: the 'what was sent' frame is not loaded")
            else:
                view = sent.evaluate(
                    """() => ({
                         steps: document.getElementById('step')?.options.length ?? 0,
                         rows: document.getElementById('rows')?.children.length ?? 0,
                         // Severity order and provenance, read straight off the table.
                         classOrder: [...document.querySelectorAll('#rows tr')]
                           .map((r) => r.cells[0]?.textContent),
                         origins: [...document.querySelectorAll('#rows tr')]
                           .map((r) => r.cells[1]?.textContent),
                         summary: document.getElementById('summary')?.textContent?.trim() ?? '',
                         counter: document.getElementById('counter')?.textContent?.trim() ?? '',
                         beforeSrc: (document.getElementById('before')?.src ?? '').slice(0, 24),
                         afterSrc: (document.getElementById('after')?.src ?? '').slice(0, 24),
                         emptyShown: !!document.getElementById('empty')
                                     && !document.getElementById('empty').hidden,
                       })"""
                )
                print(f"  panel/sent: {json.dumps(view)}")

            hud = next((f for f in panel.frames if f.url.endswith("hud.html")), None)
            if hud is None:
                print("  panel: the resources frame is not loaded")
            else:
                view = hud.evaluate(
                    """() => ({
                         host: document.getElementById('host')?.innerText?.trim() ?? '',
                         memory: document.getElementById('memory')?.innerText?.trim() ?? '',
                         waterfall: document.getElementById('waterfall')?.innerText?.trim() ?? '',
                       })"""
                )
                for key, value in view.items():
                    first = " | ".join(value.splitlines()[:4])
                    print(f"  panel/{key}: {first}")
        except Exception as err:
            print(f"  panel unavailable: {err}")
        finally:
            try:
                panel.close()
            except Exception:
                pass

    def report_page_outcome(self, tab):
        """What the page itself thinks happened -- the only unarguable verdict."""
        try:
            outcome = tab.evaluate(
                """() => ({
                     url: location.pathname,
                     submitted: document.getElementById('done-note')
                                ? !document.getElementById('done-note').hidden : null,
                     error: document.getElementById('submit-error')?.textContent?.trim()
                            || document.getElementById('b-error')?.textContent?.trim()
                            || null,
                     email: document.querySelector('input[type=email]')?.value || '',
                     scheme: document.getElementById('scheme-value')?.textContent || null,
                   })"""
            )
        except Exception as err:
            print(f"  page outcome unavailable: {err}")
            return
        print(f"  page says: {json.dumps(outcome)}")

    def save_sent_frame(self, tab):
        """Write the exact bytes that were POSTed, so the marks can be looked at.

        Read from the offscreen ring rather than reconstructed: the point is to inspect
        the image the planner received, not one that resembles it.
        """
        try:
            listed = self.send("PANEL_LIST", {}, to="offscreen")
            steps = listed.get("result", {}).get("steps", [])
            if not steps:
                return
            newest = steps[0]["stepIndex"]
            reply = self.send("PANEL_STEP", {"stepIndex": newest}, to="offscreen")
            url = reply.get("result", {}).get("sentUrl")
            if not url:
                return
            data = self.driver_page.evaluate(
                """async (u) => {
                     const blob = await fetch(u).then((r) => r.blob());
                     const buf = await blob.arrayBuffer();
                     return [...new Uint8Array(buf)];
                   }""",
                url,
            )
            out = Path("D:/SIH/eval/report/sent-frame.webp")
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(bytes(data))
            print(f"  sent frame: {len(data)} bytes -> {out}")
        except Exception as err:
            print(f"  sent frame unavailable: {err}")

    def dump_elements(self, tab_id):
        """The element list exactly as the planner receives it.

        Sent from the worker with `chrome.tabs.sendMessage`, not from the popup with
        `chrome.runtime.sendMessage`: runtime messages fan out to extension contexts and
        never reach a content script, so the popup route answers "the message port closed"
        for a target that was never addressed.
        """
        reply = self.worker.evaluate(
            """async (tabId) => await chrome.tabs.sendMessage(tabId, {
                 id: 'smoke-elements', from: 'worker', to: 'content',
                 sentAt: Date.now(), type: 'DOM_SNAPSHOT',
                 payload: { sessionId: 'smoke' },
               })""",
            tab_id,
        )
        if not isinstance(reply, dict) or not reply.get("ok"):
            print(f"  DOM_SNAPSHOT failed: {json.dumps(reply)[:200]}")
            return
        elements = reply.get("result", {}).get("elements", [])
        print(f"  {len(elements)} elements perceived")
        for el in elements:
            if el.get("index") is None:
                continue
            state = el.get("state", {})
            flags = ",".join(k for k in ("filled", "required", "invalid") if state.get(k))
            print(f"    [{el['index']:>2}] {el.get('role', '?'):10s} "
                  f"{str(el.get('name', ''))[:44]!r} {flags}")

    def dump_manifests(self):
        """What the gate actually wrote, read back from the panel ring."""
        try:
            listed = self.send("PANEL_LIST", {}, to="offscreen")
            steps = listed.get("result", {}).get("steps", [])
        except Exception as err:
            print(f"  PANEL_LIST failed: {err}")
            return
        for summary in steps:
            reply = self.send(
                "PANEL_STEP", {"stepIndex": summary["stepIndex"]}, to="offscreen"
            )
            manifest = reply.get("result", {}).get("manifest") or {}
            print(f"  manifest step {summary['stepIndex']}: "
                  f"{len(manifest.get('findings', []))} findings")
            for f in manifest.get("findings", []):
                print(f"    {f.get('cls'):9s} mode={f.get('mode'):8s} "
                      f"origin={f.get('origin'):6s} "
                      f"placeholder={f.get('placeholder')!r} "
                      f"layer={f.get('layer')} reason={f.get('reason')}")

    def check_pages(self):
        print("\n=== extension pages ===")
        for page_name in (
            "popup.html",
            "agent.html",
            "sidebyside.html",
            "hud.html",
            "confirm.html",
        ):
            errors: list[str] = []
            p = self.context.new_page()
            p.on("pageerror", lambda e, errs=errors: errs.append(f"pageerror: {e}"))
            p.on(
                "console",
                lambda m, errs=errors: errs.append(f"console.error: {m.text}")
                if m.type == "error"
                else None,
            )
            try:
                p.goto(f"chrome-extension://{self.extension_id}/{page_name}",
                       wait_until="load")
                p.wait_for_timeout(1500)
                title = p.title()
                flag = "  ERRORS: " + json.dumps(errors)[:600] if errors else ""
                print(f"{page_name:20s} loaded  title={title!r}{flag}")
            except Exception as err:
                print(f"{page_name:20s} FAILED: {err}")
            finally:
                p.close()

    def check_overlay(self, url):
        """The popup -> content -> popup round trip, on a real page."""
        print("\n=== overlay ===")
        tab = self.context.new_page()
        try:
            tab.set_viewport_size(VIEWPORT)
            tab.goto(url, wait_until="load")
            tab.wait_for_timeout(400)
            tab.bring_to_front()
            tab.wait_for_timeout(200)
            tab_id = self.worker.evaluate(
                """async () => {
                     const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
                     return t ? t.id : null;
                   }"""
            )
            for show in (True, False):
                reply = self.worker.evaluate(
                    """async ([tabId, show]) => await chrome.tabs.sendMessage(tabId, {
                         id: 'smoke-overlay', from: 'worker', to: 'content',
                         sentAt: Date.now(), type: 'OVERLAY_TOGGLE', payload: { show },
                       })""",
                    [tab_id, show],
                )
                # The overlay host carries a closed shadow root, so its boxes are not
                # reachable from the page. Its presence is the observable fact.
                present = tab.evaluate(
                    "() => !!document.getElementById('sih-redaction-gate-overlay')"
                )
                print(f"  show={show} -> {json.dumps(reply)[:90]}  host present={present}")
        finally:
            tab.close()

    def check_vault(self):
        """Store, list, forget. The release path needs a human and is not driven here."""
        print("\n=== vault ===")
        origin = "http://localhost:8080"
        secret = "hunter2"

        saved = self.send(
            "VAULT_SAVE",
            {"origin": origin, "cls": "SECRET", "label": "Portal PIN", "value": secret},
        )
        print(f"  save:   {json.dumps(saved)[:120]}")

        listed = json.dumps(self.send("VAULT_LIST", {}))
        print(f"  list:   {listed[:220]}")
        print(f"  {'LEAK: the listing carried the secret' if secret in listed else 'no secret in the listing'}")

        forgotten = self.send("VAULT_FORGET", {"origin": origin, "cls": "SECRET"})
        print(f"  forget: {json.dumps(forgotten)[:120]}")
        print(f"  list:   {json.dumps(self.send('VAULT_LIST', {}))[:160]}")

    def check_panel_shell(self):
        """The docked side panel: three views, one document, no tab switching."""
        print("\n=== side panel shell ===")
        page = self.context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on(
            "console",
            lambda m: errors.append(f"console.error: {m.text}") if m.type == "error" else None,
        )
        try:
            page.set_viewport_size({"width": 420, "height": 900})
            page.goto(
                f"chrome-extension://{self.extension_id}/panel.html", wait_until="load"
            )
            page.wait_for_timeout(900)

            for tab, frame_id, marker in (
                ("tab-agent", "view-agent", "#goal"),
                ("tab-sent", "view-sent", "#step"),
                ("tab-resources", "view-resources", "#waterfall"),
            ):
                page.click(f"#{tab}")
                page.wait_for_timeout(1200)
                state = page.evaluate(
                    """([tab, frameId]) => {
                         const f = document.getElementById(frameId);
                         return {
                           selected: document.getElementById(tab)
                             ?.getAttribute('aria-selected'),
                           hidden: f?.hidden,
                           src: (f?.getAttribute('src') || '').split('/').pop(),
                         };
                       }""",
                    [tab, frame_id],
                )
                frame = next(
                    (fr for fr in page.frames if fr.url.endswith(state["src"] or "!")), None
                )
                found = bool(frame and frame.query_selector(marker))
                print(f"  {tab:14s} selected={state['selected']} hidden={state['hidden']} "
                      f"src={state['src']!r} {marker} present={found}")

            agent = next((f for f in page.frames if f.url.endswith("agent.html")), None)
            if agent:
                access = agent.evaluate(
                    """() => ({
                         text: document.getElementById('access')?.textContent ?? '',
                         state: document.getElementById('access')?.dataset.access ?? '',
                         button: document.getElementById('grant')?.textContent ?? '',
                         planner: document.getElementById('planner')?.textContent ?? '',
                         // The Agent tab must not offer navigation to sibling tabs.
                         evidenceButtons: document.querySelectorAll(
                           '#open-panel, #open-hud',
                         ).length,
                         counter: document.getElementById('counter')?.textContent
                           ?.replace(/\s+/g, ' ').trim() ?? '',
                       })"""
                )
                print(f"  agent tab:     {json.dumps(access)}")

            # The framed popup must switch tabs rather than opening a browser tab.
            page.click("#tab-agent")
            page.wait_for_timeout(400)
            before = len(self.context.pages)
            agent = next((f for f in page.frames if f.url.endswith("agent.html")), None)
            if agent:
                agent.click("#open-panel")
                page.wait_for_timeout(600)
                selected = page.evaluate(
                    "() => document.getElementById('tab-sent').getAttribute('aria-selected')"
                )
                print(f"  evidence button -> tab-sent selected={selected}, "
                      f"new browser tabs opened={len(self.context.pages) - before}")

            if errors:
                print(f"  ERRORS: {json.dumps(errors)[:500]}")
        except Exception as err:
            print(f"  panel shell FAILED: {err}")
        finally:
            page.close()

    def check_side_panel_api(self):
        """Is the panel actually wired to the toolbar action?"""
        print("\n=== side panel api ===")
        try:
            info = self.worker.evaluate(
                """async () => {
                     const manifest = chrome.runtime.getManifest();
                     let behaviour = null;
                     try {
                       behaviour = await chrome.sidePanel.getPanelBehavior();
                     } catch (err) { behaviour = String(err); }
                     return {
                       sidePanelApi: typeof chrome.sidePanel,
                       sidePanelPath: manifest.side_panel?.default_path ?? null,
                       defaultPopup: manifest.action?.default_popup ?? null,
                       optionalHosts: manifest.optional_host_permissions ?? null,
                       // The listener is what grants activeTab. Chrome opening the panel
                       // itself does not, which is the regression this asserts against.
                       hasActionListener: chrome.action.onClicked.hasListeners(),
                       behaviour,
                     };
                   }"""
            )
            print(f"  {json.dumps(info)}")
        except Exception as err:
            print(f"  FAILED: {err}")

    def check_tab_binding(self, base):
        """A session belongs to one tab; the panel docks beside all of them.

        The thing being checked is what the operator sees after switching away from the
        tab the agent is driving -- which used to be `running - step N` and nothing else,
        indistinguishable from a task running on the page in front of them.
        """
        print("\n=== session is bound to one tab ===")
        agent_tab = self.context.new_page()
        other_tab = None
        panel = None
        try:
            agent_tab.goto(f"{base}/page-b-application.html", wait_until="load")
            agent_tab.bring_to_front()
            agent_tab.wait_for_timeout(400)
            tab_id = self.worker.evaluate(
                """async () => {
                     const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
                     return t ? t.id : null;
                   }"""
            )

            panel = self.context.new_page()
            panel.goto(
                f"chrome-extension://{self.extension_id}/panel.html", wait_until="load"
            )
            panel.wait_for_timeout(600)

            reply = self.send("RUN_TASK", {"goal": "Fill in the form", "tabId": tab_id})
            if not isinstance(reply, dict) or not reply.get("ok"):
                print(f"  RUN_TASK refused: {json.dumps(reply)[:200]}")
                return
            print(f"  running on tab {tab_id}, origin recorded="
                  f"{self.state().get('tabOrigin')!r}")

            def note():
                frame = next(
                    (f for f in panel.frames if f.url.endswith("agent.html")), None
                )
                if frame is None:
                    return {"error": "agent frame not loaded"}
                return frame.evaluate(
                    """() => ({
                         shown: !document.getElementById('tab-note')?.hidden,
                         text: document.getElementById('tab-note-text')?.textContent ?? '',
                         runDisabled: document.getElementById('run')?.disabled,
                       })"""
                )

            agent_tab.bring_to_front()
            panel.wait_for_timeout(700)
            print(f"  on the agent's own tab:  {json.dumps(note())}")

            # Now look somewhere else, exactly as an operator would.
            other_tab = self.context.new_page()
            other_tab.goto(f"{base}/page-a-enrolment.html", wait_until="load")
            other_tab.bring_to_front()
            panel.wait_for_timeout(900)
            print(f"  after switching tabs:    {json.dumps(note())}")

            # And the worker refuses to start a second session over there.
            other_id = self.worker.evaluate(
                """async () => {
                     const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
                     return t ? t.id : null;
                   }"""
            )
            second = self.send("RUN_TASK", {"goal": "something else", "tabId": other_id})
            ok = isinstance(second, dict) and second.get("ok")
            message = "" if ok else json.dumps(second.get("error", {}))[:120]
            print(f"  second run elsewhere:    accepted={bool(ok)} {message}")
        except Exception as err:
            print(f"  FAILED: {err}")
        finally:
            self.send("STOP", {})
            for page in (panel, other_tab, agent_tab):
                try:
                    if page:
                        page.close()
                except Exception:
                    pass

    def check_self_test(self):
        print("\n=== self test ===")
        try:
            self.send("HOST_ENSURE", {})
            reply = self.send("SELF_TEST", {}, to="offscreen")
            print(json.dumps(reply, indent=2)[:900])
        except Exception as err:
            print(f"SELF_TEST failed: {err}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--goal", default="Finish this application using my enrolment document")
    ap.add_argument("--steps", type=int, default=3)
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--console", action="store_true", help="dump all console output")
    ap.add_argument("--panel", action="store_true",
                    help="open the side-by-side panel during the run and report it")
    ap.add_argument("--elements-only", action="store_true",
                    help="print both pages' element lists and exit")
    ap.add_argument("--elements", action="store_true",
                    help="print the element list the planner receives")
    ap.add_argument(
        "--shipped-manifest",
        action="store_true",
        help="drive dist/chrome as shipped. Capture will fail: activeTab is only granted "
        "by a real toolbar click, which no automation can perform.",
    )
    args = ap.parse_args()

    dist = ROOT / "dist" / "chrome"
    if not args.shipped_manifest:
        # Same single-field widening the eval harness uses, and for the same reason --
        # see eval/runner/build.py. Without it every step dies in `capture` and nothing
        # downstream of it is exercised at all.
        dist = build_mod.make_eval_build(dist, ROOT / "dist" / "smoke-chrome")
        print("driving the eval build (host_permissions widened to <all_urls>)")
    launched = browser_mod.launch_chrome(port=9333, headless=args.headless)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{launched.port}")
            context = browser.contexts[0]
            extension_id = browser_mod.load_unpacked(browser, dist)
            print(f"extension: {extension_id}")
            worker = browser_mod.wake_worker(context, extension_id)

            smoke = Smoke(context, extension_id, worker, launched.port,
                          show_elements=args.elements, watch_panel=args.panel)
            smoke.check_self_test()
            smoke.check_side_panel_api()
            smoke.check_panel_shell()
            smoke.check_tab_binding(args.base)
            smoke.check_pages()
            smoke.check_vault()
            smoke.check_overlay(f"{args.base}/page-a-enrolment.html")
            if args.elements_only:
                for label, page in (("page A", "page-a-enrolment.html"),
                                    ("page B", "page-b-application.html")):
                    tab = context.new_page()
                    tab.set_viewport_size(VIEWPORT)
                    tab.goto(f"{args.base}/{page}", wait_until="load")
                    tab.wait_for_timeout(500)
                    tab.bring_to_front()
                    tab.wait_for_timeout(300)
                    tab_id = worker.evaluate(
                        """async () => {
                             const [t] = await chrome.tabs.query(
                               { active: true, currentWindow: true });
                             return t ? t.id : null;
                           }"""
                    )
                    print(f"\n=== {label} elements ===")
                    smoke.dump_elements(tab_id)
                    tab.close()
                return

            smoke.run_page("page A (enrolment, image-only PII)",
                           f"{args.base}/page-a-enrolment.html", args.goal, args.steps)
            smoke.run_page("page B (application form)",
                           f"{args.base}/page-b-application.html", args.goal, args.steps)

            if args.console:
                print("\n=== console ===")
                for line in smoke.console:
                    print(line[:400])
    finally:
        launched.stop()


if __name__ == "__main__":
    main()
