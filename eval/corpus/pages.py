"""The corpus, as authored source.

Fifty pages, written here as data and rendered to self-contained HTML. Each planted
value carries `data-pii="<CLASS>"`, each trap carries `data-neg="<CLASS it mimics>"`, and
each control the corpus claims is interactive carries `data-el="1"`.

Those attributes are ground truth for scoring, and they are stripped before the page is
shipped. `generate.py` renders the marked source once, reads the rendered rectangles, and
writes `labels.json`; the page that goes into `pages/` carries no marks at all. The
extension never reads a label file and never sees an attribute. Getting this backwards --
shipping the marks and letting the detector see them -- would turn the whole corpus into
a tautology, so it is worth being explicit: **the marks exist only in `_src/`.**

Two halves, and they are not the same kind of thing.

  synthetic (25)  Clean layouts of the eight archetypes the brief names, varied by
                  density, font size, and whether the PII is text or pixels. Written to
                  be legible, so that a failure is diagnosable.

  replica (25)    Modelled on real Indian portals, banks and marketplaces -- and modelled
                  is the honest word. They are *not* captures. Fetching and anonymising
                  twenty-five live sites could not be done safely here, and shipping
                  someone's real Aadhaar in a repository is the one thing this project
                  must never do. What they replicate is the part that matters to a
                  detector: DOM that is nested six divs deep, values in table cells with
                  no label element, inputs whose only name is a placeholder attribute,
                  ARIA roles standing in for semantics, and identifiers sitting in
                  running text rather than in fields. See eval/capture/ for the pipeline
                  that turns a genuine capture into a corpus page when one is available.
"""

from __future__ import annotations

import html
import random
from dataclasses import dataclass, field as dc_field

from values import Values, hard_negatives

# -- Marker helpers ------------------------------------------------------------
#
# Everything that becomes ground truth goes through one of these three, so there is
# exactly one place that decides what a mark looks like and one place for generate.py to
# agree with.


def esc(text: str) -> str:
    return html.escape(str(text), quote=True)


def pii(value: str, cls: str, tag: str = "span") -> str:
    """A planted true positive, wrapped tightly so its rectangle is the value's own."""
    return f'<{tag} data-pii="{cls}">{esc(value)}</{tag}>'


def neg(text: str, looks_like: str, why: str) -> str:
    """A hard negative. Shaped like `looks_like`, and not PII."""
    return f'<span data-neg="{looks_like}" data-neg-why="{esc(why)}">{esc(text)}</span>'


def el(attrs: str = "") -> str:
    """Mark a control as one the corpus expects the index to contain."""
    return f'data-el="1" {attrs}'.strip()


# -- Page assembly -------------------------------------------------------------


@dataclass
class Page:
    pid: str
    title: str
    half: str  # 'synthetic' | 'replica'
    archetype: str
    theme: str
    density: str
    font_px: int
    body: str
    notes: str = ""
    negatives_used: list[dict] = dc_field(default_factory=list)


THEMES = {
    # Plain government form: boxed fieldsets, uppercase legends, a lot of small text.
    "gov": {
        "ink": "#101418", "muted": "#4d5762", "line": "#c9d0da",
        "accent": "#0b4a8f", "panel": "#eef2f7", "bg": "#ffffff",
        "family": "'Segoe UI', system-ui, sans-serif",
    },
    # Bank: tabular, right-aligned numerals, ruled rows.
    "bank": {
        "ink": "#14181e", "muted": "#5b6472", "line": "#dde2ea",
        "accent": "#00524d", "panel": "#f4f7f6", "bg": "#ffffff",
        "family": "'Segoe UI', system-ui, sans-serif",
    },
    # Marketplace: cards, chips, a sticky summary rail.
    "shop": {
        "ink": "#1a1a1a", "muted": "#666666", "line": "#e6e6e6",
        "accent": "#c2410c", "panel": "#fafafa", "bg": "#ffffff",
        "family": "system-ui, 'Helvetica Neue', sans-serif",
    },
    # Portal: left navigation, breadcrumb, a content pane.
    "portal": {
        "ink": "#111827", "muted": "#6b7280", "line": "#e5e7eb",
        "accent": "#4338ca", "panel": "#f9fafb", "bg": "#ffffff",
        "family": "system-ui, sans-serif",
    },
    # Scan: a document photographed and pasted into a page.
    "scan": {
        "ink": "#1c1917", "muted": "#78716c", "line": "#d6d3d1",
        "accent": "#7c2d12", "panel": "#faf9f7", "bg": "#f5f5f4",
        "family": "Georgia, 'Times New Roman', serif",
    },
    # Clinical: dense, mono figures, status pills.
    "health": {
        "ink": "#0f172a", "muted": "#64748b", "line": "#e2e8f0",
        "accent": "#0e7490", "panel": "#f0f9ff", "bg": "#ffffff",
        "family": "system-ui, sans-serif",
    },
}

