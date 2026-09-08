# Prompt M11 — Evaluation harness and corpus

> Depends on: M5, M6. Owner: Eval, with a whole-team labelling session. Estimate: ~45 h.
> **Start this on day 8, not day 18.** 65% of the rubric is measurable, and you cannot tune
> what you have not measured.

---

Read `CLAUDE.md`. You are implementing M11: the corpus, the labels, the headless runner and
the report. This module is what turns week three from guesswork into tuning.

## 1. The corpus (`eval/corpus/`)

Fifty pages, saved as self-contained HTML so runs are deterministic and work offline.

**Twenty-five synthetic**, authored by you: an Indian government form layout, a scholarship
application, a bank statement, a scanned ID card (PII as pixels only), a healthcare portal,
a job application, an e-commerce checkout, an insurance claim. Vary layout density,
font size, and whether PII appears as text or as image.

**Twenty-five captured** from real sites. Anonymise before anything enters the repository —
replace real personal data with synthetic equivalents of the same shape and length so the
detectors face realistic input without you shipping someone's Aadhaar number.

**Hard negatives, and take them seriously.** At least sixty across the corpus: twelve-digit
invoice numbers, order ids, currency amounts shaped like card numbers, dates that are not
birthdays, names that are also place names (Nagpur, Salem, Georgia), sixteen-digit reference
codes. Hard negatives are how you prove precision rather than assert it, and they take one
afternoon.

## 2. The labelling tool (`eval/label_tool/`)

A minimal local web tool: load a page screenshot, draw boxes, pick a class from the frozen
vocabulary, write `labels.json`. A page must be labellable in under five minutes or the
corpus will not get finished.

**Calibrate before you scale.** Two people label the first ten pages independently and
compare. Agreement below 0.9 means your definition of a PII span is ambiguous — fix the
definition, not the labels, before touching the remaining forty.

## 3. The runner (`eval/harness.py`)

Playwright launching Chromium with `--load-extension=dist/chrome`, driving each corpus page
through one perception cycle, and dumping per page: findings, manifest, the sealed image,
and stage timings. One command runs the whole corpus.

## 4. Metrics — the definitions matter, get them exact

- **Element recall**: hand-listed interactive elements present in the index ÷ total.
- **PII precision / recall / F1**, per class, plus a confusion matrix. Report at **both** NER
  operating points from M5.
- **Redaction IoU**: mean IoU of each redaction box against its ground-truth box.
- **Over-redaction rate**: redacted pixel area not overlapping any ground-truth box ÷ total
  redacted pixel area. This is the metric that separates you from teams who blur everything,
  and it is the one nobody else will report.
- **Resources**: peak GPU memory, peak JS heap, resident model bytes, idle CPU.
- **Latency**: per stage, with p50 and p95.

## 5. The report (`eval/report/`)

`report.json` plus an HTML report containing the confusion matrix, all metrics against their
targets, and — most usefully — **a gallery of the ten worst redactions** by IoU and the ten
worst over-redactions by area. That gallery is where every week-three tuning decision comes
from. Without it you will tune blind.

## Targets

| Metric                                        | Target            |
| --------------------------------------------- | ----------------- |
| Element recall                                | > 0.92            |
| PII recall, high-severity classes             | > 0.95            |
| PII precision, high-precision operating point | > 0.90            |
| Redaction IoU                                 | > 0.85            |
| Over-redaction rate                           | < 5%              |
| Peak GPU memory                               | < 700 MB          |
| Peak JS heap                                  | < 450 MB          |
| Idle CPU                                      | ~ 0%              |
| Step latency p50 / p95                        | < 1.8 s / < 3.5 s |

## Acceptance criteria

1. One command regenerates the entire report from the corpus.
2. All fifty pages labelled, with the ten-page calibration documented.
3. Every metric above appears in `report.json` with its target alongside the measured value.
4. The worst-ten gallery renders sealed images with ground-truth and predicted boxes
   overlaid in distinguishable colours.
5. The harness runs offline.
6. A deliberately broken detector (e.g. Verhoeff disabled) produces a visibly worse
   precision number — proving the harness measures what you think it measures.

## Do not

- Do not report a single aggregate "accuracy" number. The rubric has five metrics; report
  five.
- Do not tune against the corpus and then report the same corpus as a held-out result. If
  you tune, say so, and hold out ten pages you never look at until the final run.
- Do not ship real personal data in the repository, even in a screenshot.

Commit as `M11: eval harness and corpus`.
