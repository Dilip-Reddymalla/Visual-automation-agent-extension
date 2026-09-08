"""The report: report.json rendered as one self-contained HTML page.

Self-contained because it has to travel -- to a judge, into a slide, onto a machine with
no network. Sealed images are embedded as data URIs and the CSS is inline, so the file
opens correctly from a USB stick a year from now.

The useful half is the gallery. Every tuning decision in week three comes from looking at
the ten worst redactions and the ten worst over-redactions with their boxes drawn on, and
a table of aggregate numbers cannot tell you that the padding is wrong on text runs but
right on fields. The numbers say something is off; the pictures say what.

Ground truth is drawn in one colour and the prediction in another, and they are labelled,
because a reader should never have to guess which box is the one we produced.
"""

from __future__ import annotations

import base64
import html
import json
from pathlib import Path

#: Ground truth and prediction. Chosen to survive greyscale printing and the two common
#: forms of colour blindness -- a judge should not need working red/green to read this.
TRUTH_COLOUR = "#0072b2"
PREDICTED_COLOUR = "#d55e00"

MIME_BY_SUFFIX = {".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg"}


def _data_uri(path: Path) -> str:
    mime = MIME_BY_SUFFIX.get(path.suffix, "application/octet-stream")
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"


def _sealed_for(run_dir: Path, page_id: str) -> tuple[str, dict] | None:
    """The sealed frame and the scale that maps CSS px onto it."""
    folder = run_dir / page_id
    for name in ("sealed.webp", "sealed.png", "sealed.jpg"):
        path = folder / name
        if path.exists():
            meta = {}
            run = folder / "run.json"
            if run.exists():
                meta = json.loads(run.read_text(encoding="utf-8")).get("capture", {})
            return _data_uri(path), meta
    return None


def _overlay(uri: str, meta: dict, boxes: list[dict]) -> str:
    """The sealed image with boxes drawn over it, in CSS px, scaled to the frame.

    The capture is taken at devicePixelRatio, so a box measured in CSS px has to be
    multiplied by `scale` to land on the right pixels. Getting this wrong draws every
    rectangle in approximately the right place, which is the worst possible outcome for a
    picture whose whole job is to show whether a box is in the right place.
    """
    scale = meta.get("scale") or 1
    width = meta.get("width") or 0
    height = meta.get("height") or 0
    if not width or not height:
        return f'<img src="{uri}" alt="sealed frame" />'

    shapes = []
    for box in boxes:
        b = box["box"]
        x, y = b["x"] * scale, b["y"] * scale
        w, h = b["w"] * scale, b["h"] * scale
        colour = box["colour"]
        shapes.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" '
            f'fill="none" stroke="{colour}" stroke-width="3" />'
            f'<text x="{x:.1f}" y="{max(12, y - 4):.1f}" fill="{colour}" '
            f'font-size="13" font-family="ui-monospace, monospace">'
            f"{html.escape(box['label'])}</text>"
        )

    return (
        f'<svg viewBox="0 0 {width} {height}" xmlns="http://www.w3.org/2000/svg" '
        f'role="img" aria-label="sealed frame with ground truth and predicted boxes">'
        f'<image href="{uri}" x="0" y="0" width="{width}" height="{height}" />'
        f'{"".join(shapes)}</svg>'
    )


def _fmt(value: float, key: str) -> str:
    if "Bytes" in key:
        return f"{value / (1024 * 1024):.0f} MB"
    if "Ms" in key:
        return f"{value:.0f} ms"
    if "Cpu" in key or "Percent" in key:
        return f"{value:.2f}%"
    return f"{value:.3f}"


def _target_rows(targets: list[dict]) -> str:
    rows = []
    for row in targets:
        arrow = {"gte": "&ge;", "lte": "&le;"}.get(row["direction"], "&lt;")
        state = "met" if row["met"] else "missed"
        rows.append(
            f'<tr class="{state}"><td>{html.escape(row["label"])}</td>'
            f'<td class="num">{_fmt(row["measured"], row["key"])}</td>'
            f'<td class="num muted">{arrow} {_fmt(row["target"], row["key"])}</td>'
            f'<td class="state">{"met" if row["met"] else "missed"}</td></tr>'
        )
    return "".join(rows)


