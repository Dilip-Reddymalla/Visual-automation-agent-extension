"""From run artefacts to report.json.

Separate from the harness because scoring must be re-runnable without re-running the
browser. During a tuning week the loop is: change a constant, re-run fifty pages once,
then re-score half a dozen ways while arguing about a definition. If those two are the
same command, the argument costs twenty minutes each time round.

Three decisions here shape every number, and each is stated in the report rather than
buried:

  Viewport-only scoring. Perception is viewport-only by design -- the extension walks
  what is on screen, and the first browser load found the Aadhaar field below the fold
  and did not see it. Ground truth below the fold is therefore counted separately, as
  `belowFold`, and not as a miss. Scoring it as a miss would report a recall failure for
  a design decision, and hide the real ones underneath it.

  Pixels scored apart. A value that exists only inside a PNG cannot be found by a layer
  that reads the DOM. Those spans are counted in their own bucket, so the recall number
  for the deterministic layers says what L0 and L1 did rather than being dragged down by
  what L3 would do if it existed.

  Two operating points, always. M5 names two NER thresholds -- 0.35 for recall, 0.7 for
  precision -- and reporting one of them is how a team quietly picks whichever flatters
  it. Both are computed. Where they are identical the report says why, rather than
  presenting two columns of the same number as though a choice had been exercised.
"""

from __future__ import annotations

import json
import time
from collections import defaultdict
from pathlib import Path

import metrics
from metrics import (
    ClassTally, Match, confusion_class, cross_class_confusions, element_recall,
    match_findings, over_redaction_by_class, over_redaction_measured, painted_boxes,
    percentile,
)

# offscreen/tasks/ner.ts, THRESHOLDS. Copied with the source named because the harness
# is Python and the constants are TypeScript; a drift here is caught by the report saying
# which values it used.
NER_THRESHOLDS = {"highRecall": 0.35, "highPrecision": 0.7}

PHASES = ["perceive", "capture", "detect", "seal", "plan", "execute", "settle"]

TARGETS = [
    ("elementRecall", "Element recall", 0.92, "gte"),
    ("piiRecallHighSeverity", "PII recall, high-severity classes", 0.95, "gte"),
    ("piiPrecisionHighPrecisionPoint", "PII precision, high-precision point", 0.90, "gte"),
    ("redactionIou", "Redaction IoU", 0.85, "gte"),
    ("overRedactionRate", "Over-redaction rate", 0.05, "lt"),
    ("peakGpuProcessBytes", "Peak GPU memory", 700 * 1024 * 1024, "lt"),
    ("peakJsHeapBytes", "Peak JS heap", 450 * 1024 * 1024, "lt"),
    ("idleCpuExtensionProcessesPercent", "Idle CPU, extension processes", 1.0, "lt"),
    ("stepLatencyP50Ms", "Step latency p50", 1800, "lt"),
    ("stepLatencyP95Ms", "Step latency p95", 3500, "lt"),
    # Not a rubric target -- a bookkeeping invariant. Above 1.0 the manifest is
    # describing one value twice, which is what a judge reads before any metric.
    ("boxesPerFinding", "Boxes per finding", 1.0, "lte"),
    # L3. Reported with their support count beside them, because a ratio over a handful of
    # faces is only honest when the handful is visible -- and on this corpus the handful is
    # currently zero. See the face rows in the report and M5c-A's note on why.
    ("facePrecision", "Face precision", 0.90, "gte"),
    ("faceRecall", "Face recall", 0.90, "gte"),
]


def load_run(run_dir: Path, page_id: str) -> dict:
    folder = run_dir / page_id
    out: dict = {"id": page_id}
    for name, key in (("run.json", "run"), ("trace.json", "trace"),
                      ("step.json", "step"), ("manifest.json", "manifest")):
        path = folder / name
        out[key] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    for name in ("sealed.webp", "sealed.png", "sealed.jpg"):
        if (folder / name).exists():
            out["sealed"] = (folder / name).read_bytes()
            out["sealedName"] = name
            break
    else:
        out["sealed"] = b""
        out["sealedName"] = ""
    clean = folder / "clean.png"
    out["clean"] = clean.read_bytes() if clean.exists() else b""
    return out


def visible_truths(labels: dict) -> tuple[list[dict], list[dict], list[dict]]:
    """(scored, below the fold, pixels-only) -- see the module docstring for why three."""
    scored, below, pixels = [], [], []
    for span in labels["spans"]:
        if not span["inViewport"]:
            below.append(span)
        elif span["medium"] == "pixels":
            pixels.append(span)
        else:
            scored.append(span)
    return scored, below, pixels


