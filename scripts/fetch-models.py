"""Fetch the weights a fresh clone does not have, and verify every one.

    python scripts/fetch-models.py            # fetch what is missing or wrong
    python scripts/fetch-models.py --check    # verify only, fetch nothing

## Why this exists

`.gitignore` excludes `extension/models/*.onnx`, because GitHub refuses raw files over
100 MB and `ner.onnx` is 111 MB. Four of the five weights predate that rule and are
tracked; `ner.onnx` is not. So a fresh clone gets *some* of the models, builds a bundle
that looks complete, and fails in the offscreen document at runtime -- several layers away
from the cause, on the machine of whoever cloned it, usually the day of the demo.

`extension/build.mjs` now refuses to build in that state, by name. This is the other half:
the way out of it.

## Offline is the point

CLAUDE.md invariant 4: nothing is fetched at *run* time. This is setup, not runtime, and
it is the only network access in the project outside the planner call. On a machine that
has already been set up it does nothing; on a disconnected one it fails with the digest and
the filename so the file can be carried in on a USB stick, which is exactly what
demo/OFFLINE-CHECKLIST.md asks for.

Every download is verified against `manifest.json` before it is kept. A weight that arrives
with the wrong digest is deleted rather than used: the failure mode that costs most is not
a missing model, it is a *different* model, which loads, runs, produces plausible output
and quietly invalidates every number in the report.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "extension" / "models"
MANIFEST = MODELS / "manifest.json"

#: Where a missing weight can be fetched from.
#:
#: Only files that cannot be committed need an entry. The rest are in the repository, and a
#: URL for them would be a second source of truth for a file git already has.
#:
#: `ner.onnx` has no entry on purpose. It is not a stock checkpoint -- it is
#: onnx-community/multilang-pii-ner-ONNX with its vocabulary pruned from 250,002 tokens to
#: 32,000 by scripts/prune-ner-vocab.py, which is what takes it from 279 MB to 111 MB. A URL
#: would have to point at an artefact we host, and pointing this script at a bucket nobody
#: has provisioned would be worse than saying plainly how to rebuild it.
SOURCES: dict[str, str] = {
    "face-yunet.onnx": "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "ocr-det.onnx": "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx",
    "ocr-rec.onnx": "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx",
}

REBUILD = {
    "ner.onnx": (
        "not downloadable: this is a pruned checkpoint, not a stock one. Rebuild it with\n"
        "    python scripts/prune-ner-vocab.py <model_int8.onnx> <tokenizer.json> "
        "extension/models\n"
        "from onnx-community/multilang-pii-ner-ONNX (MIT), or copy the file from a machine "
        "that already has it -- the digest below is what makes either safe."
    ),
    "ner-tokenizer.json": (
        "not downloadable: renumbered alongside ner.onnx by scripts/prune-ner-vocab.py. "
        "The ids in a stock tokenizer point at the wrong embedding rows in the pruned "
        "model, which produces plausible nonsense rather than an error."
    ),
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(name: str, entry: dict) -> str | None:
    """None when the file is right, otherwise what is wrong with it."""
    path = MODELS / name
    if not path.exists():
        return "missing"
    size = path.stat().st_size
    if size != entry["bytes"]:
        return f"{size:,} bytes, expected {entry['bytes']:,}"
    if digest(path) != entry["sha256"]:
        return "sha256 mismatch"
    return None


def fetch(name: str, entry: dict) -> bool:
    url = SOURCES.get(name)
    if not url:
        print(f"  {name}: {REBUILD.get(name, 'no source recorded and no rebuild recipe')}")
        return False

    target = MODELS / name
    print(f"  {name}: fetching {entry['bytes']:,} bytes from {url}")
    try:
        with urllib.request.urlopen(url, timeout=120) as reply:
            target.write_bytes(reply.read())
    except (urllib.error.URLError, OSError) as err:
        print(f"  {name}: download failed -- {err}")
        return False

    problem = verify(name, entry)
    if problem:
        # Deleted rather than kept. A weight that is not the one measured is worse than no
        # weight, because it works.
        target.unlink(missing_ok=True)
        print(f"  {name}: {problem} -- discarded")
        return False

    print(f"  {name}: ok")
    return True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify only; fetch nothing")
    args = ap.parse_args()

    if not MANIFEST.exists():
        raise SystemExit(f"{MANIFEST} is missing. Run `python scripts/hash-models.py`.")

    files = json.loads(MANIFEST.read_text(encoding="utf-8"))["files"]
    outstanding: list[str] = []

    for name, entry in files.items():
        problem = verify(name, entry)
        if problem is None:
            print(f"  {name:24s} ok    {entry['licence']}")
            continue

        print(f"  {name:24s} {problem}")
        if args.check or not fetch(name, entry):
            outstanding.append(name)

    if outstanding:
        print(f"\n{len(outstanding)} weight(s) still wrong: {', '.join(outstanding)}")
        print("The build will refuse until they are right, which is the intended behaviour.")
        sys.exit(1)

    print("\nevery weight present and verified")


if __name__ == "__main__":
    main()
