"""The eval build, and exactly one reason it differs from the shipped one.

`chrome.tabs.captureVisibleTab` requires either `activeTab` or `<all_urls>`. Nothing
else substitutes -- not a host permission for the page in question, however specific.
The first browser load session established that the hard way (demo/LOAD-SESSION.md), and
this harness re-established it: with the shipped manifest, `captureVisibleTab` refuses
with

    Either the '<all_urls>' or 'activeTab' permission is required.

`activeTab` is granted when the *user invokes* the extension -- clicks the toolbar
action -- and is revoked when the tab navigates. That is the right permission for the
product: it is what lets the extension answer "what can this see?" with "the tab you
pointed it at, while you are pointing at it". It is also unreachable from a harness.
`chrome.action.openPopup()` called over CDP does not grant it; that was measured, not
assumed, and neither does opening the popup page, nor a programmatic RUN_TASK.

So the harness builds a variant whose only difference is the permission that decides
*who may ask* for a screenshot. It does not change what the screenshot is, what the
walker sees, what the detectors find, what the gate paints, what the manifest says, or
how long any stage takes. Every number M11 reports is computed downstream of this and is
unaffected by it -- but the report says so in the open rather than leaving a reader to
discover a modified manifest.

Two guards, because an eval build must never be mistaken for a shipping one:

  - the variant carries `x_sih_eval_build`, and the harness refuses to run against a
    directory that does not have it, so a run cannot silently be scored against a
    manifest nobody patched;
  - the name is suffixed, so a browser with both loaded says which is which.

The variant is generated from `dist/chrome` on every run and is disposable. It is not
committed.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

MARKER = "x_sih_eval_build"


def make_eval_build(dist: Path, out: Path) -> Path:
    """Copy the shipped build and widen exactly one permission."""
    if not (dist / "manifest.json").exists():
        raise SystemExit(
            f"{dist} is not a build. Run `npm run build` first -- the harness scores the "
            "bundle, not the sources, and a stale bundle is a silently wrong report."
        )

    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(dist, out)

    path = out / "manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))

    shipped = list(manifest.get("host_permissions", []))
    manifest["host_permissions"] = ["<all_urls>"]
    manifest["name"] = f"{manifest.get('name', 'Redaction Gate')} (eval)"
    manifest[MARKER] = {
        "why": (
            "captureVisibleTab needs activeTab or <all_urls>, and activeTab is only "
            "granted by a real toolbar click, which a harness cannot perform."
        ),
        "shippedHostPermissions": shipped,
        "changedOnly": ["host_permissions", "name"],
    }
    path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return out


def describe(build: Path) -> dict:
    """What the report says about the build it measured."""
    manifest = json.loads((build / "manifest.json").read_text(encoding="utf-8"))
    if MARKER not in manifest:
        raise SystemExit(
            f"{build} was not produced by make_eval_build. The harness will not score a "
            "build it cannot describe."
        )
    note = manifest[MARKER]
    return {
        "path": str(build),
        "version": manifest.get("version"),
        "isEvalVariant": True,
        "shippedHostPermissions": note["shippedHostPermissions"],
        "evalHostPermissions": manifest["host_permissions"],
        "differenceFromShipped": note["why"],
        "affectsMetrics": (
            "No. The permission decides who may request a screenshot, not what the "
            "screenshot contains, what the walker indexes, what the detectors find, "
            "what the gate paints, or how long any stage takes."
        ),
    }
