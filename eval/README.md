# Eval

Fifty pages, their ground truth, a headless runner, and a report.

```bash
pip install -r eval/requirements.txt  # harness deps: psutil, playwright, websocket-client, pillow
npm run build                    # the harness scores the bundle, not the sources
python eval/corpus/generate.py   # regenerate pages + labels (deterministic, seeded)
python eval/harness.py           # run all fifty and write the report
python eval/harness.py --score-only   # re-score the last run without a browser
python eval/sabotage.py          # the control experiment: break a detector, watch it move
```

`eval/requirements.txt` is the complete third-party set the harness imports — nothing
more. It does **not** include the server's dependencies (the planner here is a local
fixed-plan recorder), and it does **not** need `playwright install`: the harness connects
Playwright to a real Google Chrome over CDP and refuses the bundled Chromium
(`runner/browser.py`), so no Playwright-managed browser is ever downloaded or launched.

Output is `report/report.json` and `report/report.html`. The HTML is self-contained —
images inlined, CSS inline — so it travels to a machine with no network.

---

## What this found, and what happened next

The first full run said two things, and M3b acted on both.

**A page that _displays_ personal data as prose was not protected at all.** Replica pages
reported **two** perceivable elements each and produced **zero** findings while carrying
four to fifteen ground-truth spans apiece. Perception walked for _actionable_ elements, so
an Aadhaar in a `<dd>` never became an element and neither L0 nor L1 ever saw it.

M3b added a third admission class for text-bearing blocks. Measured, same corpus, same
method:

|                           | before | after            |
| ------------------------- | ------ | ---------------- |
| PII recall, micro         | 0.175  | 0.441            |
| PII recall, high-severity | 0.269  | 0.625            |
| PII precision             | 0.529  | 0.639            |
| held-out recall           | 0.049  | 0.410            |
| elements perceived, total | 329    | 1,463            |
| median request bytes      | 16,076 | 21,216 (+32%)    |
| perceive, median          | —      | 9 ms (max 21 ms) |

The held-out number is the one worth reading twice. It was 4x below the tuned-on figure
and is now beside it (0.410 against 0.447), which is what it looks like when a gap was
structural rather than fitted.

Still short of the 0.90 target. What is left is a genuinely harder class of miss than
"never looked": prose where the label is separated from the value, values in parentheses,
and run-on sentences — which is exactly what the held-out ten were written to contain.

**Over-redaction was 50.4% against a target of 5%.** It is now 32.2%, and roughly a third
of that improvement was the measurement being wrong rather than the gate. Both halves are
described under _The two over-redaction numbers_ below. It remains far over target: L0
still attributes findings to blocks that hold a caption alongside a value on pages where
no tighter element exists, and those are dropped rather than painted, which trades
over-redaction for recall. Tuning the constants is deliberately not part of M3b.

## The corpus

Fifty self-contained pages, deterministic from a seed, in `corpus/pages/`.

|                | count                   |                                     |
| -------------- | ----------------------- | ----------------------------------- |
| synthetic      | 25                      | forms and documents authored here   |
| replica        | 25                      | authored imitations of real portals |
| held out       | 10                      | never looked at while tuning        |
| hard negatives | 171                     | decoys, in viewport                 |
| PII spans      | 366 text, 6 pixels-only |                                     |

Ten archetypes: government form, scholarship application, bank statement, scanned ID,
healthcare portal, job application, e-commerce checkout, insurance claim, telecom bill,
utility bill. Layout density, font size, and whether PII is text or pixels all vary.

### Pages emit their own ground truth

Two phases, in `corpus/generate.py`:

1. **generate** — each page is authored with `data-pii="<CLASS>"`, `data-neg`, and
   `data-el` on every planted value, decoy and control.
2. **render** — the page is loaded once headlessly, the _rendered_ rectangles are read
   out of the live layout, and `labels/<id>.json` is written.