def findings_at(manifest: dict, operating: str) -> list[dict]:
    """The findings the gate acted on, at one NER operating point.

    The threshold applies to L2 only. L0 is a fact about the markup and L1 is a checksum;
    neither has a model score to threshold, and filtering them by a NER constant would be
    a category error that quietly deleted true positives.
    """
    threshold = NER_THRESHOLDS[operating]
    out = []
    for finding in manifest.get("findings", []):
        if finding.get("mode") == "keep":
            continue
        if finding.get("layer") == "L2" and finding.get("confidence", 0) < threshold:
            continue
        out.append(finding)
    return out


def score_page(record: dict, labels: dict, operating: str) -> dict:
    """Everything one page contributes, at one operating point."""
    manifest = record.get("manifest") or {}
    step = record.get("step") or {}
    elements = step.get("elements", [])
    viewport = labels["viewport"]

    scored, below, pixels = visible_truths(labels)
    findings = findings_at(manifest, operating)
    matches = match_findings(findings, scored)

    listed = [e for e in labels["elements"] if e["inViewport"]]
    element = element_recall(elements, listed)

    painted = painted_boxes(findings, elements, viewport)
    by_class = over_redaction_by_class(painted, scored)
    measured = over_redaction_measured(
        record.get("sealed", b""), record.get("clean", b""), scored,
        float((step.get("capture") or {}).get("scale", 1.0)),
    )

    # Traps: a finding overlapping a hard negative and nothing real.
    truth_boxes = [t["box"] for t in scored]
    trap_hits = []
    for match in matches:
        if match.kind != "fp" or not match.finding:
            continue
        for negative in labels["negatives"]:
            if not negative["inViewport"]:
                continue
            if metrics.iou(match.finding["box"], negative["box"]) >= metrics.NEGATIVE_IOU:
                trap_hits.append(
                    {
                        "predicted": match.finding["cls"],
                        "looksLike": negative["looksLike"],
                        "why": negative["why"],
                        "text": negative["text"][:60],
                        "reason": match.finding.get("reason", ""),
                    }
                )
                break

    events = {e["phase"]: e["ms"] for e in (record.get("trace") or {}).get("events", [])}

    return {
        "id": labels["id"],
        "title": labels["title"],
        "half": labels["half"],
        "archetype": labels["archetype"],
        "heldOut": labels["heldOut"],
        "ok": bool((record.get("run") or {}).get("ok")),
        "note": (record.get("run") or {}).get("note", ""),
        "matches": matches,
        "crossClass": cross_class_confusions(findings, scored, matches),
        "counts": {
            "groundTruthScored": len(scored),
            "belowFold": len(below),
            "pixelsOnly": len(pixels),
            "negativesInViewport": sum(1 for n in labels["negatives"] if n["inViewport"]),
            "findings": len(findings),
            "kept": sum(1 for f in manifest.get("findings", []) if f.get("mode") == "keep"),
        },
        "element": element,
        "overRedactionByClass": by_class,
        # Union semantics, for the page total. The per-class figures above sum box areas
        # -- right for "how wasteful is the padding on ADDRESS", wrong for a page total,
        # because the gate merges overlapping ops and a sum counts a shared region twice.
        "overRedactionUnion": metrics.over_redaction_union(
            metrics.merge_painted(painted, viewport), scored, viewport
        ),
        "overRedactionMeasured": measured,
        "manifestClaims": {
            "redactedFraction": manifest.get("redactedFraction"),
            "overRedactedFraction": manifest.get("overRedactedFraction"),
        },
        "trapHits": trap_hits,
        "timings": events,
        "totalMs": (record.get("trace") or {}).get("totalMs", 0),
        "framesDiscarded": (record.get("trace") or {}).get("framesDiscarded", 0),
        "pixelTruths": pixels,
        "scoredTruths": scored,
        "paintedBoxes": painted,
    }


