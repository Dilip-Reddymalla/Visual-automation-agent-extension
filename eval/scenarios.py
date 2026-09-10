"""End-to-end agent scenarios, in a real Chrome, with the built extension loaded.

    python eval/scenarios.py                 # every scenario
    python eval/scenarios.py --only shop-*   # a subset
    python eval/scenarios.py --headed        # watch it work

## What this is, next to eval/harness.py

`harness.py` measures *perception*: one cycle per corpus page, scored against hand-made
labels, producing the five numbers the rubric rewards. It deliberately never lets a run
take a second step.

This measures the *agent*: a goal, a session that runs to its own conclusion, and a
verdict that has to be earned from three independent kinds of evidence -- what the agent
believes (its persisted progress ledger), what the page says afterwards (assertions
evaluated in the tab), and what it looked like at each checkpoint (screenshots). A
scenario passes only when all three agree. A screenshot on its own proves nothing, which
is why none of the pass conditions is a picture.

Everything is local and deterministic: the fixtures under `eval/scenarios/pages` are
static files with no network calls, no timers and no randomness, served over loopback
because `file://` gets no content script (see runner/serve.py). The planner is
`runner/scripted.py` -- a grammar, not a model -- so a failure is the extension's or the
fixture's, never the weather's.

Nothing here automates a purchase, a payment, an account, or a password. The shop fixture
stops at a mock cart page.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from runner import browser, build, planner as planner_mod, scenario as scenario_mod  # noqa: E402
from runner import serve, scripted  # noqa: E402

PAGES = HERE / "scenarios" / "pages"
REPORT_DIR = HERE / "report"
RUNS = REPORT_DIR / "scenarios"
REPORT = REPORT_DIR / "scenarios.json"

S = scenario_mod.Scenario

#: The values the privacy fixture prints. Nothing in any artefact may contain one.
#:
#: Not a sample of what the gate removed -- the whole set, including the two the DOM will
#: not hand over. A suite that checked only the Aadhaar number would pass a build that
#: logged the password.
FORBIDDEN = (
    "Asha Menon",
    "2345 6789 0122",
    "234567890122",
    "ABCDE1234F",
    "asha.menon@example.in",
    "98765 43210",
    "hunter2-not-real",
    "4111 1111 1111 1111",
    "14 Rose Lane",
)

SCENARIOS: list[scenario_mod.Scenario] = [
    # ── Group 1: navigation and search ────────────────────────────────────────
    S(
        id="search-filters-in-place",
        group="navigation and search",
        page="shop.html",
        goal="search for phones",
        # The page filters as you type, so a successful search is one where the summary
        # line changed and the kettles are gone.
        page_checks=[
            ("search box holds the term", "document.getElementById('q').value.trim() === 'phones'"),
            (
                "the results narrowed to phones",
                "document.getElementById('summary').textContent.includes('Results for phones')",
            ),
            ("the kettles are hidden", "document.getElementById('p5').closest('li').hidden === true"),
        ],
        accept_status=("stopped", "incomplete"),
    ),
    # ── Group 2: multi-step interaction ───────────────────────────────────────
    S(
        id="shop-cheapest-under-budget",
        group="multi-step interaction",
        page="shop.html",
        goal="search for phones, find the cheapest one under 30000, add it to the cart",
        # Aster at 18,499 is the cheapest phone under the limit. Reaching the cart page
        # at all is the whole task; reaching it with the right item is the point of the
        # candidate stage.
        page_checks=[
            ("the run reached the cart", "location.pathname.endsWith('cart.html')"),
            (
                "the cart holds the cheapest eligible phone",
                "document.getElementById('line-title').textContent.includes('Aster 5')",
            ),
        ],
        accept_status=("stopped", "incomplete"),
        require_legs_done=("search-1",),
    ),
    S(
        id="form-fill-and-submit",
        group="multi-step interaction",
        page="form.html",
        goal="fill first name with Leo, fill last name with Menon, then submit the form",
        page_checks=[
            ("first name was filled", "document.getElementById('first').value === 'Leo'"),
            ("last name was filled", "document.getElementById('last').value === 'Menon'"),
            ("the form was submitted", "document.getElementById('done').hidden === false"),
        ],
        accept_status=("stopped", "incomplete"),
    ),
    # ── Group 3: failure recovery ─────────────────────────────────────────────
    S(
        id="stubborn-page-gives-up",
        group="failure recovery",
        page="stubborn.html",
        goal="click continue, then submit the form",
        # Nothing on this page does anything. The correct outcome is a run that notices
        # and stops -- not one that reports success, and not one that runs to MAX_STEPS.
        page_checks=[],
        accept_status=("stopped", "incomplete", "failed"),
        forbid_legs_done=(),
    ),
    S(
        id="shifting-page-re-resolves",
        group="failure recovery",
        page="shifting.html",
        goal="click show details, then fill reference number with AB1234, then save details",
        # The control the first step used is removed by its own click. A run that carries
        # a stale element reference forward cannot finish this.
        page_checks=[
            ("the details section opened", "document.getElementById('stage-two').hidden === false"),
            ("the reference was filled", "document.getElementById('ref').value === 'AB1234'"),
        ],
        accept_status=("stopped", "incomplete"),
    ),
    # ── Group 4: privacy ──────────────────────────────────────────────────────
    S(
        id="privacy-nothing-leaks",
        group="privacy",
        page="privacy.html",
        goal="review this page and tell me what is on it",
        page_checks=[
            (
                "the password field was not emptied or rewritten",
                "document.getElementById('pwd').value === 'hunter2-not-real'",
            ),
        ],
        accept_status=("stopped", "incomplete", "failed"),
        forbid_in_artefacts=FORBIDDEN,
    ),
]


def select(scenarios, patterns):
    if not patterns:
        return scenarios
    chosen = [s for s in scenarios if any(fnmatch.fnmatch(s.id, p) for p in patterns)]
    if not chosen:
        raise SystemExit(f"no scenario matches {patterns}")
    return chosen


def run_all(scenarios, run_dir: Path, *, headless: bool, chrome: str | None) -> list:
    dist = ROOT / "dist" / "chrome"
    if not (dist / "manifest.json").exists():
        raise SystemExit("dist/chrome is missing. Run `npm run build` first.")

    eval_build = build.make_eval_build(dist, REPORT_DIR / "build")

    if run_dir.exists():
        shutil.rmtree(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)

    scripted_planner = scripted.ScenarioPlanner()
    results = []

    with serve.CorpusServer(PAGES) as pages_server, planner_mod.PlannerServer(
        plan=scripted_planner
    ) as plan_server:
        launched = browser.launch_chrome(headless=headless, executable=chrome)
        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as pw:
                connected = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{launched.port}")
                context = connected.contexts[0]

                extension_id = browser.load_unpacked(connected, eval_build)
                worker = browser.wake_worker(context, extension_id)

                from runner import run as runner_run

                base = runner_run.Driver(
                    context, extension_id, worker, plan_server, launched.port
                )
                driver = scenario_mod.ScenarioDriver(base, run_dir)

                for i, scenario in enumerate(scenarios, 1):
                    url = pages_server.url_for(scenario.page)
                    started = time.time()
                    result = driver.run(scenario, url)
                    # The driver already drained the recorder into the scenario's own
                    # artefacts, so the next scenario starts clean.
                    results.append(result)

                    mark = "ok  " if result.ok else "FAIL"
                    print(
                        f"  [{i}/{len(scenarios)}] {mark} {scenario.id:<32} "
                        f"{(time.time() - started) * 1000:7.0f}ms  {result.verdict}"
                    )
        finally:
            launched.stop()

    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", nargs="*", help="glob(s) over scenario ids")
    parser.add_argument("--headed", action="store_true", help="watch it work")
    parser.add_argument("--chrome", help="path to a Chrome binary")
    parser.add_argument("--run-dir", type=Path, default=RUNS)
    args = parser.parse_args()

    scenarios = select(SCENARIOS, args.only)
    print(f"running {len(scenarios)} scenario(s)\n")

    results = run_all(
        scenarios, args.run_dir, headless=not args.headed, chrome=args.chrome
    )

    passed = sum(1 for r in results if r.ok)
    summary = {
        "scenarios": len(results),
        "passed": passed,
        "failed": len(results) - passed,
        "results": [
            {
                "id": r.scenario_id,
                "group": next((s.group for s in scenarios if s.id == r.scenario_id), ""),
                "goal": r.goal,
                "ok": r.ok,
                "verdict": r.verdict,
                "status": r.status,
                "steps": r.steps,
                "wallMs": round(r.wall_ms, 1),
                "checks": r.checks,
                "failures": r.failures,
                "checkpoints": [
                    {"name": c["name"], "shot": c["shot"], "atMs": c["at_ms"]}
                    for c in r.checkpoints
                ],
                "progress": {
                    "verified": sum(
                        1
                        for e in (r.progress.get("entries") or [])
                        if e.get("status") == "verified"
                    ),
                    "entries": len(r.progress.get("entries") or []),
                    "plan": [
                        {"id": leg.get("id"), "status": leg.get("status"),
                         "attempts": leg.get("attempts"), "failure": leg.get("failure")}
                        for leg in (r.progress.get("plan") or [])
                    ],
                    "retries": r.progress.get("retries"),
                    "stalled": r.progress.get("stalled"),
                },
            }
            for r in results
        ],
    }

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"\n  {passed}/{len(results)} scenarios passed")
    print(f"  {REPORT}")
    print(f"  {args.run_dir}")

    if passed != len(results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
