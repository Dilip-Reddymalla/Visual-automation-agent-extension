"""The baseline benchmark: one machine-readable view of the current system.

Before optimising latency or accuracy, there has to be evidence of what the system does
today. This assembles that evidence from the *same run artefacts* the rubric scorer reads
(eval/runner/run.py writes one directory per page) -- so it measures the real extension
pipeline, perception and redaction and the gate, not synthetic timings taken around
isolated functions.

Two rules hold throughout, because a baseline that breaks either is worse than none:

  Nothing is fabricated. A number the current build does not measure is emitted as
  `available: false` with the reason -- never invented, never a plausible-looking
  placeholder. Cold-start model latency, the server planner, and the folded sub-phases
  are all real gaps in this run's instrumentation and are marked as such.

  Nothing raw is recorded. Everything here comes from the StepTrace (already privacy-
  audited before the worker emits it -- worker/trace.ts) and from HostStats (counts and
  bytes). No screenshot, no OCR text, no element value, no vault secret. The privacy
  block is *projected* from the rubric score, never recomputed by weaker means.

    python eval/harness.py          # runs the corpus, writes report.json AND baseline.json
    python eval/baseline.py         # rebuild baseline.json from the last run, no browser
    python eval/baseline.py --selftest   # dependency-free self-check of the aggregation

Four groups, each mapped to what the code actually records:

  latency   the worker's StepTrace phases (the real pipeline) plus the device-model
            stages and the step/task totals. Stages the trace folds into a parent phase
            are listed and marked unavailable, not timed twice or invented.
  models    device models (NER / OCR / face) warm-inference, from the offscreen
            TimingRing via HostStats. Planner models are not exercised by this harness
            (it records a fixed plan) and point at scripts/bench-*.py, which measure them
            against a real Ollama.
  agent     action attempts / execution / verification / tier / outcomes, from StepTrace.
            Verification is the page re-read after the action, not "execute() did not
            throw".
  privacy   PII recall/precision, redaction IoU, over-redaction, FP/FN -- projected from
            the rubric scorer (score.py), untouched.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from score import stats  # noqa: E402  -- the one shared statistic; see score.py

REPORT_DIR = HERE / "report"
REPORT = REPORT_DIR / "report.json"
BASELINE = REPORT_DIR / "baseline.json"
RUNS = REPORT_DIR / "runs"

# ── What each model is, and where its number legitimately comes from ──────────

#: Device perception models, keyed by the offscreen InferTask they report timings under
#: (shared/messages.ts, InferTask). These the harness *does* exercise.
DEVICE_MODELS = {
    "ner": {"role": "L2 PII NER (ONNX, WASM)", "licence": "MIT"},
    "ocrDet": {"role": "OCR text detection (ONNX, WebGPU)", "licence": "Apache-2.0"},
    "ocrRec": {"role": "OCR text recognition (ONNX, WebGPU)", "licence": "Apache-2.0"},
    "face": {"role": "L3 face detection, YuNet (ONNX, WebGPU)", "licence": "MIT"},
}

#: Planner models the routing ladder can reach, none of which this harness invokes: it
#: records a fixed plan so the perception/redaction numbers are repeatable (see the
#: harness docstring). They are measured instead by the scripts named here.
PLANNER_MODELS = {
    "qwen3:0.6b (tier1-tiebreak)": {
        "role": "Tier 1 tie-break, local (pick one index from a shortlist)",
        "measuredBy": "scripts/bench-planners.py, scripts/bench-reader.py",
    },
    "qwen2.5:1.5b (tier1-reader)": {
        "role": "Tier 1 reader, local (read a short goal into actions)",
        "measuredBy": "scripts/bench-reader.py",
    },
    "qwen2.5:1.5b (tier2-text)": {
        "role": "Tier 2 server text planner",
        "measuredBy": "scripts/bench-planners.py",
    },
    "qwen3-vl:4b (tier2-vision)": {
        "role": "Tier 2 server vision planner",
        "measuredBy": "scripts/bench-planners.py --vision --models qwen3-vl:4b",
        "note": "thinking variant; does not complete within the 60 s client budget on the "
        "dev CPU (MODEL-ROUTING.md §6). A GPU environment is required to measure it.",
    },
}

#: Why warm-only: offscreen/host.ts withTask() starts its timer *after* sessions.acquire(),
#: so the ring records inference and never the load. This is a real gap, not an oversight
#: to paper over.
COLD_START_NOTE = (
    "not instrumented: offscreen/host.ts withTask() starts its timer after "
    "sessions.acquire(), so the TimingRing records warm inference only and never the "
    "model load. Cold-start/load time cannot be reported from this run without new "
    "instrumentation."
)

WARM_NOTE = (
    "warm inference. One sample per page from HostStats.timings (TimingRing.latest, read "
    "mid-step in run.py). `count` is pages that recorded a sample, a floor, not a "
    "per-invocation count."
)

#: The twenty pipeline stages the brief names, each mapped to where its number comes from:
#:   phase:X   a StepTrace event named X          -- real, timed
#:   model:X   a device model's warm inference     -- from the TimingRing
#:   folded:X  happens inside phase X, no own timer -- marked unavailable, parent named
#:   server    the planner / network               -- not exercised by the fixed-plan harness
#:   total     the whole agent step (StepTrace.totalMs)
#:   task      wall clock for the page (run.json wallMs)
STAGE_MAP = [
    ("domPerception", "phase:perceive"),
    ("screenshotCapture", "phase:capture"),
    ("frameDecode", "folded:capture"),
    ("downscale", "folded:capture"),
    ("ocrDetection", "model:ocrDet"),
    ("ocrRecognition", "model:ocrRec"),
    ("nerInference", "model:ner"),
    ("faceDetection", "model:face"),
    ("findingMerge", "folded:detect"),
    ("redactionPainting", "folded:seal"),
    ("sealGate", "phase:seal"),
    ("networkRequest", "server"),
    ("serverPlanner", "server"),
    ("plannerResponseValidation", "folded:plan"),
    ("elementResolution", "folded:execute"),
    ("actionExecution", "phase:execute"),
    ("domSettle", "phase:settle"),
    ("verification", "folded:settle"),
    ("totalAgentStep", "total"),
    ("totalTask", "task"),
]

VERIFY_REASONS = (
    "match", "differs", "empty", "missing", "unresolved", "not-applicable", "not-done",
)


# ── Reading the artefacts ─────────────────────────────────────────────────────


def _read(run_dir: Path, page_id: str, name: str) -> dict | None:
    path = run_dir / page_id / name
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


# ── Group 2: model latency ────────────────────────────────────────────────────


def model_latency(run_dir: Path, pages: list[dict]) -> dict:
    """Warm inference per device model, pooled across pages; planner models marked absent.

    Each page's HostStats.timings is the ring's most-recent (warm) sample per task at the
    moment it was read (offscreen/timings.ts, run.py host_stats). Pooling those is a real
    warm-inference distribution -- one representative sample per page. Cold-start is not
    here (see COLD_START_NOTE) and is reported as unavailable, not guessed.
    """
    warm: dict[str, list[float]] = {task: [] for task in DEVICE_MODELS}
    resident: dict[str, int] = {task: 0 for task in DEVICE_MODELS}
    loaded_on: dict[str, int] = {task: 0 for task in DEVICE_MODELS}
    backends: set[str] = set()

    for page in pages:
        run = _read(run_dir, page["id"], "run.json") or {}
        host = run.get("hostStats") or {}
        backend = host.get("backend")
        if backend and backend != "none":
            backends.add(backend)
        timings = host.get("timings") or {}
        by_task = host.get("residentByTask") or {}
        loaded = host.get("loaded") or []
        for task in DEVICE_MODELS:
            value = timings.get(task)
            if value is not None:
                warm[task].append(float(value))
            if task in by_task and by_task[task] is not None:
                resident[task] = max(resident[task], int(by_task[task]))
            if task in loaded:
                loaded_on[task] += 1

    models: dict = {}
    for task, meta in DEVICE_MODELS.items():
        samples = warm[task]
        observed = bool(samples)
        entry = {
            "role": meta["role"],
            "licence": meta["licence"],
            "available": observed,
            "warmInferenceMs": stats(samples) if observed else None,
            "warmInferenceNote": WARM_NOTE,
            "coldStartMs": None,
            "coldStartAvailable": False,
            "coldStartNote": COLD_START_NOTE,
            "invocationsObserved": len(samples),
            "loadedOnPages": loaded_on[task],
            "residentBytesPeak": resident[task] or None,
            "backends": sorted(backends),
        }
        if not observed:
            entry["note"] = (
                "no warm sample on any page: the model was not invoked in this run "
                "(e.g. no faces present for `face`, or DOM-only pages that never reached "
                "OCR). Not a measurement of zero latency."
            )
        models[task] = entry

    for name, meta in PLANNER_MODELS.items():
        entry = {
            "role": meta["role"],
            "available": False,
            "reason": (
                "not exercised by the repeatable harness, which records a fixed plan for "
                f"repeatability (eval/harness.py). Measured by {meta['measuredBy']} "
                "against a real Ollama."
            ),
            "warmInferenceMs": None,
            "coldStartMs": None,
            "invocationsObserved": 0,
            "measuredBy": meta["measuredBy"],
        }
        if "note" in meta:
            entry["note"] = meta["note"]
        models[name] = entry

    return models


# ── Group 3: agent quality ────────────────────────────────────────────────────


def agent_quality(run_dir: Path, pages: list[dict]) -> dict:
    """Attempts, execution, verification, tier, outcomes -- aggregated from the StepTrace.

    An action is not counted a success because execute() did not throw. `execution` is the
    executor's own 'ok' / 'failed' / 'no-op', and verification is `fulfilled` -- the page
    re-read afterwards, a VerifyReason per field. Both are reported, because they answer
    different questions and conflating them is exactly the error the brief warns against.
    """
    attempts = exec_ok = exec_failed = exec_noop = 0
    plan_actions = plans_done = 0
    verify = dict.fromkeys(VERIFY_REASONS, 0)
    tiers = {"0": 0, "1": 0, "2": 0}
    sent_count = 0
    answered_by: dict[str, int] = {}
    local_proposed = local_rejected = local_attempts = 0
    outcomes = dict.fromkeys(("ok", "failed", "stopped", "interrupted", "incomplete"), 0)
    outcome_other = 0
    frames_discarded = 0
    steps = stale = runs_failed = 0

    for page in pages:
        run = _read(run_dir, page["id"], "run.json") or {}
        trace = _read(run_dir, page["id"], "trace.json")

        if not run.get("ok", False):
            runs_failed += 1
            note = (run.get("note") or "").lower()
            if any(s in note for s in ("never finished", "timeout", "would not hold still",
                                       "no active tab")):
                stale += 1

        if trace is None:
            continue
        steps += 1

        for outcome in trace.get("execution") or []:
            attempts += 1
            if outcome == "ok":
                exec_ok += 1
            elif outcome == "failed":
                exec_failed += 1
            elif outcome == "no-op":
                exec_noop += 1

        for reason in trace.get("fulfilled") or []:
            if reason in verify:
                verify[reason] += 1

        plan = trace.get("plan") or {}
        plan_actions += len(plan.get("actions") or [])
        if plan.get("done"):
            plans_done += 1

        tier = trace.get("tier") or {}
        which = tier.get("tier")
        if which in (0, 1, 2):
            tiers[str(which)] += 1
        if trace.get("sent"):
            sent_count += 1
        who = trace.get("answeredBy")
        if who:
            answered_by[who] = answered_by.get(who, 0) + 1

        local = trace.get("localPlan") or {}
        local_proposed += int(local.get("proposed") or 0)
        if local.get("rejected"):
            local_rejected += 1
        local_attempts += int(local.get("attempts") or 0)

        outcome = trace.get("outcome")
        if outcome in outcomes:
            outcomes[outcome] += 1
        else:
            outcome_other += 1
        frames_discarded += int(trace.get("framesDiscarded") or 0)

    verified = verify["match"] + verify["not-applicable"]
    verify_total = sum(verify.values())

    return {
        "note": (
            "The repeatable harness drives exactly one step per page with a fixed plan "
            "(no model is consulted). Action execution and per-field verification are "
            "real signals here; multi-step metrics -- steps-per-task, re-planning, Tier 1 "
            "retries -- are limited by that single-step design and are marked below."
        ),
        "stepsObserved": steps,
        "actionAttempts": attempts,
        "actionsExecutedOk": exec_ok,
        "actionsFailed": exec_failed,
        "actionsNoOp": exec_noop,
        "actionExecutionRate": round(exec_ok / attempts, 4) if attempts else None,
        "verification": {
            "byReason": verify,
            "verifiedCount": verified,
            "verifiedTotal": verify_total,
            "verificationSuccessRate": round(verified / verify_total, 4)
            if verify_total else None,
            "note": (
                "verification is the page re-read after the action (VerifyReason), not "
                "that execute() did not throw. 'match' and 'not-applicable' count as "
                "verified; 'differs' / 'empty' / 'missing' / 'unresolved' do not."
            ),
        },
        "planActionsProposed": plan_actions,
        "plansMarkedDone": plans_done,
        "tierUsage": tiers,
        "escalations": {
            "sentOverNetwork": sent_count,
            "answeredBy": answered_by,
            "note": "under one fixed open-ended goal + the local recorder, the tier split "
            "reflects that single goal, not a task mix.",
        },
        "tier1LocalPlan": {
            "proposedTotal": local_proposed,
            "rejectedSteps": local_rejected,
            "retryAttemptsTotal": local_attempts,
            "note": "Tier 1 local models are not invoked by this harness; zeros expected.",
        },
        "outcomes": {**outcomes, "otherOrNoTrace": outcome_other},
        "taskCompletionRate": round(outcomes["ok"] / steps, 4) if steps else None,
        "taskCompletionNote": "per-page single-step completion (verified outcome == 'ok'), "
        "not a multi-step task-completion rate.",
        "avgStepsPerCompletedTask": 1.0 if outcomes["ok"] else None,
        "avgStepsNote": "one step per page by harness design; not a measurement of "
        "multi-step behaviour.",
        "interruptedTasks": outcomes["interrupted"],
        "staleOrUnfinished": stale,
        "runsFailed": runs_failed,
        "framesDiscardedTotal": frames_discarded,
    }


# ── Group 1: pipeline latency, mapped to the twenty stages ────────────────────


def _stage(source: str, values: dict | None, available: bool) -> dict:
    entry = {"available": available, "source": source}
    for key in ("count", "mean", "p50", "p95", "max"):
        entry[key] = values.get(key) if (available and values) else (0 if key == "count" else None)
    return entry


def pipeline_latency(lat: dict, models: dict, task: dict) -> dict:
    """The twenty named stages. Real timers where they exist, marked absent where not."""
    by_phase = lat.get("byPhase", {})
    step = lat.get("step", {})
    stages: dict = {}
    for name, source in STAGE_MAP:
        kind, _, arg = source.partition(":")
        if kind == "phase":
            values = by_phase.get(arg)
            stages[name] = _stage(f"StepTrace phase '{arg}'", values, bool(values))
        elif kind == "model":
            warm = (models.get(arg) or {}).get("warmInferenceMs")
            stages[name] = _stage(
                f"device model '{arg}' warm inference (TimingRing); load excluded",
                warm, bool(warm),
            )
        elif kind == "folded":
            stages[name] = _stage(
                f"runs inside phase '{arg}'; no dedicated timer in this build", None, False
            )
        elif kind == "server":
            stages[name] = _stage(
                "not exercised: the harness uses a local fixed-plan recorder. Server and "
                "network latency are measured by scripts/bench-planners.py.",
                None, False,
            )
        elif kind == "total":
            stages[name] = _stage("StepTrace totalMs (whole agent step)", step,
                                  bool(step.get("count")))
        elif kind == "task":
            stages[name] = _stage(
                "wall clock per page (run.json wallMs); ~= step, one step per page here",
                task, bool(task.get("count")),
            )
    return stages


def task_latency(run_dir: Path, pages: list[dict]) -> dict:
    values = []
    for page in pages:
        run = _read(run_dir, page["id"], "run.json") or {}
        wall = run.get("wallMs")
        if wall:
            values.append(float(wall))
    return stats(values)


# ── Group 4: privacy, projected from the rubric score ─────────────────────────


def privacy(result: dict) -> dict:
    high = result["operatingPoints"]["highPrecision"]
    recall = result["operatingPoints"]["highRecall"]
    pii, red = high["pii"], high["redaction"]
    return {
        "operatingPoint": "highPrecision",
        "piiRecall": pii["micro"]["recall"],
        "piiPrecision": pii["micro"]["precision"],
        "piiF1": pii["micro"]["f1"],
        "piiRecallHighSeverity": pii["highSeverity"]["recall"],
        "piiPrecisionHighSeverity": pii["highSeverity"]["precision"],
        "truePositives": pii["micro"]["tp"],
        "falsePositives": pii["micro"]["fp"],
        "falseNegatives": pii["micro"]["fn"],
        "redactionIou": red["iouMatchedPairs"],
        "redactionIouOverAllGroundTruth": red["iouOverAllGroundTruth"],
        "overRedaction": red["overRedactionMeasured"],
        "overRedactionReconstructed": red["overRedactionReconstructed"],
        "boxesPerFinding": red["boxesPerFinding"],
        "hardNegativeSurvivalRate": high["hardNegatives"]["survivalRate"],
        "atHighRecall": {
            "piiRecall": recall["pii"]["micro"]["recall"],
            "piiPrecision": recall["pii"]["micro"]["precision"],
        },
        "perClass": pii["byClass"],
        "note": "projected from the rubric scorer (score.py). Both NER operating points "
        "come from the same run; nothing here is recomputed or weakened for the baseline.",
    }


# ── Assembly ──────────────────────────────────────────────────────────────────


def _iso(ms: int | None) -> str | None:
    if not ms:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms / 1000)) + "Z"


def _slim_point(point: dict) -> dict:
    """Just the headline of an aggregate -- the detail lives in report.json."""
    return {
        "pages": point.get("pages"),
        "piiRecall": point["pii"]["micro"]["recall"],
        "piiPrecision": point["pii"]["micro"]["precision"],
        "overRedaction": point["redaction"]["overRedactionMeasured"],
    }


def _held_out(held: dict) -> dict:
    if not held.get("scored") or not held.get("tunedOn"):
        return {"available": False, "note": "no held-out slice in this run"}
    return {
        "available": True,
        "ids": held.get("ids", []),
        "heldOut": _slim_point(held["scored"]),
        "tunedOn": _slim_point(held["tunedOn"]),
    }


def build(result: dict, run_dir: Path, pages: list[dict], resources: dict) -> dict:
    """The baseline report: run / latency / models / agent / privacy / evaluation.

    `models` and `agent` are reused from `result` if the harness already attached them, so
    a full run computes them once; a standalone rebuild recomputes from the run directory.
    """
    high = result["operatingPoints"]["highPrecision"]
    models = result.get("models") or model_latency(run_dir, pages)
    agent = result.get("agent") or agent_quality(run_dir, pages)

    return {
        "run": {
            "timestamp": _iso(result.get("generatedAt")),
            "generatedAtMs": result.get("generatedAt"),
            "harness": "eval/harness.py",
            "measures": "the real extension pipeline (perception, detection, the gate). "
            "The planner is a local fixed-plan recorder, so plan/server latency and the "
            "planner models are not exercised here -- see the models and latency notes.",
            "environment": {
                "inferenceBackends": resources.get("inferenceBackends", []),
                "residentModelBytes": resources.get("residentModelBytes"),
                "build": resources.get("build", {}),
                "pagesRequested": result.get("pagesRequested"),
                "pagesScored": result.get("pagesScored"),
                "pagesMissing": result.get("pagesMissing", []),
            },
        },
        "latency": pipeline_latency(high["latency"], models, task_latency(run_dir, pages)),
        "models": models,
        "agent": agent,
        "privacy": privacy(result),
        "evaluation": {
            "targets": result.get("targets", []),
            "heldOut": _held_out(result.get("heldOut", {})),
            "bySlice": {
                name: _slim_point(point)
                for name, point in (result.get("bySlice") or {}).items()
                if point
            },
            "resources": resources,
            "note": "the full rubric detail -- confusion matrix, per-class tables, the "
            "worst-case galleries -- is in report.json / report.html.",
        },
    }


# ── Terminal echo ─────────────────────────────────────────────────────────────


def print_summary(baseline: dict) -> None:
    print("\n  baseline")
    lat = baseline["latency"]
    step = lat.get("totalAgentStep", {})
    if step.get("available"):
        print(f"    step latency   p50 {step['p50']:.0f} ms   p95 {step['p95']:.0f} ms   "
              f"mean {step['mean']:.0f} ms   n {step['count']}")

    print("    model warm inference (device):")
    for task in DEVICE_MODELS:
        entry = baseline["models"].get(task, {})
        warm = entry.get("warmInferenceMs")
        if entry.get("available") and warm:
            print(f"      {task:8s} p50 {warm['p50']:.0f} ms  p95 {warm['p95']:.0f} ms  "
                  f"n {warm['count']}   (cold-start: unavailable)")
        else:
            print(f"      {task:8s} not invoked in this run")
    planners = [n for n, e in baseline["models"].items() if not e.get("available")
                and n not in DEVICE_MODELS]
    print(f"    planner models: {len(planners)} not exercised (fixed-plan harness) "
          f"-> scripts/bench-planners.py, scripts/bench-reader.py")

    agent = baseline["agent"]
    rate = agent["actionExecutionRate"]
    ver = agent["verification"]["verificationSuccessRate"]
    print(f"    actions: {agent['actionAttempts']} attempts, "
          f"exec-ok {rate if rate is not None else 'n/a'}, "
          f"verified {ver if ver is not None else 'n/a'}, "
          f"outcomes {agent['outcomes']}")

    priv = baseline["privacy"]
    print(f"    privacy: PII recall {priv['piiRecall']:.3f} precision "
          f"{priv['piiPrecision']:.3f}, redaction IoU {priv['redactionIou']:.3f}, "
          f"over-redaction {priv['overRedaction']:.1%}")


# ── Standalone rebuild + self-check ───────────────────────────────────────────


def _rebuild(run_dir: Path) -> None:
    """Rebuild baseline.json from the last run without touching the browser."""
    if not REPORT.exists():
        raise SystemExit(f"no {REPORT}. Run `python eval/harness.py` first.")
    result = json.loads(REPORT.read_text(encoding="utf-8"))
    resources_path = run_dir / "resources.json"
    resources = (
        json.loads(resources_path.read_text(encoding="utf-8"))
        if resources_path.exists() else result.get("resources", {})
    )
    corpus = json.loads((HERE / "corpus" / "corpus.json").read_text(encoding="utf-8"))
    ids_in_run = {p.name for p in run_dir.iterdir() if p.is_dir()} if run_dir.exists() else set()
    pages = [p for p in corpus["pages"] if p["id"] in ids_in_run] or corpus["pages"]

    report = build(result, run_dir, pages, resources)
    BASELINE.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print_summary(report)
    print(f"\n  {BASELINE}")


def _selftest() -> None:
    """Dependency-free check of the aggregation on synthetic artefacts. No pytest, no I/O
    into the real report. Proves: warm latency pools, cold-start is unavailable, planner
    models are absent, verification counts the right reasons, and privacy passes through.
    """
    import tempfile

    result = {
        "generatedAt": 1_700_000_000_000,
        "pagesRequested": 2,
        "pagesScored": 2,
        "pagesMissing": [],
        "operatingPoints": {
            "highPrecision": {
                "pii": {
                    "micro": {"tp": 8, "fp": 1, "fn": 2, "precision": 0.889,
                              "recall": 0.8, "f1": 0.842},
                    "highSeverity": {"recall": 0.95, "precision": 0.97},
                    "byClass": {"EMAIL": {"tp": 3, "fp": 0, "fn": 0, "precision": 1.0,
                                          "recall": 1.0, "f1": 1.0, "meanIou": 0.9}},
                },
                "redaction": {"iouMatchedPairs": 0.88, "iouOverAllGroundTruth": 0.7,
                              "overRedactionMeasured": 0.04, "overRedactionReconstructed": 0.05,
                              "boxesPerFinding": 1.0},
                "hardNegatives": {"survivalRate": 0.98},
                "latency": {
                    "byPhase": {
                        "perceive": {"count": 2, "n": 2, "mean": 100.0, "p50": 100.0,
                                     "p95": 120.0, "max": 120.0},
                        "seal": {"count": 2, "n": 2, "mean": 50.0, "p50": 50.0,
                                 "p95": 55.0, "max": 55.0},
                    },
                    "step": {"count": 2, "n": 2, "mean": 800.0, "p50": 800.0,
                             "p95": 900.0, "max": 900.0},
                },
            },
            "highRecall": {"pii": {"micro": {"recall": 0.9, "precision": 0.7}}},
        },
        "heldOut": {}, "bySlice": {}, "targets": [], "resources": {},
    }

    with tempfile.TemporaryDirectory() as tmp:
        run_dir = Path(tmp)
        # Page A: NER + OCR ran, one action executed and verified, sent to a planner.
        (run_dir / "a").mkdir()
        (run_dir / "a" / "run.json").write_text(json.dumps({
            "ok": True, "wallMs": 820,
            "hostStats": {"backend": "wasm", "residentBytes": 111_000_000,
                          "loaded": ["ner"], "timings": {"ner": 1300, "ocrDet": 40},
                          "residentByTask": {"ner": 111_000_000}},
        }))
        (run_dir / "a" / "trace.json").write_text(json.dumps({
            "traceVersion": 1, "execution": ["ok"], "fulfilled": ["match"],
            "plan": {"actions": ["type"], "done": True}, "tier": {"tier": 2, "reason": "open"},
            "sent": True, "answeredBy": "the recorder", "outcome": "ok", "framesDiscarded": 0,
        }))
        # Page B: NER ran again (pools with A), one action failed, one frame discarded.
        (run_dir / "b").mkdir()
        (run_dir / "b" / "run.json").write_text(json.dumps({
            "ok": False, "note": "the step never finished", "wallMs": 45000,
            "hostStats": {"backend": "wasm", "timings": {"ner": 1500}},
        }))
        (run_dir / "b" / "trace.json").write_text(json.dumps({
            "traceVersion": 1, "execution": ["failed"], "fulfilled": ["differs"],
            "plan": {"actions": ["click"], "done": False}, "tier": {"tier": 0, "decisions": []},
            "outcome": "incomplete", "framesDiscarded": 1,
        }))

        pages = [{"id": "a"}, {"id": "b"}]
        report = build(result, run_dir, pages, {"inferenceBackends": ["wasm"]})

    checks = []

    def check(name: str, cond: bool) -> None:
        checks.append((name, cond))

    ner = report["models"]["ner"]
    check("ner warm pooled from both pages (n=2)", ner["warmInferenceMs"]["count"] == 2)
    check("ner warm p50 is 1300 (nearest-rank of [1300,1500])", ner["warmInferenceMs"]["p50"] == 1300.0)
    check("ner cold-start unavailable", ner["coldStartAvailable"] is False and ner["coldStartMs"] is None)
    check("face not invoked -> unavailable", report["models"]["face"]["available"] is False)
    check("planner model present but unavailable",
          report["models"]["qwen3-vl:4b (tier2-vision)"]["available"] is False)
    check("nerInference stage sourced from model warm",
          report["latency"]["nerInference"]["available"] and report["latency"]["nerInference"]["p50"] == 1300.0)
    check("frameDecode folded -> unavailable", report["latency"]["frameDecode"]["available"] is False)
    check("serverPlanner unavailable", report["latency"]["serverPlanner"]["available"] is False)
    check("totalTask from wallMs (n=2)", report["latency"]["totalTask"]["count"] == 2)
    check("action attempts = 2", report["agent"]["actionAttempts"] == 2)
    check("exec ok = 1", report["agent"]["actionsExecutedOk"] == 1)
    check("verification success = 1/2", report["agent"]["verification"]["verificationSuccessRate"] == 0.5)
    check("tier usage 0 and 2 each once",
          report["agent"]["tierUsage"]["2"] == 1 and report["agent"]["tierUsage"]["0"] == 1)
    check("one escalation sent", report["agent"]["escalations"]["sentOverNetwork"] == 1)
    check("stale/unfinished = 1", report["agent"]["staleOrUnfinished"] == 1)
    check("frames discarded = 1", report["agent"]["framesDiscardedTotal"] == 1)
    check("privacy recall passes through", report["privacy"]["piiRecall"] == 0.8)
    check("privacy over-redaction passes through", report["privacy"]["overRedaction"] == 0.04)
    check("run timestamp rendered", report["run"]["timestamp"] == "2023-11-14T22:13:20Z")
    check("all 20 stages present", len(report["latency"]) == 20)

    ok = sum(1 for _, c in checks if c)
    for name, cond in checks:
        print(f"  {'ok  ' if cond else 'FAIL'} {name}")
    print(f"\n  {ok}/{len(checks)} checks passed")
    if ok != len(checks):
        raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--run-dir", type=Path, default=RUNS)
    parser.add_argument("--selftest", action="store_true",
                        help="check the aggregation on synthetic artefacts and exit")
    args = parser.parse_args()

    if args.selftest:
        _selftest()
    else:
        _rebuild(args.run_dir)


if __name__ == "__main__":
    main()
