/**
 * Reconciles findings from four layers into one non-overlapping set of paint operations.
 *
 * Merging happens before painting, and that ordering is not cosmetic. Two blurs stacked
 * over the same region blur the already-blurred pixels, producing a visibly different
 * patch from either one alone, and two masks over overlapping boxes inflate the painted
 * area that the over-redaction rate is measured against. Both are scored.
 *
 * Precedence between layers is not re-decided here. `strongerDraft` and `LAYER_RANK` in
 * findings.ts already say that L0 outranks L1 outranks L2 outranks L3, with confidence
 * first -- a second ordering in this file would be a second answer to the same question.
 *
 * Node-pure.
 */

import { clampToViewport, iou, padBox, type Box, type Viewport } from '../shared/coords';
import type { Finding, RedactionMode } from '../shared/contract';
import type { PlaceholderClass } from '../shared/placeholders';
import { strongerDraft } from './findings';
import {
  BLUR_PADDING_PX,
  BLUR_POLICY,
  KEEP_REASON,
  PADDING_PX,
  policyFor,
  type BoxKind,
  type ClassPolicy,
} from './policy';

/** Boxes overlapping by more than this are one region, not two. */
export const MERGE_IOU = 0.1;

/** Same-class boxes closer than this, in CSS px, are one region: adjacent text runs. */
export const ADJACENCY_PX = 8;

/** One thing the gate will paint. */
export interface PaintOp {
  mode: Exclude<RedactionMode, 'keep'>;
  /** Padded and clamped, in CSS px of the visual viewport. */
  box: Box;
  cls: PlaceholderClass;
  /** Every finding this operation covers, for the manifest and the trace. */
  findingIds: string[];
  confidence: number;
}

export interface MergeResult {
  ops: PaintOp[];
  /** Findings deliberately left visible, with `mode: 'keep'` and a reason. */
  kept: Finding[];
  /** Findings as the manifest should carry them: modes reconciled with what was done. */
  findings: Finding[];
}

export interface MergeOptions {
  viewport: Viewport;
  /** Overrides for classes the frozen vocabulary does not cover yet. See policy.ts. */
  policyOverride?: (cls: PlaceholderClass) => ClassPolicy | undefined;
  /**
   * finding id -> where its box came from. Absent means 'element', which is what every
   * L0 finding and most L1 findings produce.
   *
   * Device-side, deliberately not on the wire: how a box was measured is our business,
   * and the planner has no use for it.
   */
  boxKinds?: Readonly<Record<string, BoxKind>>;
}

/** How far past this finding's box to paint, in CSS px. */
export function paddingFor(kind: BoxKind, mode: ClassPolicy['mode']): number {
  return mode === 'blur' ? BLUR_PADDING_PX : PADDING_PX[kind];
}

function policyOf(cls: PlaceholderClass, options: MergeOptions): ClassPolicy {
  return options.policyOverride?.(cls) ?? policyFor(cls);
}

/** Do these two boxes touch, or nearly? Used only between findings of one class. */
export function adjacent(a: Box, b: Box, gap = ADJACENCY_PX): boolean {
  const horizontal = a.x < b.x + b.w + gap && b.x < a.x + a.w + gap;
  const vertical = a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
  return horizontal && vertical;
}

function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/**
 * Should these two become one operation?
 *
 * Overlap alone is enough regardless of class -- two overlapping masks paint the same
 * pixels twice whatever they were called. Mere adjacency is only enough within a class,
 * because a phone number beside a name is two things, and joining them would paint the
 * gap between them for nothing.
 */
function shouldMerge(a: PaintOp, b: PaintOp): boolean {
  if (a.mode !== b.mode) return false;
  if (iou(a.box, b.box) > MERGE_IOU) return true;
  return a.cls === b.cls && adjacent(a.box, b.box);
}

/**
 * Findings to paint operations.
 *
 * Padding is applied per class *before* merging and the result is clamped to the
 * viewport after, so a box near the edge does not drag the merged region off-screen and
 * then get counted as redacted area that was never visible.
 */
export function mergeFindings(findings: Finding[], options: MergeOptions): MergeResult {
  const kept: Finding[] = [];
  const reconciled: Finding[] = [];
  let pending: PaintOp[] = [];

  for (const finding of findings) {
    const policy = policyOf(finding.cls, options);

    if (policy.mode === 'keep' || finding.confidence < policy.minConfidence) {
      // Reported, not painted -- and it says so, in the manifest, with a reason.
      const asKept: Finding = { ...finding, mode: 'keep', reason: KEEP_REASON };
      kept.push(asKept);
      reconciled.push(asKept);
      continue;
    }

    reconciled.push({ ...finding, mode: policy.mode });
    const kind = options.boxKinds?.[finding.id] ?? 'element';
    pending.push({
      mode: policy.mode,
      box: padBox(finding.box, paddingFor(kind, policy.mode)),
      cls: finding.cls,
      findingIds: [finding.id],
      confidence: finding.confidence,
    });
  }

  // Repeat to fixpoint: merging A into B can bring the result within range of C.
  let merged = true;
  while (merged) {
    merged = false;
    const next: PaintOp[] = [];

    for (const op of pending) {
      const partner = next.find((candidate) => shouldMerge(candidate, op));
      if (!partner) {
        next.push(op);
        continue;
      }

      // The surviving class is whichever finding was more authoritative, by the one
      // precedence rule this project has.
      const winner = strongerDraft(
        { layer: layerOf(partner, findings), confidence: partner.confidence },
        { layer: layerOf(op, findings), confidence: op.confidence },
      );
      const takeOp =
        winner.confidence === op.confidence && winner.layer === layerOf(op, findings);

      partner.box = unionBox(partner.box, op.box);
      partner.cls = takeOp ? op.cls : partner.cls;
      partner.confidence = Math.max(partner.confidence, op.confidence);
      partner.findingIds = [...partner.findingIds, ...op.findingIds];
      merged = true;
    }

    pending = next;
  }

  const ops = pending.map((op) => ({ ...op, box: clampToViewport(op.box, options.viewport) }));
  return { ops, kept, findings: reconciled };
}

/** The layer of the strongest finding an op covers. */
function layerOf(op: PaintOp, findings: Finding[]): Finding['layer'] {
  let best: Finding | undefined;
  for (const id of op.findingIds) {
    const finding = findings.find((f) => f.id === id);
    if (!finding) continue;
    best = best ? strongerDraft(best, finding) : finding;
  }
  return best?.layer ?? 'L3';
}

/** The blur policy, for a caller that has classes the vocabulary does not cover yet. */
export function blurOverride(classes: ReadonlySet<string>) {
  return (cls: PlaceholderClass): ClassPolicy | undefined =>
    classes.has(cls) ? BLUR_POLICY : undefined;
}
