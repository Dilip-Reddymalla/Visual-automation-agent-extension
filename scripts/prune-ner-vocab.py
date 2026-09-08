"""Cut the NER model's vocabulary down to the languages this project ships.

    python scripts/prune-ner-vocab.py <model_int8.onnx> <tokenizer.json> <out-dir>

XLM-R carries 250,002 sentencepiece tokens so that one checkpoint can serve a hundred
languages. Its word-embedding matrix is 250002 x 768 uint8 -- **192 MB of a 265 MB
model**, and 94% of an extension bundle that also has to hold OCR and face detection.

Nearly all of it is dead weight here. The corpus is Indian government and financial
pages: Latin script, Devanagari, digits, punctuation. Tokens made of Thai, Hangul, CJK,
Cyrillic, Arabic, Greek or Hebrew characters cannot appear, and their embedding rows are
never gathered.

So: keep the specials, keep everything whose characters are in the shipped scripts, cap
by unigram score, and slice the matrix. The output layer is over 35 labels rather than
the vocabulary, so nothing else in the graph depends on the vocabulary size.

Two things make this safe to do at all:

  The embedding is quantised **per tensor**, not per row -- one scale, one zero point for
  all 250,002 rows (checked, and asserted below). Slicing rows therefore cannot change
  what the surviving rows dequantise to. If that ever became per-row this script would
  have to slice the scale alongside, and it refuses to run rather than guess.

  The `unk` token stays, so a token that was pruned degrades to `<unk>` rather than
  producing an out-of-range gather. A Devanagari page still tokenises; a Korean one
  tokenises badly, which is the honest consequence of not shipping Korean.
"""

from __future__ import annotations

import hashlib
import json
import sys
import unicodedata
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper

#: What the extension ships for. Anything outside these scripts cannot appear on a page
#: this project claims to handle, so its embedding rows are dead weight.
KEPT_SCRIPTS = ("LATIN", "DEVANAGARI")

#: Ceiling on the pruned vocabulary. Not a hard requirement -- the script filter usually
#: lands near this on its own -- but a bound stops a future tokenizer from quietly
#: reintroducing the problem this script exists to solve.
MAX_TOKENS = 32_000

EMBEDDING = "roberta.embeddings.word_embeddings.weight_quantized"
SCALE = "roberta.embeddings.word_embeddings.weight_scale"
ZERO_POINT = "roberta.embeddings.word_embeddings.weight_zero_point"


def script_of(ch: str) -> str:
    """Which script a character belongs to, coarsely."""
    if ch.isascii():
        return "LATIN"
    if not ch.isalpha():
        # Punctuation and marks are shared across scripts and cost nothing to keep.
        return "COMMON"
    try:
        name = unicodedata.name(ch)
    except ValueError:
        return "OTHER"
    return name.split(" ")[0]


def keeps(token: str) -> bool:
    """True when every character of the token is in a script we ship."""
    body = token.lstrip("▁")  # the metaspace marker is not a character of the word
    if not body:
        return True
    return all(script_of(ch) in KEPT_SCRIPTS or script_of(ch) == "COMMON" for ch in body)


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit(__doc__.strip().splitlines()[2].strip())

    model_path, tokenizer_path, out_dir = (Path(a) for a in sys.argv[1:])
    out_dir.mkdir(parents=True, exist_ok=True)

    tokenizer = json.loads(tokenizer_path.read_text(encoding="utf-8"))
    if tokenizer["model"]["type"] != "Unigram":
        raise SystemExit(f"expected a Unigram tokenizer, found {tokenizer['model']['type']}")

    vocab = tokenizer["model"]["vocab"]
    unk_id = tokenizer["model"].get("unk_id", 3)

    # Specials first and in their original order: the model was trained with <s> at 0 and
    # the graph has no idea we renumbered anything, so those four must not move.
    specials = list(range(4))
    candidates = [
        (i, token, score)
        for i, (token, score) in enumerate(vocab)
        if i not in specials and keeps(token)
    ]
    candidates.sort(key=lambda row: -row[2])
    kept_ids = specials + [i for i, _, _ in candidates[: MAX_TOKENS - len(specials)]]
    kept_ids.sort()

    print(f"vocabulary  {len(vocab):,} -> {len(kept_ids):,}")

    model = onnx.load(str(model_path))
    initialisers = {t.name: t for t in model.graph.initializer}

    scale = numpy_helper.to_array(initialisers[SCALE])
    zero = numpy_helper.to_array(initialisers[ZERO_POINT])
    if scale.size != 1 or zero.size != 1:
        raise SystemExit(
            "the embedding is quantised per row, not per tensor: slicing rows would need "
            "the scale sliced with them. Refusing to guess."
        )

    weights = numpy_helper.to_array(initialisers[EMBEDDING])
    before = weights.nbytes
    pruned = np.ascontiguousarray(weights[kept_ids])
    print(f"embedding   {before / 1e6:.1f} MB -> {pruned.nbytes / 1e6:.1f} MB")

    initialisers[EMBEDDING].CopyFrom(numpy_helper.from_array(pruned, EMBEDDING))

    out_model = out_dir / "ner.onnx"
    onnx.save(model, str(out_model))

    # The tokenizer has to be renumbered to match, or every id past the first gap points
    # at the wrong row -- which produces plausible nonsense rather than an error.
    tokenizer["model"]["vocab"] = [vocab[i] for i in kept_ids]
    tokenizer["model"]["unk_id"] = kept_ids.index(unk_id)
    for entry in tokenizer.get("added_tokens", []):
        if entry["id"] in kept_ids:
            entry["id"] = kept_ids.index(entry["id"])

    out_tokenizer = out_dir / "ner-tokenizer.json"
    out_tokenizer.write_text(json.dumps(tokenizer, ensure_ascii=False), encoding="utf-8")

    for path in (out_model, out_tokenizer):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        print(f"{path.name:20s} {path.stat().st_size:>12,} bytes  sha256 {digest}")

    print(f"model       {model_path.stat().st_size / 1e6:.1f} MB -> "
          f"{out_model.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