DENSITY = {
    "compact": {"pad": 6, "gap": 6, "lh": 1.3, "sec": 10},
    "normal": {"pad": 9, "gap": 12, "lh": 1.5, "sec": 16},
    "roomy": {"pad": 13, "gap": 20, "lh": 1.7, "sec": 24},
}


def stylesheet(theme: str, density: str, font_px: int) -> str:
    t = THEMES[theme]
    d = DENSITY[density]
    return f"""
    *,*::before,*::after {{ box-sizing: border-box; }}
    body {{
      margin: 0; background: {t['bg']}; color: {t['ink']};
      font: {font_px}px/{d['lh']} {t['family']};
    }}
    a {{ color: {t['accent']}; }}
    header.bar {{
      display: flex; align-items: center; justify-content: space-between;
      gap: 16px; padding: {d['pad'] + 3}px 20px;
      background: {t['panel']}; border-bottom: 2px solid {t['accent']};
    }}
    .brand {{ font-weight: 700; letter-spacing: .01em; }}
    .crumb {{ font-size: {max(11, font_px - 3)}px; color: {t['muted']}; padding: 6px 20px; }}
    main {{ padding: {d['sec']}px 20px; max-width: 1180px; }}
    .cols {{ display: flex; gap: {d['sec']}px; align-items: flex-start; }}
    .cols > .side {{ flex: 0 0 190px; }}
    .cols > .pane {{ flex: 1 1 auto; min-width: 0; }}
    nav.side a {{
      display: block; padding: {d['pad']}px 10px; text-decoration: none;
      color: {t['ink']}; border-left: 3px solid transparent;
    }}
    nav.side a[aria-current] {{ border-left-color: {t['accent']}; background: {t['panel']}; }}
    section {{ margin-bottom: {d['sec']}px; }}
    fieldset {{
      border: 1px solid {t['line']}; border-radius: 4px;
      padding: {d['pad'] + 4}px; margin: 0 0 {d['sec']}px;
    }}
    legend {{
      padding: 0 6px; font-weight: 700; font-size: {max(10, font_px - 3)}px;
      text-transform: uppercase; letter-spacing: .06em; color: {t['muted']};
    }}
    h1 {{ font-size: {font_px + 7}px; margin: 0 0 {d['gap']}px; }}
    h2 {{ font-size: {font_px + 3}px; margin: 0 0 {d['gap']}px; }}
    h3 {{ font-size: {font_px + 1}px; margin: 0 0 6px; }}
    .grid {{ display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: {d['gap']}px; }}
    .grid.three {{ grid-template-columns: repeat(3, minmax(0,1fr)); }}
    .f {{ margin-bottom: {d['gap']}px; }}
    label {{
      display: block; font-size: {max(10, font_px - 2)}px;
      color: {t['muted']}; margin-bottom: 3px;
    }}
    input, select, textarea {{
      width: 100%; padding: {d['pad']}px 9px; border: 1px solid {t['line']};
      border-radius: 3px; font: inherit; background: #fff; color: {t['ink']};
    }}
    input[readonly] {{ background: {t['panel']}; }}
    .hint {{ font-size: {max(10, font_px - 3)}px; color: {t['muted']}; margin-top: 2px; }}
    table {{ width: 100%; border-collapse: collapse; font-size: {max(11, font_px - 1)}px; }}
    th, td {{
      text-align: left; padding: {d['pad']}px 8px; border-bottom: 1px solid {t['line']};
      vertical-align: top;
    }}
    th {{ background: {t['panel']}; font-weight: 600; color: {t['muted']}; }}
    td.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
    dl.kv {{ display: grid; grid-template-columns: max-content 1fr; gap: 4px {d['gap']}px; margin: 0; }}
    dl.kv dt {{ color: {t['muted']}; font-size: {max(10, font_px - 2)}px; }}
    dl.kv dd {{ margin: 0; }}
    .card {{
      border: 1px solid {t['line']}; border-radius: 6px;
      padding: {d['pad'] + 4}px; margin-bottom: {d['gap']}px; background: #fff;
    }}
    .pill {{
      display: inline-block; padding: 1px 8px; border-radius: 10px;
      background: {t['panel']}; color: {t['accent']};
      font-size: {max(10, font_px - 3)}px; border: 1px solid {t['line']};
    }}
    .actions {{ display: flex; gap: 8px; margin-top: {d['gap']}px; flex-wrap: wrap; }}
    button {{
      padding: {d['pad']}px 14px; border: 1px solid {t['line']}; border-radius: 3px;
      background: {t['panel']}; font: inherit; cursor: pointer; color: {t['ink']};
    }}
    button.primary {{ background: {t['accent']}; border-color: {t['accent']}; color: #fff; }}
    .muted {{ color: {t['muted']}; }}
    .mono {{ font-family: 'Cascadia Mono', 'Consolas', monospace; }}
    .scanwrap {{ background: {t['panel']}; padding: {d['sec']}px; border: 1px solid {t['line']}; }}
    .rail {{ flex: 0 0 260px; }}
    footer {{
      padding: {d['sec']}px 20px; color: {t['muted']};
      font-size: {max(10, font_px - 3)}px; border-top: 1px solid {t['line']};
    }}
    """