def _confusion(matrix: dict) -> str:
    """Truth down the side, prediction across the top. `-` is a miss or a spurious box."""
    predicted = sorted({p for row in matrix.values() for p in row})
    head = "".join(f"<th>{html.escape(p)}</th>" for p in predicted)
    body = []
    for truth, row in sorted(matrix.items()):
        cells = []
        for p in predicted:
            n = row.get(p, 0)
            klass = "hit" if truth == p and n else ("miss" if n else "zero")
            cells.append(f'<td class="num {klass}">{n or ""}</td>')
        body.append(f"<tr><th>{html.escape(truth)}</th>{''.join(cells)}</tr>")
    return (
        f'<table class="confusion"><thead><tr><th>truth \\ predicted</th>{head}</tr>'
        f"</thead><tbody>{''.join(body)}</tbody></table>"
    )


def _class_rows(per_class: dict) -> str:
    rows = []
    for cls, t in sorted(per_class.items()):
        rows.append(
            f"<tr><td>{html.escape(cls)}</td>"
            f'<td class="num">{t["tp"]}</td><td class="num">{t["fp"]}</td>'
            f'<td class="num">{t["fn"]}</td>'
            f'<td class="num">{t["precision"]:.3f}</td>'
            f'<td class="num">{t["recall"]:.3f}</td>'
            f'<td class="num">{t["f1"]:.3f}</td>'
            f'<td class="num">{t.get("meanIou", 0):.3f}</td></tr>'
        )
    return "".join(rows)


def _gallery(items: list[dict], run_dir: Path, kind: str) -> str:
    cards = []
    for item in items:
        sealed = _sealed_for(run_dir, item["page"])
        if sealed is None:
            continue
        uri, meta = sealed

        if kind == "iou":
            boxes = [
                {"box": item["truth"], "colour": TRUTH_COLOUR, "label": "truth"},
                {"box": item["predicted"], "colour": PREDICTED_COLOUR, "label": "ours"},
            ]
            headline = f'IoU {item["iou"]:.3f}'
            detail = (
                f'{item["cls"]} &middot; {item.get("layer", "?")} &middot; '
                f'{item.get("boxKind", "?")} box &middot; {html.escape(item.get("reason", ""))}'
            )
        else:
            boxes = [{"box": item["box"], "colour": PREDICTED_COLOUR, "label": "painted"}]
            headline = f'{item["outsideArea"]:.0f} px&sup2; wasted'
            detail = (
                f'{item["cls"]} &middot; {item["mode"]} &middot; {item["boxKind"]} box '
                f'&middot; {item["wastedFraction"]:.0%} of the box covers nothing'
            )

        cards.append(
            f'<figure class="card"><figcaption><strong>{headline}</strong>'
            f'<span class="muted">{html.escape(item["page"])}</span>'
            f"<span class=\"detail\">{detail}</span></figcaption>"
            f'<div class="shot">{_overlay(uri, meta, boxes)}</div></figure>'
        )
    return "".join(cards) or '<p class="muted">Nothing to show: no page produced a frame.</p>'


def _held_out_note(held: dict) -> str:
    if not held.get("scored") or not held.get("tunedOn"):
        return '<p class="muted">No held-out slice in this run.</p>'

    a = held["scored"]["pii"]["micro"]
    b = held["tunedOn"]["pii"]["micro"]
    return (
        f'<table><thead><tr><th>slice</th><th>pages</th><th>precision</th>'
        f"<th>recall</th><th>F1</th></tr></thead><tbody>"
        f'<tr><td>held out</td><td class="num">{len(held["ids"])}</td>'
        f'<td class="num">{a["precision"]:.3f}</td><td class="num">{a["recall"]:.3f}</td>'
        f'<td class="num">{a["f1"]:.3f}</td></tr>'
        f'<tr><td>tuned on</td><td class="num">{held["tunedOn"]["pages"]}</td>'
        f'<td class="num">{b["precision"]:.3f}</td><td class="num">{b["recall"]:.3f}</td>'
        f'<td class="num">{b["f1"]:.3f}</td></tr>'
        f"</tbody></table>"
        f'<p class="muted">{html.escape(", ".join(held["ids"]))}</p>'
    )


