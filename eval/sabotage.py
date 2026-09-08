"""Break a detector on purpose and check the harness notices.

A metric nobody has seen move is a metric nobody should trust. This is the control
experiment for the whole report: disable one checksum, re-run, and confirm the precision
number gets visibly worse in the direction and roughly the magnitude you would predict.

    python eval/sabotage.py

It edits `extension/src/redaction/validators.ts` in place, rebuilds, runs a subset,
scores it, and puts the file back -- in a `finally`, so an interrupted run does not leave
a sabotaged validator in the tree. It refuses to start if the file is already dirty,
because restoring over someone's uncommitted work would be worse than not running.

Three sabotages. What they do has changed once already, and the change is the evidence.

**Before M3b**, when perception admitted only interactive elements, two of the three moved
nothing at all. Disabling Verhoeff: nothing. Disabling the disqualifying-caption rule:
nothing. Both were dead for one reason -- every Aadhaar-shaped decoy in the corpus sits in
page prose, and prose was never scanned, so no change to how L1 *judges* text could alter
a false-positive count when L1 never saw the text.

**After M3b**, with text-bearing elements admitted, all three move:

| sabotage | AADHAAR false positives | micro precision | decoys surviving |
|---|---|---|---|
| healthy | 10 | 0.669 | 0.874 |
| Verhoeff disabled | 19 | 0.629 | 0.790 |
| Verhoeff always fails | 4 | 0.639 | 0.937 |
| caption rule disabled | 34 | 0.577 | 0.621 |

A control that gains sensitivity exactly where a gap was closed is better evidence the fix
worked than any recall number, because it could not have been produced by tuning. The
detectors were not touched; what changed is that they are now shown the text.

Read the middle row carefully: making every Aadhaar invalid *raises* decoy survival to
0.937, because a detector that finds nothing also accuses nothing. Precision and recall
have to be read together, which is why this prints both.
"""

from __future__ import annotations

import io
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
ROOT = HERE.parent
VALIDATORS = ROOT / "extension" / "src" / "redaction" / "validators.ts"

#: The subset. Every page whose labels mention AADHAAR, so the sabotage has something to
#: bite on and the run stays short enough to be worth doing twice.
def aadhaar_pages() -> list[str]:
    corpus = json.loads((HERE / "corpus" / "corpus.json").read_text(encoding="utf-8"))
    out = []
    for page in corpus["pages"]:
        labels = json.loads((HERE / "corpus" / page["labels"]).read_text(encoding="utf-8"))
        classes = {s["cls"] for s in labels["spans"]}
        traps = {n["looksLike"] for n in labels["negatives"]}
        if "AADHAAR" in classes or "AADHAAR" in traps:
            out.append(page["id"])
    return out


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write(path: Path, text: str) -> None:
    """Write back byte-for-byte, newlines included.

    `Path.write_text` translates to the platform ending, so restoring a file on Windows
    rewrote every line of a source that had not changed. Harmless to the build and very
    noisy in `git status`, which is exactly where someone checks that the sabotage was
    undone.
    """
    with io.open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=ROOT, check=True, capture_output=True, text=True, **kw)


#: Each sabotage is (name, anchor, replacement, what it should prove).
SABOTAGES = [
    (
        "verhoeff-disabled",
        "export function isAadhaarValid(value: string): boolean {",
        "export function isAadhaarValid(value: string): boolean {\n"
        "  if (/^\\d{12}$/.test(value.replace(/[\\s-]/g, ''))) return true;",
        "L1 accepts any twelve digits as an Aadhaar",
    ),
    (
        "verhoeff-always-fails",
        "export function isAadhaarValid(value: string): boolean {",
        "export function isAadhaarValid(value: string): boolean {\n"
        "  return false;",
        "no Aadhaar is ever valid, so every true positive must vanish",
    ),
    (
        "negative-context-disabled",
        "      if (pattern.labelCanDisqualify && NEGATIVE_CONTEXT.test(before)) continue;",
        "      // SABOTAGE: the disqualifying caption no longer disqualifies.",
        "a value captioned 'Invoice no.' is no longer excluded",
    ),
]

#: Which file each sabotage edits.
TARGET_FILE = {
    "verhoeff-disabled": VALIDATORS,
    "verhoeff-always-fails": VALIDATORS,
    "negative-context-disabled": ROOT / "extension" / "src" / "redaction" / "l1-lexical.ts",
}