3. **ship** — the same page, with every mark stripped, goes to `corpus/pages/`.

The shipped page carries no marks; verified by test. `labels.json` is never read by the
extension. Ground truth measured from the real layout beats ground truth drawn by hand:
it cannot be off by a pixel, and it cannot drift when a stylesheet changes — if the page
moves, the labels are regenerated from the page that moved.

### The hard negatives are the point

171 decoys, and they are not filler. Twelve-digit invoice numbers that **pass Verhoeff**,
order ids, reference codes of card length, amounts shaped like account numbers, dates that
are not birthdays, and names that are also places (Nagpur, Salem, Georgia).

A precision number measured without them is an assertion. With them it is a measurement.

---

## Deviations, stated rather than buried

**No captured pages, so no hand labelling, so no inter-annotator calibration.**

The brief asks for 25 pages captured from real sites, anonymised, and hand-labelled by two
people on the first ten to check agreement ≥ 0.9. The 25 "replica" pages here are authored
imitations instead. The reason is the rule that shipping real personal data into the
repository is not acceptable even once, even anonymised, even in a screenshot — and an
anonymisation pass over a real capture is exactly the sort of thing that works 49 times.

What that costs, plainly:

- No inter-annotator agreement number, because no human labelled anything. There is
  nothing to calibrate between two people when the layout engine is the labeller.
- The replicas are _my_ idea of what those portals look like, so they cannot surprise the
  detector the way a real capture would. Structure, class mix and density are varied
  deliberately to compensate, but this is compensation, not equivalence.

`label_tool/` is built and working for when real captures are added: load a screenshot,
drag boxes, pick a class, download `labels.json`. Local and offline — a labelling tool
that uploads a screenshot is the wrong shape for this corpus. Its copy of the frozen
vocabulary is checked against `shared/placeholders.ts` by a test, because a second copy of
a list is a second list.

**The eval build widens one permission.**

`captureVisibleTab` needs `activeTab` or a host permission. `activeTab` is granted only by
a real toolbar click, and there is no gesture a harness can produce that earns it. So
`runner/build.py` copies `dist/chrome` and sets `host_permissions` to `<all_urls>` in the
copy, recording the shipped value and the reason inside the manifest. `describe()` refuses
to score a build without that marker, and the report prints it.

Exactly one field differs. Everything measured — perception, detection, the gate, the
boxes — is the shipped code.

**Idle CPU is reported twice.**

The scored figure covers the processes that run extension code; the whole-tree figure is
shown beside it. A browser with tabs open burns CPU on compositing and its own
housekeeping whether or not an extension is installed, and charging that to the extension
would be as dishonest as not measuring it. Because the offscreen document shares a
renderer with pages, the extension figure is an upper bound rather than an exact
attribution, and the report says so.

---

## Held out

Ten pages — five synthetic, five replica — are excluded from anything that could be called
tuning, and scored separately in every report:

```
rep-aadhaar-profile  rep-epfo-passbook  rep-hdfc-card  rep-univ-admission
rep-utility-bill     syn-bank-card      syn-gov-passport
syn-health-discharge syn-scan-cheque    syn-shop-addresses
```

The report prints held-out and tuned-on rows side by side. If they diverge sharply, the
headline numbers describe the tuning set rather than the method, and that is the first
thing a judge should be able to check.

Nothing has been tuned against this corpus yet, so today's gap between the two is page
composition, not overfitting — the held-out half is replica-heavy, and replicas are where
the perception gap bites hardest.

---

## The control experiment

`python eval/sabotage.py` breaks a detector on purpose and checks the numbers move. A
metric nobody has watched move is a metric nobody should trust.

Three sabotages, and two of them taught more by _not_ moving:

| sabotage                                                | prediction                       | result                                   |
| ------------------------------------------------------- | -------------------------------- | ---------------------------------------- |
| Verhoeff disabled — accept any twelve digits            | decoys admitted, precision falls | **nothing moved**                        |
| negative context disabled — captions stop disqualifying | decoys admitted, precision falls | **nothing moved**                        |
| Verhoeff always fails — no Aadhaar is valid             | true positives collapse          | **moved**: TP 7→5, precision 0.536→0.522 |

Both unmoved results have one cause, and it is the finding at the top of this file: all 45
in-viewport Aadhaar decoys sit in page prose, and prose is never scanned. No change to how
L1 _judges_ text can alter a false-positive count when L1 never sees the text.

The third confirms sensitivity in the direction that is exercisable. It also says
something exact: two of the seven true positives survive a checksum that always fails,
because they come from L0 reading `autocomplete` and `name` attributes and never consulting
a checksum at all.

The precision direction cannot be exercised on this corpus until perception covers text
outside form controls. Reporting all three, rather than only the one that moved, is the
point of running a control.

---

## Metrics, and what each one actually means

- **Element recall** — hand-listed interactive elements present in the index ÷ total.
  Pooled across pages, not averaged, so a page with two controls and a page with forty do
  not weigh the same.
- **PII precision / recall / F1** — per class, plus micro, plus a confusion matrix,
  reported at **both** NER operating points. The threshold is applied when reading the
  manifest, so the two points are two readings of one run rather than two runs.
- **Redaction IoU** — mean IoU over matched pairs. Reported _beside_
  `iouOverAllGroundTruth`, which counts a miss as zero, because IoU over matches alone
  only describes the spans that were found. Today those two read 1.000 and 0.175, and the
  gap between them is the honest summary of this run.
- **Over-redaction** — measured twice, by routes with almost nothing in common. See
  below; the harness now fails the run if they disagree by more than two points.
- **Resources** — peak GPU process memory, peak JS heap, resident model bytes, idle CPU.
  Not RSS: on a multi-process browser RSS counts shared pages repeatedly and says nothing
  about what the extension costs.
- **Latency** — per stage, p50 and p95, nearest-rank so every percentile is a real run.

There is deliberately no single "accuracy" figure. The rubric has five criteria; an
aggregate that folds over-redaction into recall is precisely the number a team that blurs
everything would want quoted.

---

## The two over-redaction numbers

One reconstructs the painted region from the manifest's boxes, replaying the gate's
padding and merge rules. The other reads the mask straight out of the sealed pixels and
trusts nothing the gate said about itself. Same question, independent routes.

They started **23.3 points apart** — 27.9% against 50.4%. Every point of that was a defect,
and none of them was the gate:

- the reconstruction **summed** overlapping box areas where the gate paints a **union**;
- it never replayed the **merge**, and `unionBox` in merge.ts takes a _bounding_ box, so
  two findings in a row become one rectangle spanning the gap between them;
- it inferred **box kind by geometry**, but a text block's element rect and its run rect
  are frequently the same rectangle, so it called both `element` and under-padded by two
  pixels a side;
- the pixel side **diffed against a resampled clean screenshot**, and resampling a page
  full of text differs on every glyph edge, so text the gate had never touched counted as
  paint;
- and after that was replaced by reading the mask directly, **WebP's halo** at each mask
  edge still read as a pixel of paint all the way round every box.

Fixing the fourth of those uncovered a real product bug: `textRuns` was measuring _the
element's rect rather than the text_, so "narrow this container to the run holding the
value" narrowed it to exactly the same rectangle. Runs are measured with a Range now.

They agree to **0.84 points**, and `check_agreement` fails the run above two. That
assertion is the point: the next drift will be a fraction of this one and invisible
without it.

## Offline

Everything: the corpus is self-contained HTML on a loopback port, the planner is a local
recorder returning a fixed plan, no model is consulted, and no request leaves the machine.
The planner is deliberately fixed — what is measured here is perception and redaction, and
a planner that varied between runs would make the numbers unrepeatable.
