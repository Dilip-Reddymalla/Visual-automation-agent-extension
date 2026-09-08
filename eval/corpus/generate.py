"""Build the corpus: generate, render, ship.

Three phases, and the separation between them is the point.

  generate   Author each page with `data-pii="<CLASS>"` on every planted value,
             `data-neg` on every trap and `data-el` on every control the corpus claims
             is interactive. Written to `_src/`, which is source, not corpus.

  render     Load each marked page once, headlessly, at the harness's exact viewport,
             and read the rendered rectangles. That is where ground truth comes from:
             the browser's own layout, not a human's estimate of it. Written to
             `labels/<id>.json`.

  ship       Strip every mark and write `pages/<id>.html`. This is the corpus. It
             carries no attribute the extension could read, and the extension never
             opens a label file.

The distinction matters more than it might look. A ground-truth attribute left in the
shipped page would be a hint to the detector, and the whole report would become a
measurement of how well the detector reads its own answer key. So the marked page and
the shipped page are different files, and the shipping step asserts they render to
identical pixels -- if stripping the marks moved anything, the rectangles in
`labels.json` describe a layout that no longer exists and the build fails rather than
publishing labels that are quietly wrong.

Hand-labelling is therefore needed only for pages that arrive from outside this
pipeline: genuine captures, dropped in through eval/capture/ and labelled with
eval/label_tool/.

    python eval/corpus/generate.py            # everything
    python eval/corpus/generate.py --only syn-gov-enrolment
"""

from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import replicas  # noqa: E402
import specs  # noqa: E402
from pages import Page, document  # noqa: E402
from values import Values, hard_negatives  # noqa: E402

SRC = HERE / "_src"
PAGES = HERE / "pages"
LABELS = HERE / "labels"
MANIFEST = HERE / "corpus.json"

# The viewport the labels are measured at. The harness uses the same numbers, and it
# must: a box is only ground truth for the layout it was measured against, and a corpus
# rendered at one width and scored at another would report a systematic IoU miss that
# has nothing to do with the detector.
VIEWPORT = {"width": 1280, "height": 800}
DEVICE_SCALE = 1.0

SEED = 26171

# Ten pages nobody tunes against. Fixed here, in the build, rather than chosen at report
# time -- a holdout picked after the numbers are in is not a holdout. Five from each
# half, spanning six archetypes, so the split cannot be dismissed as the easy pages.
HOLDOUT = {
    "syn-gov-passport",
    "syn-bank-card",
    "syn-scan-cheque",
    "syn-health-discharge",
    "syn-shop-addresses",
    "rep-epfo-passbook",
    "rep-hdfc-card",
    "rep-utility-bill",
    "rep-univ-admission",
    "rep-aadhaar-profile",
}


# -- Phase 1: generate ---------------------------------------------------------


def build_pages() -> list[Page]:
    """Every page, marked. Deterministic given SEED."""
    v = Values(SEED)
    negatives = hard_negatives(random.Random(SEED + 1))
    # Cycled, so a corpus with more pages than traps still gives every page a trap and
    # the distribution stays even rather than front-loaded.
    pool = iter(_cycle(negatives))

    out: list[Page] = []
    for half, table in (("synthetic", specs.SYNTHETIC), ("replica", replicas.REPLICAS)):
        for pid, title, archetype, builder, theme, density, font_px in table:
            body = builder(v, pool)
            out.append(
                Page(
                    pid=pid, title=title, half=half, archetype=archetype,
                    theme=theme, density=density, font_px=font_px, body=body,
                )
            )
    return out


def _cycle(items: list[dict]):
    while True:
        for item in items:
            yield item


# -- Phase 2: render, and read the layout out of the browser -------------------