def measure(pages: list[str], run_dir: Path, label: str) -> dict:
    print(f"\n=== {label} ===")
    run(["npm", "run", "build"], shell=(sys.platform == "win32"))
    subprocess.run(
        [sys.executable, str(HERE / "harness.py"), "--only", *pages, "--run-dir", str(run_dir)],
        cwd=ROOT, check=True,
    )
    return json.loads((HERE / "report" / "report.json").read_text(encoding="utf-8"))


def summarise(result: dict) -> dict:
    high = result["operatingPoints"]["highPrecision"]
    per_class = high["pii"]["byClass"].get("AADHAAR", {})
    return {
        "precision": high["pii"]["micro"]["precision"],
        "recall": high["pii"]["micro"]["recall"],
        "aadhaarFp": per_class.get("fp", 0),
        "aadhaarTp": per_class.get("tp", 0),
        "trapSurvival": high["hardNegatives"]["survivalRate"],
        "trapFp": high["hardNegatives"]["falsePositives"],
    }


def main() -> None:
    files = sorted({str(p) for p in TARGET_FILE.values()})
    dirty = subprocess.run(
        ["git", "status", "--porcelain", *files],
        cwd=ROOT, capture_output=True, text=True,
    ).stdout.strip()
    if dirty:
        raise SystemExit(
            "the detector sources have uncommitted changes. This script restores them "
            f"from its own copies and would discard yours -- commit or stash first.\n{dirty}"
        )

    pages = aadhaar_pages()
    print(f"{len(pages)} page(s) carry an Aadhaar or an Aadhaar-shaped decoy")

    healthy = summarise(measure(pages, HERE / "report" / "runs-healthy", "healthy"))
    results = {"healthy": healthy, "pages": pages, "sabotages": {}}

    for name, anchor, replacement, claim in SABOTAGES:
        path = TARGET_FILE[name]
        original = read(path)
        try:
            broken = original.replace(anchor, replacement, 1)
            if broken == original:
                raise SystemExit(f"{name}: anchor not found in {path.name} -- has it moved?")
            write(path, broken)
            got = summarise(measure(pages, HERE / "report" / f"runs-{name}", name))
        finally:
            write(path, original)
            print(f"  restored {path.name}")
        results["sabotages"][name] = {"claim": claim, **got}

    print("\n" + "=" * 74)
    print("Control experiment: break a detector, watch the numbers")
    print("=" * 74)

    rows = [
        ("micro precision", "precision"),
        ("micro recall", "recall"),
        ("AADHAAR false positives", "aadhaarFp"),
        ("AADHAAR true positives", "aadhaarTp"),
        ("hard negatives redacted", "trapFp"),
        ("hard negative survival", "trapSurvival"),
    ]
    names = list(results["sabotages"])
    header = f"  {'':26s} {'healthy':>10s}" + "".join(f"{n[:18]:>20s}" for n in names)
    print(header)
    for label, key in rows:
        line = f"  {label:26s} {healthy[key]:>10.4f}"
        for n in names:
            line += f"{results['sabotages'][n][key]:>20.4f}"
        print(line)

    # Sensitivity in either direction. A sabotage that destroys recall proves the
    # harness measures detection just as well as one that destroys precision -- and on
    # this corpus it is the only direction available, for the reason in the note below.
    def differs(n: str) -> bool:
        got = results["sabotages"][n]
        return any(
            abs(got[k] - healthy[k]) > 1e-9
            for k in ("precision", "recall", "aadhaarFp", "aadhaarTp", "trapFp", "trapSurvival")
        )

    moved = [n for n in names if differs(n)]
    unmoved = [n for n in names if n not in moved]

    print()
    for n in moved:
        print(f"  MOVED    {n}: {results['sabotages'][n]['claim']}")
    for n in unmoved:
        print(f"  UNMOVED  {n}: {results['sabotages'][n]['claim']}")

    (HERE / "report" / "sabotage.json").write_text(
        json.dumps(results, indent=2), encoding="utf-8"
    )

    print()
    if moved:
        print("  PASS -- at least one broken detector made the numbers visibly worse, so")
        print("          the harness is measuring detection and not something correlated")
        print("          with it. An unmoved sabotage is a fact about the detector, not a")
        print("          fault in the harness -- see the note at the top of this file.")
    else:
        print("  FAIL -- no sabotage moved anything. The harness is not measuring what it")
        print("          claims to measure.")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