def render(result: dict, run_dir: Path) -> str:
    high = result["operatingPoints"]["highPrecision"]
    recall_point = result["operatingPoints"]["highRecall"]
    res = result.get("resources", {})
    build = res.get("build", {})

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Redaction Gate &mdash; evaluation</title>
<style>
  :root {{ color-scheme: light dark; --ink:#14181e; --muted:#5b6472; --line:#d9dee7;
           --bg:#fff; --panel:#f6f8fb; --ok:#1a7f37; --bad:#b3261e;
           --truth:{TRUTH_COLOUR}; --pred:{PREDICTED_COLOUR}; }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --ink:#e9edf4; --muted:#a3adbb; --line:#333a45; --bg:#14181e;
             --panel:#1b1f26; --ok:#4ac26b; --bad:#f2b8b5; }} }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; font:15px/1.6 system-ui,sans-serif; color:var(--ink);
          background:var(--bg); }}
  main {{ max-width:1100px; margin:0 auto; padding:32px 24px 80px; }}
  h1 {{ font-size:26px; margin:0 0 4px; }}
  h2 {{ font-size:19px; margin:40px 0 8px; padding-top:16px;
        border-top:1px solid var(--line); }}
  p.lede {{ color:var(--muted); margin:0 0 8px; }}
  table {{ border-collapse:collapse; width:100%; margin:12px 0; font-size:14px; }}
  th,td {{ text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); }}
  th {{ font-weight:600; color:var(--muted); font-size:12px;
        text-transform:uppercase; letter-spacing:.04em; }}
  td.num, th.num {{ text-align:right; font-variant-numeric:tabular-nums;
                    font-family:ui-monospace,monospace; }}
  .muted {{ color:var(--muted); }}
  tr.met td.state {{ color:var(--ok); font-weight:600; }}
  tr.missed td.state {{ color:var(--bad); font-weight:600; }}
  .wrap {{ overflow-x:auto; }}
  .confusion td.hit {{ background:color-mix(in srgb, var(--ok) 16%, transparent); }}
  .confusion td.miss {{ background:color-mix(in srgb, var(--bad) 16%, transparent); }}
  .confusion td.zero {{ color:var(--muted); }}
  .grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr));
           gap:16px; margin-top:12px; }}
  .card {{ margin:0; border:1px solid var(--line); border-radius:8px; overflow:hidden;
           background:var(--panel); }}
  .card figcaption {{ padding:10px 12px; display:flex; flex-direction:column; gap:2px;
                      font-size:13px; border-bottom:1px solid var(--line); }}
  .card .detail {{ color:var(--muted); font-size:12px; }}
  .card .shot {{ background:#fff; }}
  .card svg, .card img {{ display:block; width:100%; height:auto; }}
  .key {{ display:flex; gap:16px; font-size:13px; margin:8px 0 0; }}
  .key span::before {{ content:''; display:inline-block; width:11px; height:11px;
                       margin-right:6px; vertical-align:baseline; border:3px solid; }}
  .key .t::before {{ border-color:var(--truth); }}
  .key .p::before {{ border-color:var(--pred); }}
  .note {{ background:var(--panel); border-left:3px solid var(--line);
           padding:10px 14px; margin:12px 0; font-size:14px; }}
</style></head><body><main>

<h1>Redaction Gate &mdash; evaluation</h1>
<p class="lede">{result["pagesScored"]} of {result["pagesRequested"]} corpus pages,
  {len(result.get("heldOut", {}).get("ids", []))} held out.
  Both NER operating points scored from the same run.</p>

<h2>What this run found</h2>
{_findings(result)}

<h2>Targets</h2>
<table><thead><tr><th>metric</th><th class="num">measured</th>
  <th class="num">target</th><th>&nbsp;</th></tr></thead>
  <tbody>{_target_rows(result["targets"])}</tbody></table>
<p class="muted">Five criteria, five numbers. There is deliberately no single
  &ldquo;accuracy&rdquo; figure: an aggregate that folds over-redaction into recall is
  the number a team that blurs everything would want quoted.</p>

<h2>Held out</h2>
<p class="lede">Ten pages never looked at while tuning. If these two rows diverge, the
  numbers above describe the tuning set rather than the method.</p>
{_held_out_note(result.get("heldOut", {}))}

<h2>PII, per class</h2>
<p class="lede">High-precision operating point. Micro-averaged:
  precision {high["pii"]["micro"]["precision"]:.3f},
  recall {high["pii"]["micro"]["recall"]:.3f},
  F1 {high["pii"]["micro"]["f1"]:.3f}.
  At high recall: precision {recall_point["pii"]["micro"]["precision"]:.3f},
  recall {recall_point["pii"]["micro"]["recall"]:.3f}.</p>
<div class="wrap"><table><thead><tr><th>class</th><th class="num">TP</th>
  <th class="num">FP</th><th class="num">FN</th><th class="num">precision</th>
  <th class="num">recall</th><th class="num">F1</th><th class="num">mean IoU</th>
  </tr></thead><tbody>{_class_rows(high["pii"]["byClass"])}</tbody></table></div>

<h2>Confusion matrix</h2>
<div class="wrap">{_confusion(high["pii"]["confusionMatrix"])}</div>

<h2>Hard negatives</h2>
<p class="lede">{high["hardNegatives"]["inViewport"]} planted decoys &mdash; invoice
  numbers that pass Verhoeff, order ids, amounts shaped like cards, place names that are
  also given names. {high["hardNegatives"]["falsePositives"]} were redacted anyway;
  {high["hardNegatives"]["survivalRate"]:.1%} survived. This is what makes the precision
  number above a measurement rather than an assertion.</p>
{_trap_table(high["hardNegatives"]["byTrap"])}

<h2>Redaction</h2>
<p class="lede">
  IoU over matched pairs {high["redaction"]["iouMatchedPairs"]:.3f}
  ({high["redaction"]["matchedPairs"]} pairs); over every ground-truth span, counting
  misses as zero, {high["redaction"]["iouOverAllGroundTruth"]:.3f}.
  Over-redaction, measured from the sealed pixels,
  {high["redaction"]["overRedactionMeasured"]:.1%}.</p>
{_over_by_class(high["redaction"]["byClass"])}

<h2>Latency</h2>
{_latency(high["latency"])}

<h2>Resources</h2>
{_resources(res)}
<div class="note"><strong>The build measured.</strong>
  {html.escape(build.get("why", "unrecorded"))}
  Shipped host permissions: <code>{html.escape(str(build.get("shippedHostPermissions", [])))}</code>.
  Changed for the eval build: <code>{html.escape(str(build.get("changedOnly", [])))}</code>.
  Everything the metrics measure is the shipped code.</div>

<h2>The ten worst redactions, by IoU</h2>
<p class="lede">Where tuning starts. A low IoU with the right class is a box in roughly
  the right place, and the fix is usually a constant; a low IoU with the wrong box kind
  is a modelling error.</p>
<p class="key"><span class="t">ground truth</span><span class="p">what we painted</span></p>
<div class="grid">{_gallery(result["worst"]["redactionIou"], run_dir, "iou")}</div>

<h2>The ten worst over-redactions, by wasted area</h2>
<p class="lede">Painted area covering nothing anyone labelled. These are the boxes that
  cost visual context for no privacy gain.</p>
<p class="key"><span class="p">painted</span></p>
<div class="grid">{_gallery(result["worst"]["overRedaction"], run_dir, "area")}</div>

</main></body></html>"""


def _findings(result: dict) -> str:
    """The two things a reader should see before the tables.

    A report whose first screen is a grid of numbers invites the reader to hunt for the
    green ones. These are the results that actually change what gets built next, and both
    are things a single demo page could not have shown.
    """
    slices = result.get("bySlice", {})
    syn, rep = slices.get("synthetic"), slices.get("replica")
    high = result["operatingPoints"]["highPrecision"]

    blocks = []

    if syn and rep:
        blocks.append(
            f'<div class="note"><strong>A page that displays personal data as prose is '
            f"not protected.</strong> Recall on authored <em>forms</em> is "
            f'{syn["pii"]["micro"]["recall"]:.3f}; on read-only <em>replica</em> pages it '
            f'is {rep["pii"]["micro"]["recall"]:.3f}. Perception walks for actionable '
            f"elements and their text runs, so an identifier sitting in a "
            f"<code>&lt;dd&gt;</code> never becomes an element: L0 has no attributes to "
            f"read and L1 has no text to scan. Almost every miss in the tables below is "
            f"this one cause, and it is structural rather than a threshold to tune.</div>"
        )

    redaction = high["redaction"]
    blocks.append(
        f'<div class="note"><strong>Over-redaction is '
        f'{redaction["overRedactionMeasured"]:.1%} against a target of 5%.</strong> '
        f"Measured from the sealed pixels, not from the manifest &mdash; the gate's own "
        f'reconstruction says {redaction["overRedactionReconstructed"]:.1%}, and a report '
        f"that quoted only that could never have noticed the two disagreeing. What "
        f"dominates is L0 marking whole form rows, label as well as value, so roughly half "
        f"the painted area covers captions carrying nothing. The per-class table below says "
        f"which constant to move.</div>"
    )

    blocks.append(
        f'<div class="note"><strong>IoU over matched pairs is '
        f'{redaction["iouMatchedPairs"]:.3f}, and over every ground-truth span '
        f'{redaction["iouOverAllGroundTruth"]:.3f}.</strong> The first number describes '
        f"only the spans that were found, and those are found by boxing the element they "
        f"sit in, so they fit exactly. The gap between the two is the honest summary of "
        f"this run.</div>"
    )

    return "".join(blocks)


def _trap_table(traps: list[dict]) -> str:
    if not traps:
        return '<p class="muted">No hard negative was redacted. Precision is clean.</p>'
    rows = "".join(
        f'<tr><td>{html.escape(t["looksLike"])}</td>'
        f'<td>{html.escape(t["predictedAs"])}</td>'
        f'<td class="num">{t["count"]}</td>'
        f'<td class="muted">{html.escape(t["example"])}</td></tr>'
        for t in traps
    )
    return (
        f"<table><thead><tr><th>looks like</th><th>redacted as</th>"
        f'<th class="num">n</th><th>example</th></tr></thead>'
        f"<tbody>{rows}</tbody></table>"
    )


def _over_by_class(by_class: dict) -> str:
    if not by_class:
        return '<p class="muted">Nothing was painted.</p>'
    rows = []
    for cls, b in sorted(by_class.items(), key=lambda kv: -kv[1]["outsideArea"]):
        painted = b["paintedArea"] or 1.0
        rows.append(
            f"<tr><td>{html.escape(cls)}</td>"
            f'<td class="num">{b["boxes"]}</td>'
            f'<td class="num">{b["paintedArea"]:.0f}</td>'
            f'<td class="num">{b["outsideArea"]:.0f}</td>'
            f'<td class="num">{b["outsideArea"] / painted:.1%}</td></tr>'
        )
    return (
        f"<table><thead><tr><th>class</th><th class=\"num\">boxes</th>"
        f'<th class="num">painted px&sup2;</th><th class="num">wasted px&sup2;</th>'
        f'<th class="num">wasted</th></tr></thead><tbody>{"".join(rows)}</tbody></table>'
        f'<p class="muted">Per class, because that is what says which constant to move.</p>'
    )


def _latency(lat: dict) -> str:
    rows = []
    for phase, v in lat.get("byPhase", {}).items():
        rows.append(
            f"<tr><td>{html.escape(phase)}</td>"
            f'<td class="num">{v["p50"]:.0f}</td><td class="num">{v["p95"]:.0f}</td>'
            f'<td class="num">{v["n"]}</td></tr>'
        )
    step = lat.get("step", {})
    rows.append(
        f'<tr><td><strong>step</strong></td>'
        f'<td class="num"><strong>{step.get("p50", 0):.0f}</strong></td>'
        f'<td class="num"><strong>{step.get("p95", 0):.0f}</strong></td>'
        f'<td class="num">{step.get("n", 0)}</td></tr>'
    )
    return (
        f'<table><thead><tr><th>phase</th><th class="num">p50 ms</th>'
        f'<th class="num">p95 ms</th><th class="num">n</th></tr></thead>'
        f"<tbody>{''.join(rows)}</tbody></table>"
    )


def _resources(res: dict) -> str:
    def mb(key: str) -> str:
        return f"{res.get(key, 0) / (1024 * 1024):.0f} MB"

    return (
        f"<table><tbody>"
        f'<tr><td>Peak GPU process memory</td><td class="num">{mb("peakGpuProcessBytes")}</td></tr>'
        f'<tr><td>Peak JS heap</td><td class="num">{mb("peakJsHeapBytes")}</td></tr>'
        f'<tr><td>Resident model bytes</td><td class="num">{mb("residentModelBytes")}</td></tr>'
        f'<tr><td>Peak private memory, whole tree</td>'
        f'<td class="num">{mb("peakPrivateBytes")}</td></tr>'
        f'<tr><td><strong>Idle CPU, extension processes</strong></td>'
        f'<td class="num"><strong>'
        f'{res.get("idleCpuExtensionProcessesPercent", 0):.2f}% of one core</strong></td></tr>'
        f'<tr><td>Idle CPU, whole browser tree</td>'
        f'<td class="num muted">{res.get("idleCpuPercentOfOneCore", 0):.2f}% of one core</td></tr>'
        f"</tbody></table>"
        f'<p class="muted">Two idle numbers, and the scored one is the smaller. A browser '
        f"with tabs open burns CPU on compositing and its own housekeeping whether or not "
        f"an extension is installed; charging that to the extension would be as dishonest "
        f"as not measuring it. The scored figure covers the processes that run extension "
        f"code, and because the offscreen document shares a renderer with pages it is an "
        f"upper bound rather than an exact attribution. Both are shown so the reader can "
        f"disagree with the split.</p>"
        f'<p class="muted">GPU allocation and JS heap rather than RSS: RSS on a '
        f"multi-process browser counts shared pages repeatedly and says nothing about "
        f"what the extension itself costs.</p>"
    )


def print_summary(result: dict) -> None:
    """The same numbers, for a terminal."""
    print()
    for row in result["targets"]:
        arrow = {"gte": ">=", "lte": "<="}.get(row["direction"], "<")
        mark = "ok  " if row["met"] else "MISS"
        # A ratio without its denominator is the number that gets quoted back at you. The
        # face rows carry their support inline for exactly that reason: "0.000 over 0
        # labelled faces" is a different statement from "0.000".
        note = f"  over {row['support']} labelled" if "support" in row else ""
        print(
            f"  {mark} {row['label']:<38} {_fmt(row['measured'], row['key']):>10}  "
            f"({arrow} {_fmt(row['target'], row['key'])}){note}"
        )

    held = result.get("heldOut", {})
    if held.get("scored") and held.get("tunedOn"):
        a, b = held["scored"]["pii"]["micro"], held["tunedOn"]["pii"]["micro"]
        print(
            f"\n  held out  P {a['precision']:.3f} R {a['recall']:.3f}"
            f"   |  tuned on  P {b['precision']:.3f} R {b['recall']:.3f}"
        )