# Runs in the page. Returns every ground-truth rectangle the marks imply.
#
# A text value's box is a Range over its contents, not the wrapper's client rect. For an
# inline span they are usually the same, but when a value wraps across two lines the
# client rect is the union of both lines and stretches the full column width; the Range
# gives the lines themselves. Ground truth should be the glyphs.
READ_LABELS_JS = r"""
() => {
  const round = (n) => Math.round(n * 100) / 100;
  const box = (r) => ({ x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) });

  const union = (rects) => {
    const list = rects.filter((r) => r.width > 0 && r.height > 0);
    if (list.length === 0) return null;
    const x = Math.min(...list.map((r) => r.left));
    const y = Math.min(...list.map((r) => r.top));
    const right = Math.max(...list.map((r) => r.right));
    const bottom = Math.max(...list.map((r) => r.bottom));
    return { x: round(x), y: round(y), w: round(right - x), h: round(bottom - y) };
  };

  const glyphBox = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = Array.from(range.getClientRects());
    range.detach?.();
    return union(rects) ?? box(el.getBoundingClientRect());
  };

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const inView = (b) => b.y + b.h > 0 && b.y < vh && b.x + b.w > 0 && b.x < vw;

  const isField = (el) =>
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement;

  const spans = [];
  for (const el of document.querySelectorAll('[data-pii]')) {
    // A field's box is the control; a text value's box is its glyphs. This mirrors what
    // the detectors report, so IoU measures detection rather than a disagreement about
    // what a box is supposed to mean.
    const b = isField(el) ? box(el.getBoundingClientRect()) : glyphBox(el);
    spans.push({
      cls: el.getAttribute('data-pii'),
      box: b,
      boxKind: isField(el) ? 'element' : 'text',
      medium: 'text',
      tag: el.tagName.toLowerCase(),
      inViewport: inView(b),
    });
  }

  for (const el of document.querySelectorAll('[data-pii-pixels]')) {
    const b = box(el.getBoundingClientRect());
    spans.push({
      cls: el.getAttribute('data-pii-pixels'),
      box: b,
      boxKind: 'element',
      medium: 'pixels',
      tag: el.tagName.toLowerCase(),
      inViewport: inView(b),
    });
  }

  const negatives = [];
  for (const el of document.querySelectorAll('[data-neg]')) {
    const b = glyphBox(el);
    negatives.push({
      looksLike: el.getAttribute('data-neg'),
      why: el.getAttribute('data-neg-why') || '',
      text: (el.textContent || '').trim(),
      box: b,
      inViewport: inView(b),
    });
  }

  // The hand-listed interactive elements. Authored, not derived from the walker's own
  // rules -- deriving them from the code under test would make element recall 1.0 by
  // construction and measure nothing.
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'file') return 'file';
      if (t === 'password' || t === 'email' || t === 'tel' || t === 'text' || t === 'date')
        return 'textbox';
      return 'other';
    }
    return 'other';
  };

  const elements = [];
  for (const el of document.querySelectorAll('[data-el]')) {
    const b = box(el.getBoundingClientRect());
    const label =
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA'
        ? (el.closest('.f, .rowf')?.querySelector('label, .fake-label')?.textContent || '')
        : (el.textContent || ''));
    elements.push({
      role: roleOf(el),
      name: label.trim().replace(/\s+/g, ' ').slice(0, 80),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || null,
      box: b,
      inViewport: inView(b),
    });
  }

  return {
    viewport: { w: vw, h: vh },
    document: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
    spans,
    negatives,
    elements,
  };
}
"""

# Everything the shipped page must not carry.
MARK_ATTRIBUTES = ["data-pii", "data-pii-pixels", "data-neg", "data-neg-why", "data-el"]

STRIP_JS = r"""
(attrs) => {
  for (const attr of attrs) {
    for (const el of document.querySelectorAll('[' + attr + ']')) el.removeAttribute(attr);
  }
  return '<!doctype html>\n' + document.documentElement.outerHTML;
}
"""


