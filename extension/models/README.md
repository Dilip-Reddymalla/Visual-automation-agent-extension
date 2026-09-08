# Bundled model weights

Everything the extension infers with lives here and is loaded through
`chrome.runtime.getURL` (CLAUDE.md invariant 4). The extension makes exactly one network
request: the sanitized POST.

Licence gate (invariant 3): MIT and Apache-2.0 only. ISRO requires offline
deployability, so an AGPL weight is not a licence question we get to argue later.
Specifically excluded: Ultralytics YOLOv8 weights, OmniParser v2 icon detector.

| file | task | licence | bytes | sha256 (first 16) |
|---|---|---|---|---|
| `smoke.onnx` + `smoke.fixture.json` | backend probe | MIT (ours) | 512 | `06001a33a215e478` |
| `face-yunet.onnx` | L3 faces | **MIT** | 232,589 | `8f2383e4dd3cfbb4` |
| `ocr-det.onnx` | L3 text detection | **Apache-2.0** | 4,745,517 | `d2a7720d45a54257` |
| `ocr-rec.onnx` | L3 text recognition | **Apache-2.0** | 10,857,958 | `48fc40f24f6d2a20` |
| `ocr-charset.txt` | CTC charset, 6,623 symbols | **Apache-2.0** | 26,250 | `a1c84d9bdb9ab290` |
| NER weights | L2 named entities | **not chosen -- see below** | -- | -- |

Total bundled today: about 15.9 MB. `build.mjs` copies this directory verbatim into
both dist targets, alongside `dist/*/ort/`, which holds ONNX Runtime's wasm binaries
(MIT, from `onnxruntime-web`).

## Provenance, and why these

**Face: YuNet** (`face_detection_yunet_2023mar.onnx`), from
[opencv_zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet).
That directory carries its own MIT LICENSE file, checked at source rather than inferred
from the repository root, which is Apache-2.0. Opset 11, input `[1,3,640,640]`, twelve
outputs -- `cls`, `obj`, `bbox` and `kps` at strides 8, 16 and 32. Postprocessing is
anchor decode plus non-maximum suppression.

**OCR: PP-OCRv4** detection and recognition, from
[SWHL/RapidOCR](https://huggingface.co/SWHL/RapidOCR) (Apache-2.0), which packages
PaddleOCR (also Apache-2.0) as ONNX. Detection outputs a single-channel probability map
for differentiable-binarization postprocessing; recognition outputs CTC logits over
6,625 symbols, which is `ocr-charset.txt` (6,623 lines) plus the CTC blank and a space.
The charset is PaddleOCR's `ppocr_keys_v1.txt`.

Both replaced the originally-specified Florence-2 and MediaPipe BlazeFace. Each of those
brings its own runtime and creates its own ORT sessions, which `sessions.ts` cannot
unload and `timings.ts` cannot see -- breaking the two invariants that carry the 20
percent resource metric, inside the module that decides it.

## The NER model is not chosen, and that is a decision for the team

No model is bundled for L2. Every candidate fails at least one of three requirements:
MIT or Apache-2.0, not access-gated, and covers Indian languages.

| model | licence | gated | languages | note |
|---|---|---|---|---|
| `ai4bharat/IndicNER` | **MIT** | **yes** | 11 Indic | Best fit. Needs a Hugging Face account to accept terms and download. |
| `Davlan/distilbert-base-multilingual-cased-ner-hrl` | **AFL-3.0** | no | 10 | Permissive and OSI-approved, but outside the stated allowlist. |
| `Davlan/bert-base-multilingual-cased-ner-hrl` | AFL-3.0 | no | 10 | As above, and larger. |
| `Babelscape/wikineural-multilingual-ner` | CC-BY-NC-SA-4.0 | no | 10 | Non-commercial. Fails outright. |
| `elastic/distilbert-base-cased-finetuned-conll03-english` | **Apache-2.0** | no | English | Clean licence, wrong languages. |
| `dslim/bert-base-NER` | **MIT** | no | English | Clean licence, wrong languages. |

A scan of the hundred most-downloaded token-classification models on Hugging Face found
no ungated, permissively-licensed, multilingual NER model. Three ways forward:

1. **IndicNER, accepted manually.** Someone with a Hugging Face account accepts the terms
   once, downloads it, and commits the weights here. The gate is an acquisition step, not
   a runtime dependency: once bundled, the extension is still entirely offline. This is
   the recommendation -- MIT, and built for exactly these languages.
2. **Widen the allowlist to AFL-3.0** and take the Davlan model. AFL-3.0 is permissive and
   not copyleft, but invariant 3 says MIT and Apache-2.0, and changing an invariant is a
   decision to take deliberately rather than in passing.
3. **English-only for now.** Clean licence, immediately available, and visibly wrong for a
   deployment whose forms are in Hindi.

### The bundle budget

Whatever is chosen has to fit a budget stated now rather than discovered later:

- Bundled today: about 15.9 MB.
- NER, int8: **45 MB budget**. A distil-class encoder quantises to roughly 40 MB; an
  XLM-R base is about 110 MB and would nearly triple the extension on its own.
- Whole extension, including ONNX Runtime's wasm binaries: **under 100 MB**.

Record the measured size here when the model lands, not the advertised one.

## Regenerating

`smoke.onnx` comes from `python scripts/make-smoke-model.py`. The other weights are
downloaded rather than generated; the links above are the provenance. Check the sha256
prefixes in the table after any re-download.
