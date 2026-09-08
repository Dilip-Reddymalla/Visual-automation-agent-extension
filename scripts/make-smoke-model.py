#!/usr/bin/env python3
"""Generate extension/models/smoke.onnx -- the backend probe model.

This is not a perception model. It exists so M2 can answer the question the whole
project is gated on ("does WebGPU inference run inside an MV3 offscreen document on the
demo machine?") in one forward pass, on every machine, before any real weights exist.

Shape: input [1, 8] float32 -> MatMul with a bundled [8, 8] initializer -> Add bias
-> Relu -> output [1, 8]. Three ops, 288 bytes of weights: small enough to load
instantly, real enough that a broken GPU backend fails rather than silently passing.

Weights are deterministic (seeded), so the expected output is a fixture the extension
can assert against -- a backend that runs but computes garbage is a failure this
catches. Run with: python scripts/make-smoke-model.py
"""

from __future__ import annotations

import json
import pathlib

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

DIM = 8
OUT = pathlib.Path(__file__).resolve().parent.parent / 'extension' / 'models'


def build() -> onnx.ModelProto:
    rng = np.random.default_rng(26171)  # the problem statement number, for luck
    weight = np.round(rng.standard_normal((DIM, DIM)).astype(np.float32), 3)
    bias = np.round(rng.standard_normal(DIM).astype(np.float32), 3)

    graph = helper.make_graph(
        nodes=[
            helper.make_node('MatMul', ['input', 'weight'], ['matmul_out']),
            helper.make_node('Add', ['matmul_out', 'bias'], ['add_out']),
            helper.make_node('Relu', ['add_out'], ['output']),
        ],
        name='smoke',
        inputs=[helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, DIM])],
        outputs=[helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, DIM])],
        initializer=[
            numpy_helper.from_array(weight, 'weight'),
            numpy_helper.from_array(bias, 'bias'),
        ],
    )

    model = helper.make_model(
        graph,
        producer_name='sih26171-redaction-gate',
        # Opset 13 covers MatMul/Add/Relu everywhere and keeps the WebGPU EP happy.
        opset_imports=[helper.make_opsetid('', 13)],
    )
    model.ir_version = 9  # ORT 1.20+ rejects nothing below 10; 9 is the safe floor.
    onnx.checker.check_model(model)
    return model


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    model = build()
    path = OUT / 'smoke.onnx'
    onnx.save(model, path)

    # Run it here, so the fixture the extension asserts against is measured, not guessed.
    import onnxruntime as ort

    session = ort.InferenceSession(str(path), providers=['CPUExecutionProvider'])
    probe = np.arange(1, DIM + 1, dtype=np.float32).reshape(1, DIM) / DIM
    result = session.run(['output'], {'input': probe})[0]

    fixture = {
        'model': 'smoke.onnx',
        'bytes': path.stat().st_size,
        'input': {'name': 'input', 'dims': [1, DIM], 'data': probe.ravel().tolist()},
        'output': {
            'name': 'output',
            'dims': list(result.shape),
            'data': [round(float(v), 6) for v in result.ravel().tolist()],
        },
    }
    (OUT / 'smoke.fixture.json').write_text(json.dumps(fixture, indent=2) + '\n')

    print(f'wrote {path} ({fixture["bytes"]} bytes)')
    print(f'  {fixture["input"]["dims"]} -> {fixture["output"]["dims"]}')
    print(f'  output: {fixture["output"]["data"]}')


if __name__ == '__main__':
    main()
