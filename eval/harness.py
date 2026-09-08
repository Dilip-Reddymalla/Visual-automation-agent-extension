"""Evaluation harness. One command, whole corpus, one report.

    python eval/harness.py                    # everything
    python eval/harness.py --only syn-gov-*   # a subset, same pipeline
    python eval/harness.py --score-only       # re-score the last run, no browser

Measures the five things the evaluation actually rewards:

  visual context accuracy   element recall against the hand-listed interactive elements
  PII recall / precision    per class, at both NER operating points, with a confusion
                            matrix and a hard-negative tally
  redaction precision       IoU against ground-truth boxes AND the over-redaction rate --
                            blacking out half a page must score badly, not well
  client resources          peak GPU memory, peak JS heap, resident model bytes, idle CPU
  end-to-end latency        per stage, p50 and p95

It reports five numbers because the rubric has five criteria. There is deliberately no
single "accuracy" figure: an aggregate that mixes recall with over-redaction is exactly
the number a team that blurs everything would want reported.

Offline throughout. The corpus is self-contained HTML served from a loopback port, and
the planner is a local recorder that returns a fixed plan -- no model is consulted,
because what is being measured here is perception and redaction, and a planner that
varied between runs would make the numbers unrepeatable.

## Loading the extension

Not `--load-extension`. Chrome 151 ignores it and
`--disable-features=DisableLoadExtensionCommandLineSwitch` does not bring it back. The
route that works is `--enable-unsafe-extension-debugging` plus the CDP
`Extensions.loadUnpacked` domain -- see runner/browser.py, and demo/LOAD-SESSION.md for
where that was established.

## activeTab, and the one thing the eval build changes

`chrome.tabs.captureVisibleTab` needs `activeTab` or a matching host permission.
`activeTab` is granted only by a real toolbar click and revoked on navigation, and there
is no gesture a harness can produce that earns it -- Playwright cannot click browser
chrome, and invoking the action from script is not a user gesture.

So runner/build.py copies `dist/chrome` and widens `host_permissions` to `<all_urls>` in
the copy, recording the shipped value and the reason in the manifest itself. `describe()`
refuses to score a build that does not carry that marker, and the report prints it.

This is a real deviation and it is stated rather than hidden: the bundle under test
differs from the shipped one in exactly one field. Everything the metrics measure --
perception, detection, the gate, the boxes -- is the shipped code. Get this wrong in the
other direction and every capture fails, every manifest is empty, and every metric reads
a confident zero.
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

from runner import browser, build, planner, resources, run as runner_run, serve  # noqa: E402
import score  # noqa: E402
import report as report_mod  # noqa: E402

CORPUS = HERE / "corpus"
REPORT_DIR = HERE / "report"
REPORT = REPORT_DIR / "report.json"
RUNS = REPORT_DIR / "runs"

#: What the driver is told to do. Deliberately the same on every page: the plan is not
#: what is being measured, and a goal that varied would make the traces incomparable.
GOAL = "Review this page and fill in whatever the form needs"


def load_corpus() -> dict:
    path = CORPUS / "corpus.json"
    if not path.exists():
        raise SystemExit(
            "eval/corpus/corpus.json is missing. Run `python eval/corpus/generate.py` first."
        )
    return json.loads(path.read_text(encoding="utf-8"))


def select(pages: list[dict], patterns: list[str] | None) -> list[dict]:
    if not patterns:
        return pages
    chosen = [p for p in pages if any(fnmatch.fnmatch(p["id"], pat) for pat in patterns)]
    if not chosen:
        raise SystemExit(f"no corpus page matches {patterns}")
    return chosen


def collect(pages: list[dict], run_dir: Path, *, headless: bool, chrome: str | None) -> dict:
    """Drive every page through one perception cycle and write the raw artefacts."""
    dist = ROOT / "dist" / "chrome"
    if not (dist / "manifest.json").exists():
        raise SystemExit("dist/chrome is missing. Run `npm run build` first.")

    eval_build = build.make_eval_build(dist, REPORT_DIR / "build")
    build_info = build.describe(eval_build)

    if run_dir.exists():
        shutil.rmtree(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)

    with serve.CorpusServer(CORPUS) as corpus_server, planner.PlannerServer() as plan_server:
        launched = browser.launch_chrome(headless=headless, executable=chrome)
        track = resources.ResourceTrack(launched.process.pid).start()

        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as pw:
                context_browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{launched.port}")
                context = context_browser.contexts[0]

                extension_id = browser.load_unpacked(context_browser, eval_build)
                worker = browser.wake_worker(context, extension_id)

                # No endpoint plumbing: PlannerServer binds the port transport.ts
                # already targets, so the extension reaches it unmodified. One less
                # thing that differs between what is measured and what ships.
                driver = runner_run.Driver(
                    context, extension_id, worker, plan_server, launched.port
                )

                failures = 0
                for i, page in enumerate(pages, 1):
                    url = corpus_server.url_for(page["page"])
                    started = time.time()
                    result = driver.run_page(page["id"], url, GOAL)
                    runner_run.write_artifacts(run_dir, result)

                    mark = "ok " if result.ok else "FAIL"
                    print(
                        f"  [{i:2d}/{len(pages)}] {mark} {page['id']:<28} "
                        f"{(time.time() - started) * 1000:6.0f}ms  {result.note}"
                    )
                    if not result.ok:
                        failures += 1

                # Idle CPU is only meaningful with nothing running, so it is sampled
                # here -- after the last session ended and before the browser closes.
                driver.stop()
                idle = track.idle_cpu_percent(window=5.0)
        finally:
            track.stop()
            launched.stop()

    # The per-page snapshots are the only place the JS heap and the resident model bytes
    # are visible: the heap has to be read from inside each context while a step is
    # running, and the inference host only exists for the length of a session. Peaks are
    # taken across the corpus here rather than left in fifty files nobody opens.
    peak_heap = 0
    heap_by_context: dict[str, int] = {}
    resident_model = 0
    backends = set()
    for page in pages:
        run_json = run_dir / page["id"] / "run.json"
        if not run_json.exists():
            continue
        record = json.loads(run_json.read_text(encoding="utf-8"))
        heap = record.get("heap", {})
        peak_heap = max(peak_heap, heap.get("totalBytes", 0))
        for context_name, used in heap.get("byContext", {}).items():
            heap_by_context[context_name] = max(heap_by_context.get(context_name, 0), used)
        stats = record.get("hostStats", {})
        resident_model = max(resident_model, stats.get("residentBytes", 0))
        if stats.get("backend"):
            backends.add(stats["backend"])

    peaks = track.peaks()
    resource_summary = {
        **peaks,
        **idle,
        "peakJsHeapBytes": peak_heap,
        "peakJsHeapByContext": heap_by_context,
        "residentModelBytes": resident_model,
        "inferenceBackends": sorted(backends),
        "build": build_info,
    }
    (run_dir / "resources.json").write_text(
        json.dumps(resource_summary, indent=2), encoding="utf-8"
    )
    print(f"\n  {len(pages) - failures}/{len(pages)} pages ran")
    return resource_summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", nargs="*", help="glob(s) over corpus page ids")
    parser.add_argument("--score-only", action="store_true", help="re-score the last run")
    parser.add_argument("--headed", action="store_true", help="watch it work")
    parser.add_argument("--chrome", help="path to a Chrome binary")
    parser.add_argument("--run-dir", type=Path, default=RUNS)
    args = parser.parse_args()

    corpus = load_corpus()
    pages = select(corpus["pages"], args.only)

    if args.score_only:
        resource_path = args.run_dir / "resources.json"
        if not resource_path.exists():
            raise SystemExit(f"nothing to score: {args.run_dir} has no run in it")
        resource_summary = json.loads(resource_path.read_text(encoding="utf-8"))
        print(f"scoring {len(pages)} page(s) from {args.run_dir}")
    else:
        print(f"running {len(pages)} page(s)\n")
        resource_summary = collect(
            pages, args.run_dir, headless=not args.headed, chrome=args.chrome
        )

    print("\nscoring")
    result = score.score_corpus(pages, CORPUS, args.run_dir, resource_summary)
    result["corpus"] = {
        "seed": corpus.get("seed"),
        "pages": len(pages),
        "heldOut": [p["id"] for p in pages if p.get("heldOut")],
        "note": corpus.get("note"),
    }

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(result, indent=2), encoding="utf-8")

    html = report_mod.render(result, args.run_dir)
    (REPORT_DIR / "report.html").write_text(html, encoding="utf-8")

    problems = score.check_agreement(result)
    report_mod.print_summary(result)
    for problem in problems:
        print(f"\n  DISAGREEMENT  {problem}")
    print(f"\n  {REPORT}")
    print(f"  {REPORT_DIR / 'report.html'}")

    if problems:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