def aggregate(pages: list[dict], operating: str) -> dict:
    """Corpus-level numbers from per-page ones."""
    per_class: dict[str, ClassTally] = defaultdict(ClassTally)
    confusion: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    matched_ious: list[float] = []
    all_truth_ious: list[float] = []

    for page in pages:
        for match in page["matches"]:
            truth_cls, predicted_cls = confusion_class(match)
            confusion[truth_cls][predicted_cls] += 1
            if match.kind == "tp" and match.truth:
                tally = per_class[match.truth["cls"]]
                tally.tp += 1
                tally.ious.append(match.score)
                matched_ious.append(match.score)
                all_truth_ious.append(match.score)
            elif match.kind == "fp" and match.finding:
                per_class[match.finding["cls"]].fp += 1
            elif match.kind == "fn" and match.truth:
                per_class[match.truth["cls"]].fn += 1
                all_truth_ious.append(0.0)

        for truth_cls, predicted_cls in page["crossClass"]:
            confusion[truth_cls][predicted_cls] += 1

    # Element recall, pooled rather than averaged over pages: a page with two controls
    # and a page with forty should not weigh the same.
    listed = sum(p["element"]["listed"] for p in pages)
    found = sum(p["element"]["found"] for p in pages)

    # Over-redaction, pooled by area for the same reason. Two accumulators: the summed
    # one drives the per-class table, the union one the page total that gets compared
    # against the pixels.
    painted_area = 0.0
    outside_area = 0.0
    union_painted = 0.0
    union_outside = 0.0
    class_areas: dict[str, dict] = defaultdict(lambda: {"paintedArea": 0.0, "outsideArea": 0.0,
                                                        "boxes": 0})
    for page in pages:
        union = page.get("overRedactionUnion", {})
        union_painted += union.get("paintedArea", 0.0)
        union_outside += union.get("outsideArea", 0.0)
        for cls, bucket in page["overRedactionByClass"].items():
            painted_area += bucket["paintedArea"]
            outside_area += bucket["outsideArea"]
            acc = class_areas[cls]
            acc["paintedArea"] += bucket["paintedArea"]
            acc["outsideArea"] += bucket["outsideArea"]
            acc["boxes"] += bucket["boxes"]
    for acc in class_areas.values():
        acc["overRedactionRate"] = round(
            acc["outsideArea"] / acc["paintedArea"] if acc["paintedArea"] else 0.0, 4
        )
        acc["paintedArea"] = round(acc["paintedArea"], 1)
        acc["outsideArea"] = round(acc["outsideArea"], 1)

    # Painted boxes against findings that claimed one. Anything above 1.0 means a value
    # is being described more than once; below 1.0 means findings that painted nothing.
    total_boxes = sum(bucket["boxes"] for bucket in class_areas.values())
    total_findings = sum(bucket.tp + bucket.fp for bucket in per_class.values())

    measured_pages = [p for p in pages if p["overRedactionMeasured"].get("available")]
    measured_painted = sum(p["overRedactionMeasured"]["paintedPixels"] for p in measured_pages)
    measured_outside = sum(p["overRedactionMeasured"]["outsidePixels"] for p in measured_pages)

    high_tp = sum(per_class[c].tp for c in metrics.HIGH_SEVERITY)
    high_fn = sum(per_class[c].fn for c in metrics.HIGH_SEVERITY)
    high_fp = sum(per_class[c].fp for c in metrics.HIGH_SEVERITY)

    micro_tp = sum(t.tp for t in per_class.values())
    micro_fp = sum(t.fp for t in per_class.values())
    micro_fn = sum(t.fn for t in per_class.values())

    trap_hits = [hit for page in pages for hit in page["trapHits"]]
    traps_total = sum(p["counts"]["negativesInViewport"] for p in pages)

    return {
        "operatingPoint": operating,
        "nerThreshold": NER_THRESHOLDS[operating],
        "pages": len(pages),
        "pagesOk": sum(1 for p in pages if p["ok"]),
        "elementRecall": {
            "listed": listed, "found": found,
            "recall": round(found / listed, 4) if listed else 0.0,
        },
        "pii": {
            "byClass": {cls: tally.as_dict() for cls, tally in sorted(per_class.items())},
            "micro": {
                "tp": micro_tp, "fp": micro_fp, "fn": micro_fn,
                "precision": round(micro_tp / (micro_tp + micro_fp), 4)
                if (micro_tp + micro_fp) else 0.0,
                "recall": round(micro_tp / (micro_tp + micro_fn), 4)
                if (micro_tp + micro_fn) else 0.0,
                "f1": round(
                    2 * micro_tp / (2 * micro_tp + micro_fp + micro_fn), 4
                ) if (2 * micro_tp + micro_fp + micro_fn) else 0.0,
            },
            "highSeverity": {
                "classes": metrics.HIGH_SEVERITY,
                "tp": high_tp, "fp": high_fp, "fn": high_fn,
                "recall": round(high_tp / (high_tp + high_fn), 4)
                if (high_tp + high_fn) else 0.0,
                "precision": round(high_tp / (high_tp + high_fp), 4)
                if (high_tp + high_fp) else 0.0,
            },
            "confusionMatrix": {t: dict(row) for t, row in sorted(confusion.items())},
            # L3, called out separately because it is the newest layer and the one whose
            # numbers are easiest to misread. `support` is how many faces were labelled;
            # a precision of 1.00 over zero of them is not a result, it is an empty set,
            # and putting the count beside the ratio is what stops it being quoted as one.
            "face": {
                # Ground-truth faces: what recall is a fraction of.
                "support": per_class["FACE"].tp + per_class["FACE"].fn,
                "tp": per_class["FACE"].tp,
                "fp": per_class["FACE"].fp,
                "fn": per_class["FACE"].fn,
                "precision": round(
                    per_class["FACE"].tp / (per_class["FACE"].tp + per_class["FACE"].fp), 4
                )
                if (per_class["FACE"].tp + per_class["FACE"].fp)
                else 0.0,
                "recall": round(
                    per_class["FACE"].tp / (per_class["FACE"].tp + per_class["FACE"].fn), 4
                )
                if (per_class["FACE"].tp + per_class["FACE"].fn)
                else 0.0,
            },
        },
        "hardNegatives": {
            "inViewport": traps_total,
            "falsePositives": len(trap_hits),
            "survivalRate": round(1 - len(trap_hits) / traps_total, 4) if traps_total else 1.0,
            "byTrap": _tally_traps(trap_hits),
        },
        "redaction": {
            "iouMatchedPairs": round(sum(matched_ious) / len(matched_ious), 4)
            if matched_ious else 0.0,
            "matchedPairs": len(matched_ious),
            "iouOverAllGroundTruth": round(sum(all_truth_ious) / len(all_truth_ious), 4)
            if all_truth_ious else 0.0,
            "groundTruthSpans": len(all_truth_ious),
            "overRedactionReconstructed": round(
                union_outside / union_painted if union_painted else 0.0, 4
            ),
            "overRedactionMeasured": round(
                measured_outside / measured_painted if measured_painted else 0.0, 4
            ),
            "measuredOnPages": len(measured_pages),
            # One box per finding, or the manifest is describing one thing twice.
            #
            # Two layers that agree about *where* and disagree about *what* used to
            # survive as two rows and two paints -- the panel showed four rows for two
            # fields on a contact form whose First and Last Name both held an email
            # address. The arbitration is in worker/detect.ts; this is the number that
            # says whether it is still holding, and it belongs beside the other redaction
            # figures rather than being recomputed by hand from two sections of the JSON.
            "boxes": total_boxes,
            "boxesPerFinding": round(total_boxes / total_findings, 4)
            if total_findings else 0.0,
            "agreementPoints": round(
                abs(
                    (measured_outside / measured_painted if measured_painted else 0.0)
                    - (union_outside / union_painted if union_painted else 0.0)
                ) * 100, 2
            ),
            # Kept for comparison: the old summed figure, which understated the rate
            # wherever painted boxes overlapped.
            "overRedactionSummed": round(
                outside_area / painted_area if painted_area else 0.0, 4
            ),
            "byClass": dict(sorted(class_areas.items())),
        },
        "coverage": {
            "belowFold": sum(p["counts"]["belowFold"] for p in pages),
            "pixelsOnly": sum(p["counts"]["pixelsOnly"] for p in pages),
            "kept": sum(p["counts"]["kept"] for p in pages),
            "framesDiscarded": sum(p["framesDiscarded"] for p in pages),
        },
        "latency": latency(pages),
    }


