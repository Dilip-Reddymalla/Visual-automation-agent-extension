# Prompt M5 — PII detection, four layers

> Depends on: M2, M3, M4. Owner: Privacy + Models. Estimate: ~40 h across two sessions.
> Owns 20% of the evaluation directly and feeds the 20% redaction metric.

---

Read `CLAUDE.md`. You are implementing M5: four detection layers that all emit the same
record, so the gate never needs to know which detector found what.

Build this in two sessions. **Session A: L0 + L1 + the shared types** (deterministic, no
models, testable in Node). **Session B: L2 + L3** (models, fusion). Do not start B until A's
tests pass.

```ts
type Finding = {
  cls:
    | 'aadhaar'
    | 'pan'
    | 'gstin'
    | 'ifsc'
    | 'upi'
    | 'account'
    | 'card'
    | 'passport'
    | 'licence'
    | 'person'
    | 'address'
    | 'email'
    | 'phone'
    | 'dob'
    | 'org'
    | 'face'
    | 'signature'
    | 'secret';
  conf: number; // 0..1
  source: 'L0' | 'L1' | 'L2' | 'L3'; // becomes the manifest's `by` field
  box: Box; // CSS px, viewport origin
  elementIndex?: number;
  textSpan?: [number, number];
  placeholder?: string; // assigned by the allocator in shared/placeholders.ts
};
```

---

## Session A

### L0 — structural (`redaction/l0-structural.ts`)

Deterministic rules over element attributes. Near-perfect precision, negligible cost, and it
catches the highest-severity fields. Match on:

- `input[type=password]`, `input[type=email]`, `input[type=tel]`
- `autocomplete` tokens: `cc-number, cc-csc, cc-exp, tel, email, one-time-code,
street-address, postal-code, bday, name, family-name, given-name`
- the `-webkit-text-security` computed style
- `aria-label`, `placeholder`, and adjacent `<label>` text against a keyword lexicon
- `name` and `id` attribute patterns
- any masking class the site applies to itself

**Build the lexicon bilingually and with Indian field names from the start**: aadhaar,
aadhar, uid, uidai, pan, gstin, ifsc, upi, vpa, mobile, pincode, dob, janm, father's name,
guardian, account number, bank account, ration card, voter id.

### L1 — lexical with checksums (`redaction/l1-lexical.ts`, `redaction/validators.ts`)

Regex alone over-fires badly on any page with numbers on it, and that is exactly how teams
lose the precision marks. **Every numeric class gets a validator.**

| Class                                           | Pattern                                                | Validator                                              |
| ----------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| Aadhaar                                         | 4-4-4 digits, optional separators, not starting 0 or 1 | **Verhoeff checksum**                                  |
| PAN                                             | 5 letters, 4 digits, 1 letter                          | 4th char in entity-type set; 10th is a check letter    |
| GSTIN                                           | 2 state digits + PAN + entity digit + Z + checksum     | base-36 weighted checksum                              |
| IFSC                                            | 4 letters, `0`, 6 alphanumerics                        | 5th char must be `0`; bank code against a shipped list |
| UPI VPA                                         | `handle@psp`                                           | PSP suffix against a shipped list                      |
| Card                                            | 13–19 digits, grouped                                  | **Luhn** + issuer prefix                               |
| Mobile (IN)                                     | optional `+91`/`0`, then `[6-9]` + 9 digits            | length and leading-digit rule                          |
| Email, IPv4/v6, pincode, passport, licence, DOB | standard shapes                                        | format rules                                           |

Implement Verhoeff properly (the d, p and inv tables) — a hand-rolled approximation defeats
the purpose. Unit-test both directions: every valid fixture accepted, every hard negative
rejected.

**Session A acceptance:** on a fixture page containing 40 valid identifiers and 60 hard
negatives (invoice numbers, order ids, currency amounts, dates that are not birthdays,
names that are also place names), precision ≥0.97 and recall ≥0.75 on structured PII, with
zero model loaded and total runtime under 10 ms.

---

## Session B

### L2 — semantic NER (`offscreen/tasks/ner.ts`)

Names, addresses, organisations and free-text disclosures no pattern will catch.

1. Concatenate visible text nodes, keeping a running **offset table** mapping every character
   back to its text node and therefore to a box. This table is the whole difficulty of the
   layer; get it right and the rest is mechanical.
2. Run token classification. Chunk to the model window with a **50-token overlap** so
   entities straddling a boundary survive; de-duplicate across the overlap by span identity.
3. Map spans back through the offset table to boxes.
4. **Early exit**: if L0 and L1 already classified every text node, do not load the model at
   all. This is common and cheap.
5. Quantise to int8. This is the largest client model and the likeliest cause of a blown
   resource budget. Lazy-load, and let the session registry unload it.
6. Expose **two confidence thresholds** — a high-recall setting and a high-precision setting.
   The eval reports both operating points. Being explicit about the trade reads as rigour.

### L3 — visual (`offscreen/tasks/face.ts`, `offscreen/tasks/ocr.ts`)

1. **Face detection on every frame.** MediaPipe Tasks Vision BlazeFace (Apache-2.0, ~2 MB,
   WASM-backed, no WebGPU dependency). 15–40 ms. Ship it first; it makes the demo legible
   in one glance.
2. **OCR-with-region over DOM-opaque crops only.** Florence-2-base-ft ONNX (MIT) via
   Transformers.js, task token `<OCR_WITH_REGION>`. Opaque means: `img`, `canvas`, `video`,
   cross-origin `iframe`, embedded PDF. **Never OCR the whole screenshot** — that is 500 ms
   spent re-deriving text the DOM already handed you, and it costs the latency metric to gain
   nothing.
3. **Cache OCR results by a hash of the crop.** A scanned document on screen across six steps
   is read once.
4. Feed OCR'd text back through L1 and L2 — an Aadhaar number inside a scanned image must be
   caught by the same validators.

### Fusion (`content/serialize.ts`, extended)

Match vision boxes to DOM boxes by `iou(a, b) > 0.5`. On a match the DOM element keeps its
identity and gains the visual attribute. On no match the vision box becomes a first-class
**visual-only element** — no clickable index, but a coordinate the planner may click as a
last resort. This step produces the visual-context score.

## Session B acceptance

1. The Aadhaar number rendered as pixels on demo page A is detected via OCR → L1 → Verhoeff.
2. A face on demo page A is boxed at ≥0.9 confidence in under 40 ms.
3. On a page fully covered by L0/L1, the NER model is never loaded — assert via `host.stats()`.
4. An entity straddling a chunk boundary is detected exactly once.
5. Every returned NER span resolves to a box within 2 px of the rendered text.
6. An unchanged image region is OCR'd once across six consecutive steps.
7. Full L0–L3 pass completes in under 600 ms on a page with two image regions.

## Do not

- Do not use Ultralytics YOLOv8 weights or the OmniParser v2 icon detector. Both are
  AGPL-3.0 and would contaminate an offline-deployability claim to ISRO.
- Do not add a UI-element detection model. The DOM does that better and free.
- Do not let any detector return boxes in image space. CSS pixels, always.

Commit as `M5a: L0 and L1 detection` and `M5b: L2, L3 and fusion`.
