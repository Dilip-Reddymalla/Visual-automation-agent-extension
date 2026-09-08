"""Rewrite extension/models/manifest.json from the weights on disk.

    python scripts/hash-models.py

The manifest is what `extension/build.mjs` checks before it will produce a bundle: every
weight present, the right size, the right digest. Run this when a weight changes *on
purpose* -- a re-export, a re-prune -- and never to make a failing build pass, because the
failure is the point.

A digest rather than mere existence, because the expensive failure is not a missing file.
A missing file stops the build. A model re-exported with different settings loads, runs,
produces plausible output, and quietly invalidates every number in the report.

Licence and provenance are carried per file and preserved across regeneration: CLAUDE.md
invariant 3 allows MIT and Apache-2.0 weights only, and a licence recorded beside the
digest is a licence somebody can check without going looking.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "extension" / "models"
MANIFEST = MODELS / "manifest.json"

COMMENT = (
    "Every weight the extension loads, with the digest the build checks. Written by "
    "scripts/hash-models.py; verified by extension/build.mjs, which fails by name "
    "rather than shipping a bundle whose model is absent or is not the one measured."
)


def main() -> None:
    if not MANIFEST.exists():
        raise SystemExit(
            f"{MANIFEST} does not exist. This script updates the record; it does not "
            "invent one, because the licence and provenance of a weight are not "
            "derivable from its bytes."
        )

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    files = manifest.get("files", {})

    for name, entry in files.items():
        path = MODELS / name
        if not path.exists():
            print(f"  {name:24s} MISSING -- left in the manifest so the build says so")
            continue

        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        changed = entry.get("sha256") != digest
        entry["bytes"] = len(data)
        entry["sha256"] = digest
        print(f"  {name:24s} {len(data):>12,} bytes  {digest[:16]}...{'  CHANGED' if changed else ''}")

    manifest["_comment"] = COMMENT
    manifest["files"] = files
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"\nwrote {MANIFEST}")


if __name__ == "__main__":
    main()
