"""Did the face layer actually run, and what did it see?

    python scripts/face-probe.py

The unit tests pin the decode and the golden fixture pins it to the real graph. Neither
says whether the *plumbing* works -- whether a real frame reaches the model through the
session registry, whether the timing lands in the ring the M10 waterfall reads, and
whether the region gate keeps it off pages with nowhere for a photograph to be.

So this drives a real Chrome over two corpus pages, one with a scanned document on it and
one without, and reads HOST_STATS while the session is still alive. The host is released
when a session ends, so asking afterwards always answers "nothing loaded" -- which is what
made the eval harness's own hostStats useless for this question.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "eval"))

from playwright.sync_api import sync_playwright  # noqa: E402

from runner import browser as browser_mod, build as build_mod, planner, serve  # noqa: E402

#: One page with a scanned document, one without. The second is the control: the gate
#: should keep the model unloaded there, and "it ran on both" is as much a failure as
#: "it ran on neither".
PAGES = ["syn-scan-aadhaar", "syn-gov-enrolment"]


def main() -> None:
    dist = build_mod.make_eval_build(ROOT / "dist" / "chrome", ROOT / "dist" / "face-probe")
    launched = browser_mod.launch_chrome(port=9334)

    with serve.CorpusServer(ROOT / "eval" / "corpus") as corpus, planner.PlannerServer() as plan:
        try:
            with sync_playwright() as pw:
                chrome = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{launched.port}")
                context = chrome.contexts[0]
                extension_id = browser_mod.load_unpacked(chrome, dist)
                worker = browser_mod.wake_worker(context, extension_id)

                driver = context.new_page()
                driver.goto(f"chrome-extension://{extension_id}/popup.html", wait_until="load")

                def send(kind: str, payload: dict, to: str = "worker"):
                    envelope = {
                        "id": f"probe-{int(time.time() * 1000)}",
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

                for page_id in PAGES:
                    tab = context.new_page()
                    tab.set_viewport_size({"width": 1280, "height": 800})
                    tab.goto(corpus.url_for(f"pages/{page_id}.html"), wait_until="load")
                    tab.bring_to_front()
                    tab.wait_for_timeout(400)

                    tab_id = worker.evaluate(
                        """async () => {
                             const [t] = await chrome.tabs.query({active: true, currentWindow: true});
                             return t ? t.id : null;
                           }"""
                    )

                    send("STOP", {})
                    reply = send("RUN_TASK", {"goal": "review this page", "tabId": tab_id})
                    if not (isinstance(reply, dict) and reply.get("ok")):
                        print(f"{page_id}: RUN_TASK refused: {json.dumps(reply)[:160]}")
                        tab.close()
                        continue

                    # Poll while the step is in flight. The host is released the moment the
                    # session ends, so this is the only window in which the answer exists.
                    seen: dict = {}
                    for _ in range(120):
                        stats = send("HOST_STATS", {}, to="offscreen")
                        result = stats.get("result", {}) if isinstance(stats, dict) else {}
                        if result.get("loaded"):
                            seen = result
                            if "face" in result.get("timings", {}):
                                break
                        driver.wait_for_timeout(100)

                    print(
                        f"{page_id:22s} loaded={seen.get('loaded', [])} "
                        f"timings={seen.get('timings', {})} "
                        f"residentByTask={seen.get('residentByTask', {})}"
                    )
                    send("STOP", {})
                    tab.close()
        finally:
            launched.stop()


if __name__ == "__main__":
    main()
