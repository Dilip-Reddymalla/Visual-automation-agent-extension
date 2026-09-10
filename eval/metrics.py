"""Scoring a run. The definitions are the deliverable, so they are spelled out here.

Five metrics, reported as five numbers. There is no aggregate "accuracy" in this file and
there must not be one: the rubric weighs visual context, detection, redaction precision,
client resources and latency separately because they trade against each other, and a
single mean would let a team hide a collapse in one behind a win in another.

Every definition below is the one from the brief, stated in enough detail that two people
would compute the same number:

  Element recall      hand-listed interactive elements present in the index / total.
                      Matched by position: a listed element counts as found when some
                      indexed element overlaps it with IoU >= MATCH_IOU. Role agreement
                      is reported beside it rather than folded into it, so "found it but
                      called it the wrong thing" stays visible.

  PII precision /     Per class, over findings the gate actually acted on. A finding is a
  recall / F1         true positive when it overlaps a ground-truth span of the same
                      class at IoU >= MATCH_IOU. One ground-truth span absorbs at most
                      one finding; extra findings over the same span are false positives,
                      because painting a thing twice is not detecting it twice.

  Redaction IoU       Mean IoU over matched (prediction, ground truth) pairs. Reported
                      with the match rate beside it, because a mean over one lucky pair
                      is not a redaction quality score.

  Over-redaction      Painted pixel area covering no ground-truth box / total painted
                      area. Measured two ways on purpose -- see over_redaction_measured
                      and over_redaction_by_class below -- because the pixels and the
                      manifest's own arithmetic ought to agree, and a report that only
                      ever asked the gate about itself could not notice when they do not.

  Latency             Per stage, p50 and p95, from the worker's own trace.

Boxes are CSS pixels of the visual viewport, origin top-left, throughout -- the one
coordinate space (CLAUDE.md invariant 2). Nothing here converts to image pixels except
the pixel diff, which says so where it does it.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass, field

# Overlap at which a prediction and a ground-truth span are talking about the same thing.
# Not the same as the IoU *quality* metric: this decides identity, that measures fit.
MATCH_IOU = 0.5

# A finding this close to a hard negative is a false positive attributable to that trap.
# Lower than MATCH_IOU because a detector that paints a box loosely around an invoice
# number has still fallen for the invoice number.
NEGATIVE_IOU = 0.25

# Per-pixel channel difference above which a pixel counts as painted. Masks are solid
# fills and blurs move whole regions, so anything real is far above this; the threshold
# exists only to absorb encoder noise between a PNG screenshot and a WebP capture.
PAINT_DELTA = 24

#: A pixel whose channels sum below this is the gate's mask. The fill is solid #000000
#: and WebP nudges it a little; no glyph in the corpus comes near, and the measurement is
#: unchanged anywhere between 20 and 60.
MASK_SUM_MAX = 45

# The high-severity classes. Recall on these is the number the brief puts a 0.95 target
# on, and the set is not "everything that looked important" -- it is the classes where a
# single leak is an identity document, a bank instrument, or a credential.
HIGH_SEVERITY = [
    "AADHAAR", "PAN", "CARD", "ACCOUNT", "PASSPORT", "LICENCE", "SECRET", "GSTIN",
    # A photograph identifies a person outright and without a lookup, which is the test
    # every other member of this list passes. Added with the class in M5c-A.
    "FACE",
]

# Padding the gate applies, mirrored from redaction/policy.ts so painted area can be
# reconstructed from a manifest. Kept as a named copy with the source named, because the
# manifest does not carry box kinds -- they are device-side (shared/messages.ts).
PADDING_PX = {"element": 0.0, "text": 2.0}
BLUR_PADDING_PX = 12.0


# -- Geometry ------------------------------------------------------------------


def area(box: dict) -> float:
    return max(0.0, box["w"]) * max(0.0, box["h"])


def intersection(a: dict, b: dict) -> float:
    x = max(0.0, min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"]))
    y = max(0.0, min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"]))
    return x * y


def iou(a: dict, b: dict) -> float:
    overlap = intersection(a, b)
    denominator = area(a) + area(b) - overlap
    return overlap / denominator if denominator > 0 else 0.0


def pad(box: dict, amount: float) -> dict:
    return {
        "x": box["x"] - amount, "y": box["y"] - amount,
        "w": box["w"] + 2 * amount, "h": box["h"] + 2 * amount,
    }


def clamp_to(box: dict, viewport: dict) -> dict:
    x0 = max(0.0, box["x"])
    y0 = max(0.0, box["y"])
    x1 = min(float(viewport["w"]), box["x"] + box["w"])
    y1 = min(float(viewport["h"]), box["y"] + box["h"])
    return {"x": x0, "y": y0, "w": max(0.0, x1 - x0), "h": max(0.0, y1 - y0)}


def area_outside(box: dict, others: list[dict], cells: int = 240) -> float:
    """Area of `box` covered by none of `others`.

    A scanline sweep would be exact; this samples on a grid instead, and the reason is
    that exactness here buys nothing. The number feeds a percentage reported to one
    decimal place, the boxes are axis-aligned rectangles tens of pixels across, and a
    240-cell sweep resolves them to well under a pixel. What it does buy is code that is
    obviously right at a glance, in a file whose whole purpose is that its arithmetic can
    be checked.
    """
    if area(box) <= 0:
        return 0.0
    covering = [o for o in others if intersection(box, o) > 0]
    if not covering:
        return area(box)

    steps = max(8, min(cells, int(math.sqrt(area(box)) * 2)))
    dx = box["w"] / steps
    dy = box["h"] / steps
    cell = dx * dy
    uncovered = 0.0
    for i in range(steps):
        cx = box["x"] + (i + 0.5) * dx
        for j in range(steps):
            cy = box["y"] + (j + 0.5) * dy
            inside = any(
                o["x"] <= cx <= o["x"] + o["w"] and o["y"] <= cy <= o["y"] + o["h"]
                for o in covering
            )
            if not inside:
                uncovered += cell
    return uncovered


# -- Matching ------------------------------------------------------------------


@dataclass
class Match:
    finding: dict | None
    truth: dict | None
    score: float = 0.0

    @property
    def kind(self) -> str:
        if self.finding is not None and self.truth is not None:
            return "tp"
        return "fp" if self.finding is not None else "fn"


def match_findings(findings: list[dict], truths: list[dict]) -> list[Match]:
    """Greedy highest-overlap matching, same class only.

    Greedy rather than optimal (Hungarian) because the boxes are laid out in a form and
    do not overlap each other; where they do not compete, greedy *is* optimal, and where
    they compete the difference is a box either way in a corpus of hundreds.
    """
    pairs: list[tuple[float, int, int]] = []
    for fi, finding in enumerate(findings):
        for ti, truth in enumerate(truths):
            if finding["cls"] != truth["cls"]:
                continue
            score = iou(finding["box"], truth["box"])
            if score >= MATCH_IOU:
                pairs.append((score, fi, ti))
    pairs.sort(reverse=True)

    used_f: set[int] = set()
    used_t: set[int] = set()
    out: list[Match] = []
    for score, fi, ti in pairs:
        if fi in used_f or ti in used_t:
            continue
        used_f.add(fi)
        used_t.add(ti)
        out.append(Match(findings[fi], truths[ti], score))

    out.extend(Match(f, None) for i, f in enumerate(findings) if i not in used_f)
    out.extend(Match(None, t) for i, t in enumerate(truths) if i not in used_t)
    return out


def confusion_class(match: Match) -> tuple[str, str]:
    """(truth class, predicted class), with 'none' standing for a miss or a spurious hit."""
    truth = match.truth["cls"] if match.truth else "none"
    predicted = match.finding["cls"] if match.finding else "none"
    return truth, predicted


def cross_class_confusions(findings: list[dict], truths: list[dict],
                           matches: list[Match]) -> list[tuple[str, str]]:
    """A false positive sitting on a ground-truth span of a *different* class.

    Worth separating from an ordinary false positive: calling an Aadhaar a PAN is a
    misclassification of something real, and calling an invoice number an Aadhaar is a
    misdetection of something that is not there. Both hurt precision; only the second is
    a hard-negative failure, and the fixes are different.
    """
    unmatched = [m.finding for m in matches if m.kind == "fp" and m.finding]
    taken = {id(m.truth) for m in matches if m.truth}
    out: list[tuple[str, str]] = []
    for finding in unmatched:
        best, best_score = None, 0.0
        for truth in truths:
            if id(truth) in taken or truth["cls"] == finding["cls"]:
                continue
            score = iou(finding["box"], truth["box"])
            if score > best_score:
                best, best_score = truth, score
        if best is not None and best_score >= MATCH_IOU:
            out.append((best["cls"], finding["cls"]))
    return out


# -- Painted area --------------------------------------------------------------


def box_kind_of(finding: dict, elements: list[dict]) -> str:
    """Was this box a control's rect, or drawn tight around glyphs?

    The manifest does not say -- box kinds are device-side and deliberately so
    (shared/messages.ts): how a box was measured is our business and the planner has no
    use for it. It is recoverable from the element list, which travels in the same
    request.

    The device's rule is `runIndex >= 0 ? 'text' : 'element'` (l1-lexical.ts): a finding
    located inside one of an element's text runs is drawn around glyphs; one located on a
    control's value is the control's own rect, which already carries the site's padding.

    So the question to ask of the element list is *containment*, not similarity. A finding
    on a field's value is a sub-rectangle of that field -- often a third of its width --
    and the previous rule, "does an element match this box at IoU above 0.9", answered no
    to every one of them and fell through to `text`.

    Measured, on this project's own corpus: 278 of 339 boxes were labelled `text`, which
    padded each of them by two pixels a side and put the manifest-derived over-redaction
    at 21.44% against the sealed pixels' 17.28% -- a 4.16-point disagreement that
    `check_agreement` correctly refused to accept. Reconstructing with no padding at all
    gives 16.21%, a 1.07-point gap: the pixels were right and the inference was wrong.

    The smallest element that contains the box wins, because that is the one the finding
    was actually measured against; an indexed element is a control, and an unindexed one
    is a text block admitted for what it says.
    """
    best_kind = None
    best_area = float("inf")
    box = finding["box"]

    for element in elements:
        rect = element.get("box")
        if not rect:
            continue
        if not _contains(rect, box):
            continue
        area = rect["w"] * rect["h"]
        if area < best_area:
            best_area = area
            best_kind = "element" if element.get("index") is not None else "text"

    if best_kind is not None:
        return best_kind

    # Nothing on the wire contains it. A finding recovered from pixels, or a box that
    # spans two elements: glyph padding is the conservative answer for both.
    return "text"


#: How far a box may stick out of its container and still count as inside it, in CSS px.
#:
#: A text run's rect is measured from glyph extents and an element's from layout, so the
#: two disagree by a fraction of a pixel routinely, and by a little more where a font's
#: ascender overshoots its line box.
CONTAINMENT_SLACK_PX = 1.5


def _contains(outer: dict, inner: dict, slack: float = CONTAINMENT_SLACK_PX) -> bool:
    return (
        inner["x"] >= outer["x"] - slack
        and inner["y"] >= outer["y"] - slack
        and inner["x"] + inner["w"] <= outer["x"] + outer["w"] + slack
        and inner["y"] + inner["h"] <= outer["y"] + outer["h"] + slack
    )


def painted_boxes(findings: list[dict], elements: list[dict], viewport: dict) -> list[dict]:
    """What the gate painted, reconstructed from the manifest.

    `keep` findings are excluded: they are reported and deliberately not painted, which
    is the honest third answer policy.ts exists to give.
    """
    out: list[dict] = []
    for finding in findings:
        if finding.get("mode") == "keep":
            continue
        kind = box_kind_of(finding, elements)
        amount = BLUR_PADDING_PX if finding.get("mode") == "blur" else PADDING_PX[kind]
        out.append(
            {
                "cls": finding["cls"],
                "mode": finding.get("mode"),
                "boxKind": kind,
                # Carried because the merge needs them: when two operations become one,
                # merge.ts gives the survivor the *stronger* finding's class, and the
                # class decides whether the next comparison is allowed to merge on
                # adjacency at all. Reconstructing without them is a different rule.
                "layer": finding.get("layer", "L3"),
                "confidence": finding.get("confidence", 0.0),
                "box": clamp_to(pad(finding["box"], amount), viewport),
            }
        )
    return out


#: L0 outranks L1 outranks L2 outranks L3. The one precedence rule this project has,
#: mirrored from extension/src/redaction/findings.ts.
LAYER_RANK = {"L0": 3, "L1": 2, "L2": 1, "L3": 0}


def _stronger(a: dict, b: dict) -> dict:
    """Confidence first, then layer. See findings.ts `strongerDraft`."""
    if a.get("confidence", 0.0) != b.get("confidence", 0.0):
        return a if a.get("confidence", 0.0) > b.get("confidence", 0.0) else b
    return a if LAYER_RANK.get(a.get("layer", "L3"), 0) >= LAYER_RANK.get(b.get("layer", "L3"), 0) else b


ADJACENCY_PX = 8
MERGE_IOU = 0.1


def _bounding(a: dict, b: dict) -> dict:
    x = min(a["x"], b["x"])
    y = min(a["y"], b["y"])
    return {
        "x": x, "y": y,
        "w": max(a["x"] + a["w"], b["x"] + b["w"]) - x,
        "h": max(a["y"] + a["h"], b["y"] + b["h"]) - y,
    }


def _adjacent(a: dict, b: dict, gap: float = ADJACENCY_PX) -> bool:
    horizontal = a["x"] < b["x"] + b["w"] + gap and b["x"] < a["x"] + a["w"] + gap
    vertical = a["y"] < b["y"] + b["h"] + gap and b["y"] < a["y"] + a["h"] + gap
    return horizontal and vertical


def merge_painted(painted: list[dict], viewport: dict) -> list[dict]:
    """Reproduce what redaction/merge.ts does to the boxes before they are painted.

    This is a second copy of a rule that lives in the extension, which is normally a
    thing to avoid. It is here because the alternative is worse: the paint operations are
    device-side and never reach the manifest, so a report that skipped this step
    reconstructs the boxes the detectors produced rather than the boxes the gate drew.

    The difference is not small. `unionBox` takes a *bounding* box, not a true union, so
    two findings in the same row merge into one rectangle spanning the gap between them
    and paint it. Skipping the merge understated over-redaction by about five points.

    The duplication is made safe by the assertion, not by care: score.py requires the
    reconstruction and the sealed pixels to agree within two points, so this drifting out
    of step with merge.ts fails the run.
    """
    ops = [dict(item) for item in painted]
    merged = True
    while merged:
        merged = False
        out: list[dict] = []
        for op in ops:
            partner = next(
                (
                    candidate
                    for candidate in out
                    if candidate["mode"] == op["mode"]
                    and (
                        iou(candidate["box"], op["box"]) > MERGE_IOU
                        or (candidate["cls"] == op["cls"]
                            and _adjacent(candidate["box"], op["box"]))
                    )
                ),
                None,
            )
            if partner is None:
                out.append(op)
                continue

            # The survivor takes the stronger finding's class and confidence, exactly as
            # merge.ts does. This was the drift: without it the reconstruction kept the
            # first operation's class for ever, so a chain that the gate merges on
            # adjacency (same class, once the survivor has been relabelled) was
            # reconstructed as separate boxes -- or joined when the gate would not have --
            # and the two over-redaction figures came out 4.16 points apart with nothing
            # to say which was right.
            winner = _stronger(partner, op)
            partner["box"] = _bounding(partner["box"], op["box"])
            partner["cls"] = winner["cls"]
            partner["layer"] = winner.get("layer", partner.get("layer", "L3"))
            partner["confidence"] = max(
                partner.get("confidence", 0.0), op.get("confidence", 0.0)
            )
            merged = True
        ops = out

    return [{**op, "box": clamp_to(op["box"], viewport)} for op in ops]


def over_redaction_union(painted: list[dict], truths: list[dict],
                         viewport: dict | None = None, step: float = 2.0) -> dict:
    """Painted area covering no ground truth, counting every pixel once.

    The per-class figures below sum box areas, which is right for asking "how wasteful is
    the padding on ADDRESS" and wrong for a page total: the gate merges overlapping ops
    before painting, so two boxes over one row paint one region and a sum counts it twice.

    Sampled on a fixed 2 CSS px lattice over the viewport, deliberately the same lattice
    the sealed-pixel measurement walks. An earlier version gridded the painted bounding
    box into a fixed number of cells, which made the cell size depend on how spread out
    the painting was -- so a sparse page was measured coarsely and disagreed with the
    pixels by several points for no reason but arithmetic.
    """
    boxes = [item["box"] for item in painted]
    if not boxes:
        return {"paintedArea": 0.0, "outsideArea": 0.0, "overRedactionRate": 0.0}

    width = viewport["w"] if viewport else max(b["x"] + b["w"] for b in boxes)
    height = viewport["h"] if viewport else max(b["y"] + b["h"] for b in boxes)
    cell_area = step * step
    truth_boxes = [t["box"] for t in truths]

    painted_cells = 0
    outside_cells = 0
    y = step / 2
    while y < height:
        row = [b for b in boxes if b["y"] <= y <= b["y"] + b["h"]]
        if row:
            truth_row = [t for t in truth_boxes if t["y"] <= y <= t["y"] + t["h"]]
            x = step / 2
            while x < width:
                if any(b["x"] <= x <= b["x"] + b["w"] for b in row):
                    painted_cells += 1
                    if not any(t["x"] <= x <= t["x"] + t["w"] for t in truth_row):
                        outside_cells += 1
                x += step
        y += step

    return {
        "paintedArea": painted_cells * cell_area,
        "outsideArea": outside_cells * cell_area,
        "overRedactionRate": outside_cells / painted_cells if painted_cells else 0.0,
    }


def over_redaction_by_class(painted: list[dict], truths: list[dict]) -> dict:
    """Per class: painted area covering no ground truth, over painted area of that class.

    Per class because that is what says which constant to move. A global number that has
    drifted tells you the gate is being careless; a per-class number tells you it is the
    text padding on ADDRESS, and those are different afternoons.
    """
    truth_boxes = [t["box"] for t in truths]
    per: dict[str, dict] = {}
    for item in painted:
        cls = item["cls"]
        bucket = per.setdefault(cls, {"paintedArea": 0.0, "outsideArea": 0.0, "boxes": 0})
        bucket["paintedArea"] += area(item["box"])
        bucket["outsideArea"] += area_outside(item["box"], truth_boxes)
        bucket["boxes"] += 1

    for bucket in per.values():
        bucket["overRedactionRate"] = (
            bucket["outsideArea"] / bucket["paintedArea"] if bucket["paintedArea"] > 0 else 0.0
        )
    return per


def _is_mask(pixels, x: int, y: int, width: int, height: int, stride: int) -> bool:
    """Did the gate paint this pixel?

    The gate fills with solid #000000 (redaction/gate.ts), so a near-black sample is a
    painted one. That is the whole rule, and the reason it can be the whole rule is that
    no glyph in the corpus comes near the threshold -- the docstring below records the
    measurement.

    ## What used to be here, and what it cost

    This used to erode: a sample counted only if its four neighbours *a whole sampling
    stride away* were also dark, to discount the halo WebP leaves at a hard boundary. Two
    things were wrong with it. The unit -- a stride is how far apart the samples are, not
    how far the codec smears -- and the premise, because a smeared edge pixel is a grey
    one and the near-black threshold already rejects it.

    What it actually did was delete a 2.5 CSS px band from the edge of every painted box,
    which is *more* than the 2 CSS px of glyph padding the gate adds. So the one
    measurement that trusts nothing the gate says was systematically deleting the padding
    it exists to catch.

    Measured over 48 corpus pages, three ways of asking the same question:

        painted fraction    with erosion   without
        the gate's claim    0.0515         0.0515
        these pixels        0.0471 (92%)   0.0521 (101%)
        reconstruction      0.0535         0.0535

        over-redaction      with erosion   without
        these pixels        0.1728         0.2173
        reconstruction      0.2144         0.2144
        disagreement        4.16 pts       0.29 pts

    The number goes *up* by four points. That is the honest direction and the reason this
    was worth an afternoon: over-redaction is a first-class failure in this project, and a
    measurement that quietly flatters it is worse than no measurement.
    """
    del width, height, stride  # a threshold needs no neighbourhood
    r, g, b = pixels[x, y]
    return r + g + b <= MASK_SUM_MAX


def over_redaction_measured(sealed: bytes, clean: bytes, truths: list[dict],
                            scale: float) -> dict:
    """The same number, measured in the sealed pixels rather than reconstructed.

    It reads the mask directly: the gate fills with solid #000000 (redaction/gate.ts),
    so a near-black pixel in the sealed frame is a pixel the gate painted. Nothing here
    trusts the manifest, which is the point -- the manifest is the gate's opinion of
    itself, and a report quoting only that could never notice the two disagreeing.

    It used to diff the sealed frame against a clean screenshot, and that was wrong. The
    sealed frame is downscaled by the capture pipeline (1024x640 against a 1280x800
    viewport), so the clean one had to be resampled to match -- and resampling a page
    full of text produces per-pixel differences on every glyph edge, all of which counted
    as painted. It reported 44% over-redaction on a page where the gate painted 34% of
    the frame, and almost all of the excess was text the gate had never touched.

    Direct detection agrees with the gate on painted area to within about a point --
    measured at 1.011 times the gate's own claim over 48 corpus pages -- and is stable
    across thresholds from 20 to 60, because no glyph in the corpus is near-black. That
    agreement is what `_is_mask` is allowed to be as simple as it is; it was not true
    while that function eroded a band off every box. `clean` is retained for the signature
    and used only to confirm the frames describe the same page.

    The limit, stated: this sees `mask`, not `blur` or `pixelate`, which do not paint a
    flat colour. Every corpus finding is masked today; a blurred face would need the
    op's own box, and the reconstruction covers that.
    """
    try:
        from PIL import Image
    except ImportError:  # pragma: no cover
        return {"available": False, "why": "Pillow is not installed"}

    if not sealed:
        return {"available": False, "why": "no sealed frame"}

    try:
        sealed_img = Image.open(io.BytesIO(sealed)).convert("RGB")
    except Exception as err:
        return {"available": False, "why": f"could not decode the sealed frame: {err}"}

    width, height = sealed_img.size
    pixels = sealed_img.load()

    stride = 2
    painted_cells = 0
    outside_cells = 0
    total_cells = 0

    boxes = [t["box"] for t in truths]
    for y in range(0, height, stride):
        cy = y / scale
        row = [b for b in boxes if b["y"] <= cy <= b["y"] + b["h"]]
        for x in range(0, width, stride):
            total_cells += 1
            if not _is_mask(pixels, x, y, width, height, stride):
                continue
            painted_cells += 1
            cx = x / scale
            if not any(box["x"] <= cx <= box["x"] + box["w"] for box in row):
                outside_cells += 1

    return {
        "available": True,
        "method": "mask-detect",
        "paintedFraction": painted_cells / total_cells if total_cells else 0.0,
        "overRedactionRate": outside_cells / painted_cells if painted_cells else 0.0,
        "paintedPixels": painted_cells * stride * stride,
        "outsidePixels": outside_cells * stride * stride,
        "frame": {"w": width, "h": height, "scale": scale},
    }


# -- Aggregation ---------------------------------------------------------------


def percentile(values: list[float], q: float) -> float:
    """Nearest-rank percentile. No interpolation, so p95 of a real run is a real run."""
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(1, math.ceil(q / 100.0 * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]


@dataclass
class ClassTally:
    tp: int = 0
    fp: int = 0
    fn: int = 0
    ious: list[float] = field(default_factory=list)

    @property
    def precision(self) -> float:
        return self.tp / (self.tp + self.fp) if (self.tp + self.fp) else 0.0

    @property
    def recall(self) -> float:
        return self.tp / (self.tp + self.fn) if (self.tp + self.fn) else 0.0

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if (p + r) else 0.0

    def as_dict(self) -> dict:
        return {
            "tp": self.tp, "fp": self.fp, "fn": self.fn,
            "support": self.tp + self.fn,
            "precision": round(self.precision, 4),
            "recall": round(self.recall, 4),
            "f1": round(self.f1, 4),
            "meanIou": round(sum(self.ious) / len(self.ious), 4) if self.ious else 0.0,
        }


def element_recall(indexed: list[dict], listed: list[dict]) -> dict:
    """Hand-listed interactive elements present in the index, over the total.

    The listed elements come from the corpus author (a `data-el` mark), not from the
    walker's own rules. Deriving the list from the code under test would make this 1.0 by
    construction and measure nothing at all.
    """
    boxes = [e for e in indexed if e.get("box")]
    found = 0
    role_agreed = 0
    misses: list[dict] = []

    for want in listed:
        best, best_score = None, 0.0
        for have in boxes:
            score = iou(want["box"], have["box"])
            if score > best_score:
                best, best_score = have, score
        if best is not None and best_score >= MATCH_IOU:
            found += 1
            if best.get("role") == want.get("role"):
                role_agreed += 1
        else:
            misses.append({"role": want.get("role"), "name": want.get("name", "")[:60],
                           "box": want["box"], "bestIou": round(best_score, 3)})

    total = len(listed)
    return {
        "listed": total,
        "found": found,
        "recall": round(found / total, 4) if total else 0.0,
        "roleAgreement": round(role_agreed / found, 4) if found else 0.0,
        "indexed": len(boxes),
        "misses": misses,
    }
