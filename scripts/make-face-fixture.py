"""Pin the TypeScript YuNet decode against the real model's real outputs.

    python scripts/make-face-fixture.py

The unit tests in `face.test.ts` check the arithmetic on synthetic tensors, which is what
catches a transposed walk or the wrong score fusion. They cannot catch a mismatch with the
*actual* graph -- if `cls_8` were laid out `[1,1,6400]` rather than `[1,6400,1]`, or the
heads were ordered differently, every hand-computed test would still pass and the browser
would find nothing.

So: run the bundled model on a fixed synthetic input, decode the outputs here following the
OpenCV `FaceDetectorYN` reference, and write both the raw tensors and the expected boxes to
a fixture the TypeScript test replays. If the two implementations disagree, one of them is
wrong and the diff says where.

The input is deterministic noise rather than a photograph, and the threshold is low. That is
deliberate: this fixture exists to exercise the decode over real tensor layouts with many
candidates and real suppression, not to prove the model finds faces. Whether it finds a face
is a question about a photograph, and it is answered by looking at a sealed frame.

No real person's photograph is used, here or anywhere in this repository.
"""

from __future__ import annotations

import base64
import json
import math
from pathlib import Path

import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / "extension" / "models" / "face-yunet.onnx"
FIXTURE = ROOT / "extension" / "src" / "offscreen" / "tasks" / "face.golden.json"

INPUT = 640
STRIDES = (8, 16, 32)

#: Low on purpose. See the module docstring: this fixture is about the decode, not about
#: whether noise contains a face.
SCORE_THRESHOLD = 0.05
NMS_IOU = 0.3


def synthetic_input() -> np.ndarray:
    """A fixed, boring image. Seeded so the fixture is reproducible byte for byte."""
    rng = np.random.default_rng(20240117)
    image = rng.integers(0, 256, size=(INPUT, INPUT, 3), dtype=np.uint8)
    # NCHW float32, no normalisation -- YuNet takes raw 0-255, which is itself worth
    # pinning: feeding it 0-1 produces confident nonsense rather than an error.
    return image.astype(np.float32).transpose(2, 0, 1)[None, ...]


def iou(a: dict, b: dict) -> float:
    ax2, ay2 = a["x"] + a["w"], a["y"] + a["h"]
    bx2, by2 = b["x"] + b["w"], b["y"] + b["h"]
    ix = max(0.0, min(ax2, bx2) - max(a["x"], b["x"]))
    iy = max(0.0, min(ay2, by2) - max(a["y"], b["y"]))
    inter = ix * iy
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0


def decode(outputs: dict[str, np.ndarray]) -> list[dict]:
    """The OpenCV FaceDetectorYN postprocess, written out.

    cls and obj are each clamped to [0,1] and fused as their geometric mean. bbox is an
    offset on the cell index and a log scale on the stride:

        cx = (col + dx) * s     w = exp(dw) * s
        cy = (row + dy) * s     h = exp(dh) * s
    """
    candidates: list[dict] = []

    for stride in STRIDES:
        cls = outputs[f"cls_{stride}"].reshape(-1)
        obj = outputs[f"obj_{stride}"].reshape(-1)
        bbox = outputs[f"bbox_{stride}"].reshape(-1, 4)
        cols = INPUT // stride

        for i in range(cls.shape[0]):
            score = math.sqrt(min(max(float(cls[i]), 0.0), 1.0) * min(max(float(obj[i]), 0.0), 1.0))
            if score < SCORE_THRESHOLD:
                continue

            col, row = i % cols, i // cols
            cx = (col + float(bbox[i, 0])) * stride
            cy = (row + float(bbox[i, 1])) * stride
            w = math.exp(float(bbox[i, 2])) * stride
            h = math.exp(float(bbox[i, 3])) * stride
            candidates.append(
                {"box": {"x": cx - w / 2, "y": cy - h / 2, "w": w, "h": h}, "score": score}
            )

    kept: list[dict] = []
    for candidate in sorted(candidates, key=lambda c: -c["score"]):
        if any(iou(k["box"], candidate["box"]) > NMS_IOU for k in kept):
            continue
        kept.append(candidate)
    return kept


def main() -> None:
    if not MODEL.exists():
        raise SystemExit(f"{MODEL} is missing. Run `python scripts/fetch-models.py`.")

    session = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    names = [o.name for o in session.get_outputs()]
    raw = session.run(names, {session.get_inputs()[0].name: synthetic_input()})
    outputs = dict(zip(names, raw))

    expected = decode(outputs)
    print(f"{len(expected)} detection(s) above {SCORE_THRESHOLD} after NMS")

    # Only the three heads the decode reads. The keypoints are 10 floats per cell and this
    # layer does not use them -- a face is a region to blur, and where its eyes are is not
    # this project's business.
    # Base64 little-endian float32 rather than a JSON array of numbers. The same 50,400
    # values are 1.1 MB as decimal text and 269 KB this way, and exact either way -- a
    # rounded fixture would pin the decode to a rounding rather than to the model.
    tensors = {
        name: {
            "dims": list(outputs[name].shape),
            "f32": base64.b64encode(
                np.ascontiguousarray(outputs[name], dtype="<f4").tobytes()
            ).decode("ascii"),
        }
        for stride in STRIDES
        for name in (f"cls_{stride}", f"obj_{stride}", f"bbox_{stride}")
    }

    FIXTURE.write_text(
        json.dumps(
            {
                "_comment": (
                    "Real outputs of extension/models/face-yunet.onnx on a seeded synthetic "
                    "input, with the boxes the OpenCV FaceDetectorYN postprocess produces "
                    "from them. Written by scripts/make-face-fixture.py; replayed by "
                    "face.test.ts so the TypeScript decode is pinned to the real graph's "
                    "tensor layout, not only to hand arithmetic."
                ),
                "input": INPUT,
                "scoreThreshold": SCORE_THRESHOLD,
                "nmsIou": NMS_IOU,
                "expected": expected,
                "tensors": tensors,
            }
        ),
        encoding="utf-8",
    )
    size = FIXTURE.stat().st_size
    print(f"wrote {FIXTURE} ({size:,} bytes)")


if __name__ == "__main__":
    main()