def render_and_ship(pages: list[Page], only: str | None = None) -> list[dict]:
    from playwright.sync_api import sync_playwright

    SRC.mkdir(parents=True, exist_ok=True)
    PAGES.mkdir(parents=True, exist_ok=True)
    LABELS.mkdir(parents=True, exist_ok=True)

    records: list[dict] = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(
            viewport=VIEWPORT, device_scale_factor=DEVICE_SCALE
        )
        page = context.new_page()

        for spec in pages:
            if only and spec.pid != only:
                continue

            src_path = SRC / f"{spec.pid}.src.html"
            src_path.write_text(document(spec), encoding="utf-8")

            page.goto(src_path.as_uri(), wait_until="load")
            page.wait_for_timeout(60)  # let fonts settle before measuring

            marked_png = page.screenshot()
            read = page.evaluate(READ_LABELS_JS)
            shipped_html = page.evaluate(STRIP_JS, MARK_ATTRIBUTES)

            out_path = PAGES / f"{spec.pid}.html"
            out_path.write_text(shipped_html, encoding="utf-8")

            # The assertion that makes the labels trustworthy: stripping the marks must
            # not have moved a pixel. If it did, every rectangle in labels.json describes
            # a layout the shipped page no longer has.
            page.goto(out_path.as_uri(), wait_until="load")
            page.wait_for_timeout(60)
            shipped_png = page.screenshot()
            if shipped_png != marked_png:
                raise SystemExit(
                    f"{spec.pid}: stripping the ground-truth marks changed the rendering. "
                    "The labels would describe a layout that is not what ships."
                )

            labels = {
                "id": spec.pid,
                "title": spec.title,
                "half": spec.half,
                "archetype": spec.archetype,
                "theme": spec.theme,
                "density": spec.density,
                "fontPx": spec.font_px,
                "heldOut": spec.pid in HOLDOUT,
                "labelledBy": "generated",
                "viewport": read["viewport"],
                "document": read["document"],
                "spans": read["spans"],
                "negatives": read["negatives"],
                "elements": read["elements"],
            }
            (LABELS / f"{spec.pid}.json").write_text(
                json.dumps(labels, indent=2), encoding="utf-8"
            )

            records.append(
                {
                    "id": spec.pid,
                    "title": spec.title,
                    "half": spec.half,
                    "archetype": spec.archetype,
                    "density": spec.density,
                    "fontPx": spec.font_px,
                    "heldOut": spec.pid in HOLDOUT,
                    "page": f"pages/{spec.pid}.html",
                    "labels": f"labels/{spec.pid}.json",
                    "counts": {
                        "piiText": sum(1 for s in read["spans"] if s["medium"] == "text"),
                        "piiPixels": sum(1 for s in read["spans"] if s["medium"] == "pixels"),
                        "negatives": len(read["negatives"]),
                        "elements": len(read["elements"]),
                        "inViewportPii": sum(1 for s in read["spans"] if s["inViewport"]),
                        "inViewportElements": sum(
                            1 for e in read["elements"] if e["inViewport"]
                        ),
                    },
                }
            )
            print(
                f"  {spec.pid:26s} {read and len(read['spans']):3d} pii "
                f"{len(read['negatives']):3d} neg {len(read['elements']):3d} el"
                f"{'   [held out]' if spec.pid in HOLDOUT else ''}"
            )

        browser.close()

    return records


def main() -> None:
    ap = argparse.ArgumentParser(description="Build the eval corpus.")
    ap.add_argument("--only", help="build a single page id")
    ap.add_argument("--clean", action="store_true", help="remove previous output first")
    args = ap.parse_args()

    if args.clean:
        for d in (SRC, PAGES, LABELS):
            shutil.rmtree(d, ignore_errors=True)

    pages = build_pages()
    print(f"corpus: {len(pages)} pages ({sum(1 for p in pages if p.half == 'synthetic')} "
          f"synthetic, {sum(1 for p in pages if p.half == 'replica')} replica)")

    records = render_and_ship(pages, only=args.only)
    if args.only:
        return

    totals = {
        "pages": len(records),
        "synthetic": sum(1 for r in records if r["half"] == "synthetic"),
        "replica": sum(1 for r in records if r["half"] == "replica"),
        "heldOut": sum(1 for r in records if r["heldOut"]),
        "piiText": sum(r["counts"]["piiText"] for r in records),
        "piiPixels": sum(r["counts"]["piiPixels"] for r in records),
        "negatives": sum(r["counts"]["negatives"] for r in records),
        "elements": sum(r["counts"]["elements"] for r in records),
    }
    MANIFEST.write_text(
        json.dumps(
            {
                "seed": SEED,
                "viewport": {"w": VIEWPORT["width"], "h": VIEWPORT["height"]},
                "deviceScaleFactor": DEVICE_SCALE,
                "generatedBy": "eval/corpus/generate.py",
                "note": (
                    "Ground truth is read from the browser's own layout of the marked "
                    "source in _src/ and is never present in pages/. The shipped pages "
                    "carry no marks; the extension never reads a label file."
                ),
                "holdout": sorted(HOLDOUT),
                "totals": totals,
                "pages": records,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print()
    for k, val in totals.items():
        print(f"  {k:12s} {val}")
    print(f"\nwrote {MANIFEST.relative_to(HERE.parents[1])}")

    if totals["negatives"] < 60:
        raise SystemExit(
            f"only {totals['negatives']} hard negatives across the corpus; the brief "
            "asks for at least sixty, and they are what proves precision."
        )


if __name__ == "__main__":
    main()