def document(page: Page) -> str:
    """One page, marked up. `generate.py` strips the marks before shipping it."""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{esc(page.title)}</title>
<style>{stylesheet(page.theme, page.density, page.font_px)}</style>
</head>
<body data-corpus-id="{page.pid}">
{page.body}
</body>
</html>
"""


# -- Small builders ------------------------------------------------------------


def field(label: str, value: str = "", cls: str | None = None, kind: str = "text",
          hint: str = "", extra: str = "", name: str = "") -> str:
    """A labelled control. When `cls` is given, the control itself is the ground truth.

    A field's box is the whole control, not the glyphs inside it: obscuring the control
    is what makes the value unreadable, and the control's rect is the smallest region
    guaranteed to contain the value wherever the browser draws it. That matches what L0
    and L1 report for a field, so IoU here measures the detector rather than a
    disagreement about what a box means.
    """
    mark = f' data-pii="{cls}"' if cls else ""
    nm = f' name="{esc(name)}"' if name else ""
    val = f' value="{esc(value)}"' if value else ""
    hint_html = f'<div class="hint">{hint}</div>' if hint else ""
    return (
        f'<div class="f"><label>{label}</label>'
        f'<input type="{kind}"{nm}{val} {el(extra)}{mark} />{hint_html}</div>'
    )


def neg_field(label: str, text: str, looks_like: str, why: str,
              kind: str = "text", name: str = "", prefix: str = "") -> str:
    """A control whose *value* is a trap: shaped like PII, and not PII.

    Separate from `field(..., value=neg(...))`, which cannot work and quietly did not:
    an input's value is an attribute, so HTML handed to it is escaped and shown as
    literal angle brackets. The mark has to go on the control.
    """
    nm = f' name="{esc(name)}"' if name else ""
    return (
        f'<div class="f"><label>{label}</label>'
        f'<input type="{kind}"{nm} value="{esc(prefix + text)}" {el()} '
        f'data-neg="{looks_like}" data-neg-why="{esc(why)}" /></div>'
    )


def select_field(label: str, options: list[str], selected: int = 0,
                 cls: str | None = None, name: str = "") -> str:
    mark = f' data-pii="{cls}"' if cls else ""
    nm = f' name="{esc(name)}"' if name else ""
    opts = "".join(
        f'<option{" selected" if i == selected else ""}>{esc(o)}</option>'
        for i, o in enumerate(options)
    )
    return (
        f'<div class="f"><label>{label}</label>'
        f'<select{nm} {el()}{mark}>{opts}</select></div>'
    )


def kv(rows: list[tuple[str, str]]) -> str:
    """A read-only key/value block. Values are already marked by the caller."""
    body = "".join(f"<dt>{k}</dt><dd>{v}</dd>" for k, v in rows)
    return f'<dl class="kv">{body}</dl>'


def table(headers: list[str], rows: list[list[str]], numeric: set[int] | None = None) -> str:
    numeric = numeric or set()
    head = "".join(f"<th>{h}</th>" for h in headers)
    body = ""
    for r in rows:
        cells = "".join(
            f'<td class="num">{c}</td>' if i in numeric else f"<td>{c}</td>"
            for i, c in enumerate(r)
        )
        body += f"<tr>{cells}</tr>"
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"


def buttons(*labels: str, primary_last: bool = True) -> str:
    out = []
    for i, lab in enumerate(labels):
        cls = "primary" if primary_last and i == len(labels) - 1 else ""
        out.append(f'<button class="{cls}" {el()}>{esc(lab)}</button>')
    return f'<div class="actions">{"".join(out)}</div>'


def bar(brand: str, right: str = "") -> str:
    return (
        f'<header class="bar"><div class="brand">{esc(brand)}</div>'
        f'<div>{right}</div></header>'
    )


def sidenav(items: list[str], current: int = 0) -> str:
    links = "".join(
        f'<a href="#{i}" {el("aria-current=page" if i == current else "")}>{esc(t)}</a>'
        for i, t in enumerate(items)
    )
    return f'<nav class="side">{links}</nav>'


def pixel_pii(data_uri: str, cls: str, width: int, height: int, alt: str = "") -> str:
    """PII that exists only as pixels.

    `data-pii-pixels` rather than `data-pii`, because these are scored apart. The DOM
    carries nothing to find -- no text node, no value, no attribute -- so L0 and L1
    cannot see them by construction and a miss here is a fact about L3 not existing yet
    rather than a fact about the deterministic layers. Reporting them mixed in with text
    PII would quietly depress a recall number that measures something else.
    """
    return (
        f'<img src="{data_uri}" width="{width}" height="{height}" alt="{esc(alt)}" '
        f'data-pii-pixels="{cls}" />'
    )
