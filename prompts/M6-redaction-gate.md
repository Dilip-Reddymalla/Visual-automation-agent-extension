# Prompt M6 — The redaction gate

> Depends on: M4, M5. Owner: Privacy. Estimate: ~17 h.
> Owns 20% of the evaluation. This module is the project's central idea.

---

Read `CLAUDE.md`. You are implementing M6, the gate: the mechanism that makes the privacy
property _structural_ rather than a promise about programmer discipline.

Weak claim, which every team will make: _we redact PII before sending._
Strong claim, which this module buys: _the encoder that produces the outbound payload is
physically incapable of reading the unredacted buffer._

## What to build

### `redaction/policy.ts` — the per-class operation table

Not everything should be a black box. Choosing well is what "precision of redaction" means.

| Class                                                                       | Operation                                   | Padding | Server sees            |
| --------------------------------------------------------------------------- | ------------------------------------------- | ------- | ---------------------- |
| `password`, `secret` (OTP)                                                  | opaque box, **no rehydratable placeholder** | 4%      | `«SECRET»`, unnumbered |
| `aadhaar`, `pan`, `card`, `account`, `passport`, `licence`, `gstin`, `ifsc` | opaque box                                  | 4%      | `«AADHAAR_1»`          |
| `person`, `address`, `org`                                                  | placeholder in text, box on pixels          | 6%      | `«PERSON_1»`           |
| `email`, `phone`, `dob`, `upi`                                              | placeholder, box on pixels                  | 6%      | `«EMAIL_2»`            |
| `face`                                                                      | Gaussian blur, wide kernel                  | 12%     | a blurred region       |
| `signature`                                                                 | opaque box                                  | 8%      | a filled region        |

Blur preserves layout so the planner still understands the page; a solid fill over a face
would cost visual-context accuracy for no privacy gain. Prefer a genuine blur to pixelation,
which is partially reversible at low block sizes.

### `redaction/merge.ts` — box merging

Union boxes whose `iou > 0.1`, or which are adjacent and share a class. Apply per-class
padding, then clamp to the viewport. **Merge before painting**: stacked blurs over the same
region produce artefacts and inflate over-redaction area, which is scored against you.

### `redaction/gate.ts` — the guarded module

```ts
const RECEIPTS = new WeakMap<OffscreenCanvas, Receipt>();

export function seal(raw: ImageBitmap, findings: Finding[], policy: Policy) {
  const c = new OffscreenCanvas(raw.width, raw.height);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(raw, 0, 0);

  const ops = mergeOverlapping(findings.map((f) => policy.opFor(f)));
  for (const op of ops) applyOp(ctx, op); // box | blur | fill

  raw.close(); // the original is unreachable
  RECEIPTS.set(c, {
    scheme: 'sih26171/v1',
    ops,
    detected: findings.length,
    redacted: ops.length,
    sha: hashOps(ops),
  });
  return c;
}

export async function encode(sealed: OffscreenCanvas) {
  const receipt = RECEIPTS.get(sealed);
  if (!receipt) throw new Error('unsealed canvas reached the encoder');
  const blob = await sealed.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  return { blob, receipt };
}
```

`applyOp` blur implementation: use `ctx.filter = 'blur(Npx)'` where available. Firefox's
`OffscreenCanvas` filter support is inconsistent — detect it at init and fall back to
downscaling the crop to 1/16 and scaling it back up with `imageSmoothingQuality: 'high'`.
Both paths must produce visually equivalent output; test them side by side.

### `worker/receipt.ts` — independent verification

The service worker recomputes the receipt hash from the manifest it is about to send and
refuses to transmit on mismatch. Three lines, and the guarantee stops depending on the gate
being called correctly.

### Enforcement

The ESLint rule and `npm run test:gate` already exist from bootstrap. Verify both still
catch a violation: add a `canvas.toBlob()` call in `content/capture.ts`, confirm the lint
run and the bundle grep both fail, then remove it. Add a unit test asserting `encode()`
throws on a canvas that was never sealed.

## Acceptance criteria

1. Mean box IoU against ground truth **> 0.85** on the corpus.
2. Over-redaction rate — non-PII redacted area ÷ total redacted area — **< 5%**.
3. `encode()` throws on an unsealed canvas (unit test).
4. Adding an encoder call outside the gate fails `npm run lint` and `npm run test:gate`.
5. The source `ImageBitmap` is closed by `seal()` — assert in a test.
6. Blur output is visually equivalent in Chrome and Firefox.
7. Two overlapping findings produce one merged operation, not two stacked blurs.
8. Seal + encode completes in under 60 ms at 1024 px.

## Do not

- Do not "fail safe" by redacting the whole frame when detection is uncertain. Over-redaction
  is a scored failure, not a safe default — it costs the 25% visual-context metric.
- Do not keep a reference to the raw bitmap for debugging. Not even behind a flag.
- Do not let the receipt live anywhere the canvas does not. `WeakMap`, so it is collected
  with the canvas.

Commit as `M6: redaction gate`.