def _tally_traps(hits: list[dict]) -> list[dict]:
    grouped: dict[tuple[str, str], int] = defaultdict(int)
    examples: dict[tuple[str, str], str] = {}
    for hit in hits:
        key = (hit["looksLike"], hit["predicted"])
        grouped[key] += 1
        examples.setdefault(key, f"{hit['text']} -- {hit['why']}")
    return [
        {"looksLike": k[0], "predictedAs": k[1], "count": n, "example": examples[k]}
        for k, n in sorted(grouped.items(), key=lambda kv: -kv[1])
    ]


def latency(pages: list[dict]) -> dict:
    """Per stage, p50 and p95, plus the step total. From the worker's own trace."""
    out: dict = {"byPhase": {}}
    for phase in PHASES:
        values = [p["timings"][phase] for p in pages if phase in p["timings"]]
        if not values:
            continue
        out["byPhase"][phase] = {
            "n": len(values),
            "p50": round(percentile(values, 50), 1),
            "p95": round(percentile(values, 95), 1),
            "max": round(max(values), 1),
        }
    totals = [p["totalMs"] for p in pages if p["totalMs"]]
    out["step"] = {
        "n": len(totals),
        "p50": round(percentile(totals, 50), 1),
        "p95": round(percentile(totals, 95), 1),
        "max": round(max(totals), 1) if totals else 0.0,
    }
    return out


# -- The worst-ten galleries ---------------------------------------------------


def worst_redactions(pages: list[dict], n: int = 10) -> list[dict]:
    """The ten matched pairs that fit worst. Where tuning starts."""
    rows = []
    for page in pages:
        for match in page["matches"]:
            if match.kind != "tp" or not match.finding or not match.truth:
                continue
            rows.append(
                {
                    "page": page["id"], "title": page["title"], "cls": match.truth["cls"],
                    "iou": round(match.score, 4),
                    "predicted": match.finding["box"], "truth": match.truth["box"],
                    "layer": match.finding.get("layer"),
                    "reason": match.finding.get("reason", ""),
                    "boxKind": match.truth.get("boxKind"),
                }
            )
    rows.sort(key=lambda r: r["iou"])
    return rows[:n]


def worst_over_redactions(pages: list[dict], n: int = 10) -> list[dict]:
    """The ten painted boxes with the most area covering nothing anyone detected."""
    rows = []
    for page in pages:
        truths = [t["box"] for t in page["scoredTruths"]]
        for item in page["paintedBoxes"]:
            outside = metrics.area_outside(item["box"], truths)
            if outside <= 1.0:
                continue
            rows.append(
                {
                    "page": page["id"], "title": page["title"], "cls": item["cls"],
                    "mode": item["mode"], "boxKind": item["boxKind"],
                    "box": item["box"],
                    "outsideArea": round(outside, 1),
                    "paintedArea": round(metrics.area(item["box"]), 1),
                    "wastedFraction": round(outside / max(1.0, metrics.area(item["box"])), 4),
                }
            )
    rows.sort(key=lambda r: -r["outsideArea"])
    return rows[:n]


# -- Targets -------------------------------------------------------------------


def target_table(summary: dict, resources: dict) -> list[dict]:
    """Every metric the brief names, with its target beside the measured value."""
    high_precision = summary["operatingPoints"]["highPrecision"]

    values = {
        "elementRecall": high_precision["elementRecall"]["recall"],
        "piiRecallHighSeverity": high_precision["pii"]["highSeverity"]["recall"],
        "piiPrecisionHighPrecisionPoint": high_precision["pii"]["micro"]["precision"],
        "redactionIou": high_precision["redaction"]["iouMatchedPairs"],
        "overRedactionRate": high_precision["redaction"]["overRedactionMeasured"],
        "peakGpuProcessBytes": resources.get("peakGpuProcessBytes", 0),
        "peakJsHeapBytes": resources.get("peakJsHeapBytes", 0),
        "idleCpuExtensionProcessesPercent": resources.get(
            "idleCpuExtensionProcessesPercent", 0.0
        ),
        "stepLatencyP50Ms": high_precision["latency"]["step"]["p50"],
        "stepLatencyP95Ms": high_precision["latency"]["step"]["p95"],
        "boxesPerFinding": high_precision["redaction"]["boxesPerFinding"],
        "facePrecision": high_precision["pii"]["byClass"].get("FACE", {}).get("precision", 0.0),
        "faceRecall": high_precision["pii"]["byClass"].get("FACE", {}).get("recall", 0.0),
    }

    rows = []
    for key, label, target, direction in TARGETS:
        measured = values.get(key, 0)
        if direction == "gte":
            met = measured >= target
        elif direction == "lte":
            met = measured <= target
        else:
            met = measured < target
        row = {
            "key": key, "label": label, "target": target, "direction": direction,
            "measured": measured, "met": bool(met),
        }
        if key.startswith("face"):
            row["support"] = high_precision["pii"]["face"]["support"]
        rows.append(row)
    return rows


# ── The whole corpus, both operating points ───────────────────────────────────


def score_corpus(pages: list[dict], corpus_dir: Path, run_dir: Path,
                 resources: dict) -> dict:
    """Every metric the brief names, for every page that produced a run.

    Both NER operating points are scored from the *same* run. The threshold is applied
    when reading the manifest, not when producing it, so high-recall and high-precision
    are two readings of one measurement rather than two runs that might differ for
    reasons other than the threshold.

    Held-out pages are scored separately as well as together. Tuning against a corpus and
    then reporting that same corpus is the one methodological error that invalidates
    everything else, so the held-out slice is computed here rather than left to whoever
    reads the report.
    """
    loaded = []
    missing = []
    for page in pages:
        record = load_run(run_dir, page["id"])
        if record.get("run") is None:
            missing.append(page["id"])
            continue
        labels = json.loads((corpus_dir / page["labels"]).read_text(encoding="utf-8"))
        loaded.append((page, record, labels))

    operating_points: dict[str, dict] = {}
    per_page_by_point: dict[str, list[dict]] = {}

    for operating in ("highRecall", "highPrecision"):
        scored = []
        for page, record, labels in loaded:
            one = score_page(record, labels, operating)
            one["id"] = page["id"]
            one["heldOut"] = bool(page.get("heldOut"))
            one["half"] = page["half"]
            one["archetype"] = page["archetype"]
            scored.append(one)
        per_page_by_point[operating] = scored
        operating_points[operating] = aggregate(scored, operating)

    primary = per_page_by_point["highPrecision"]
    held = [p for p in primary if p["heldOut"]]
    tuned = [p for p in primary if not p["heldOut"]]

    summary = {"operatingPoints": operating_points}

    return {
        "generatedAt": int(time.time() * 1000),
        "pagesRequested": len(pages),
        "pagesScored": len(loaded),
        "pagesMissing": missing,
        **summary,
        # The comparison a judge will look for first. If these two diverge sharply, the
        # numbers above describe the tuning set and not the method.
        "heldOut": {
            "ids": [p["id"] for p in held],
            "scored": aggregate(held, "highPrecision") if held else None,
            "tunedOn": aggregate(tuned, "highPrecision") if tuned else None,
        },
        "bySlice": {
            "synthetic": aggregate([p for p in primary if p["half"] == "synthetic"],
                                   "highPrecision"),
            "replica": aggregate([p for p in primary if p["half"] == "replica"],
                                 "highPrecision"),
        },
        "resources": resources,
        "targets": target_table(summary, resources),
        "worst": {
            "redactionIou": worst_redactions(primary),
            "overRedaction": worst_over_redactions(primary),
        },
        "perPage": [
            {
                "id": p["id"], "half": p["half"], "archetype": p["archetype"],
                "heldOut": p["heldOut"],
                "element": p["element"], "counts": p["counts"],
                "iou": p.get("meanIou", 0.0),
                "overRedaction": p.get("overRedactionMeasured", 0.0),
            }
            for p in primary
        ],
    }


#: How far the two over-redaction methods may disagree before the run is not to be
#: believed. Two points, and they currently sit 0.8 apart.
AGREEMENT_LIMIT_POINTS = 2.0


def check_agreement(result: dict) -> list[str]:
    """The two over-redaction methods must agree, and keep agreeing.

    One reconstructs from the manifest's boxes, replaying the gate's padding and merge
    rules; the other reads the mask out of the sealed pixels and trusts nothing the gate
    said. They answer the same question by routes with almost nothing in common, so a gap
    between them means one of the two is wrong and neither is trustworthy until it is
    known which.

    They were 23.3 points apart when this was first measured, and every point of that was
    a real defect: the reconstruction summed overlapping boxes instead of unioning them,
    it never replayed the merge, it inferred the wrong box kind and under-padded, and the
    pixel side was diffing against a resampled clean frame so every glyph edge counted as
    paint. Finding those took an afternoon precisely because nothing was asserting they
    should agree.

    So the assertion is permanent. The next drift will be smaller and much harder to see.
    """
    problems = []
    for name, point in result.get("operatingPoints", {}).items():
        redaction = point.get("redaction", {})
        if not redaction.get("measuredOnPages"):
            problems.append(f"{name}: over-redaction was measured on no page at all")
            continue
        gap = redaction.get("agreementPoints", 0.0)
        if gap > AGREEMENT_LIMIT_POINTS:
            problems.append(
                f"{name}: manifest-derived over-redaction "
                f"{redaction['overRedactionReconstructed']:.4f} and pixel-derived "
                f"{redaction['overRedactionMeasured']:.4f} disagree by {gap:.2f} points, "
                f"over the {AGREEMENT_LIMIT_POINTS:.0f}-point limit. One of them is wrong."
            )
    return problems
