/**
 * THE GATE (CLAUDE.md invariant 1).
 *
 * This file is the only module in the tree permitted to encode a canvas. An eslint
 * no-restricted-syntax rule enforces that everywhere else, and `npm run test:gate`
 * greps the built bundle to prove the rule was not simply disabled.
 *
 * The weak claim, which every team makes: we redact PII before sending.
 * The strong claim, which this file buys: the encoder that produces the outbound
 * payload cannot read the unredacted buffer, because by the time it runs that buffer
 * does not exist in this process.
 *
 * Two steps, not interchangeable:
 *
 *   seal(raw, findings, options)   paints redactions onto a fresh canvas, closes the
 *                                  source bitmap, and stamps a receipt into a WeakMap
 *                                  keyed by that canvas.
 *   encode(sealed)                 the single convertToBlob call in the project. Throws
 *                                  if the canvas carries no receipt.
 *
 * The receipt lives in a WeakMap so it is collected with the canvas and cannot be
 * carried anywhere the pixels are not. There is no way to look up "the receipt for
 * these findings" -- only "the receipt for this canvas".
 *
 * Where the two hashes are computed, and one ordering constraint. `manifestHash` is
 * computed in seal(), over the canonicalised manifest. `hash`, over the encoded bytes,
 * cannot be: the bytes do not exist until convertToBlob has run, and convertToBlob is
 * the thing seal() must not do. So encode() completes the receipt with the byte digest.
 * The worker then recomputes both independently (worker/receipt.ts) and refuses to
 * transmit on either mismatch, which is the guarantee that actually matters.
 *
 * Both are SHA-256, which is why seal() is async. An earlier version used a fast
 * non-cryptographic digest for the manifest on the grounds that it only binds a manifest
 * to a canvas inside one process -- but the receipt says `algo: 'SHA-256'`, and a
 * privacy tool that names an algorithm it is not using has spent more credibility than
 * the microseconds were worth.
 *
 * Node-pure: no chrome, no window, no document. The canvas factory is injected, so this
 * whole file is exercised in Node against a fake 2D context.
 */

import {
  areaOutside,
  area,
  toImageSpace,
  unionArea,
  type Box,
  type Viewport,
} from '../shared/coords';
import type { Finding, Manifest, Receipt } from '../shared/contract';
import type { PlaceholderClass } from '../shared/placeholders';
import { mergeFindings, type MergeOptions, type PaintOp } from './merge';
import { drawMarks, type MarkContext, type Markable } from './marks';
import { BLUR_STRENGTH, MIN_BLUR_RADIUS, POLICY_VERSION } from './policy';

/** The scheme name that goes in the receipt, so a future format change is detectable. */
export const RECEIPT_SCHEME = 'sih26171/v1';

// ── The minimum canvas surface this module needs ───────────────────────────────
// Structural types rather than lib.dom's, so the gate runs under Vitest. An
// OffscreenCanvas satisfies them exactly.

export interface GateContext {
  filter: string;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: 'low' | 'medium' | 'high';
  fillStyle: string;
  save(): void;
  restore(): void;
  drawImage(source: unknown, ...args: number[]): void;
  fillRect(x: number, y: number, w: number, h: number): void;
}

export interface GateCanvas {
  readonly width: number;
  readonly height: number;
  getContext(type: '2d'): GateContext | null;
  convertToBlob(options?: { type?: string; quality?: number }): Promise<Blob>;
}

export interface SourceBitmap {
  readonly width: number;
  readonly height: number;
  close(): void;
}

/** A canvas that has been through seal(). The receipt is what encode() looks for. */
export interface SealedCanvas {
  canvas: GateCanvas;
  receipt: Receipt;
  manifest: Manifest;
}

export interface SealOptions extends MergeOptions {
  viewport: Viewport;
  /** Image pixels per CSS pixel. The one scale factor (CLAUDE.md invariant 2). */
  scale: number;
  createCanvas(width: number, height: number): GateCanvas;
  /** Placeholder per finding id, from the allocator. Absent means none was issued. */
  placeholders?: ReadonlyMap<string, string>;
  now?: () => number;
  policyVersion?: string;
  /**
   * Elements to mark, by the index the planner will use.
   *
   * Set-of-Mark, and it belongs here rather than in the debug overlay: see marks.ts. The
   * indices are passed in rather than derived, because the number drawn has to be the same
   * integer the element list carries and there is exactly one source for that.
   */
  marks?: readonly Markable[];
}

/**
 * The receipts. A WeakMap keyed by canvas, so a receipt cannot outlive the pixels it
 * describes and cannot be handed to anything holding a different canvas.
 */
const RECEIPTS = new WeakMap<GateCanvas, Receipt>();

/**
 * Does this context implement `filter`?
 *
 * Chrome's OffscreenCanvas does; Firefox's has historically not, and silently -- the
 * assignment succeeds, reads back as the value you set, and blurs nothing. So the probe
 * writes a filter and checks it took, and anything short of a definite yes takes the
 * fallback path.
 */
export function supportsCanvasFilter(ctx: GateContext): boolean {
  try {
    const before = ctx.filter;
    ctx.filter = 'blur(4px)';
    const took = ctx.filter === 'blur(4px)';
    ctx.filter = before || 'none';
    return took;
  } catch {
    return false;
  }
}

/** Blur radius for a region, in image pixels. */
export function blurRadius(box: Box, scale: number): number {
  const shortSide = Math.min(box.w, box.h) * scale;
  return Math.max(MIN_BLUR_RADIUS, Math.round(shortSide * BLUR_STRENGTH));
}

/**
 * The downscale fallback, for a context with no `filter`.
 *
 * Drawing a region into a canvas a sixteenth of its size and back destroys detail
 * irreversibly -- it is an average over 16x16 blocks, not a rearrangement of them, so
 * unlike pixelation at small block sizes there is nothing to invert. Scaling back up
 * with high smoothing gives a soft result rather than visible blocks, which is what
 * makes the two paths comparable.
 */
export const FALLBACK_DIVISOR = 16;

function paintBlur(
  ctx: GateContext,
  source: unknown,
  box: Box,
  scale: number,
  useFilter: boolean,
  createCanvas: SealOptions['createCanvas'],
): void {
  const image = toImageSpace(box, scale);
  const x = Math.floor(image.x);
  const y = Math.floor(image.y);
  const w = Math.max(1, Math.ceil(image.w));
  const h = Math.max(1, Math.ceil(image.h));

  if (useFilter) {
    ctx.save();
    ctx.filter = `blur(${blurRadius(box, scale)}px)`;
    // Redraw only this region, through the filter, on top of itself.
    ctx.drawImage(source, x, y, w, h, x, y, w, h);
    ctx.restore();
    return;
  }

  const smallW = Math.max(1, Math.round(w / FALLBACK_DIVISOR));
  const smallH = Math.max(1, Math.round(h / FALLBACK_DIVISOR));

  const small = createCanvas(smallW, smallH);
  const smallCtx = small.getContext('2d');
  if (!smallCtx) return;
  smallCtx.imageSmoothingEnabled = true;
  smallCtx.imageSmoothingQuality = 'high';
  smallCtx.drawImage(source, x, y, w, h, 0, 0, smallW, smallH);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, smallW, smallH, x, y, w, h);
  ctx.restore();
}

function paintMask(ctx: GateContext, box: Box, scale: number): void {
  const image = toImageSpace(box, scale);
  ctx.save();
  ctx.fillStyle = '#000000';
  ctx.fillRect(
    Math.floor(image.x),
    Math.floor(image.y),
    Math.max(1, Math.ceil(image.w)),
    Math.max(1, Math.ceil(image.h)),
  );
  ctx.restore();
}

/**
 * Paint every finding onto a fresh canvas according to its class policy, then stamp the
 * receipt.
 *
 * The source bitmap is closed before this returns, on every path. That is the sentence
 * the whole module exists to make true: after seal(), the unredacted pixels are not
 * reachable from this process, so no later mistake -- a debug flag, a caching layer, a
 * well-meaning refactor -- can encode them.
 */
export async function seal(
  raw: SourceBitmap,
  findings: Finding[],
  options: SealOptions,
): Promise<SealedCanvas> {
  const canvas = options.createCanvas(raw.width, raw.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    raw.close();
    throw new Error('gate: no 2d context');
  }

  try {
    ctx.drawImage(raw, 0, 0);

    // Merge first, always. Stacked blurs over one region produce artefacts and inflate
    // the painted area the over-redaction rate is measured against.
    const { ops, kept, findings: reconciled } = mergeFindings(findings, options);
    const useFilter = supportsCanvasFilter(ctx);

    for (const op of ops) {
      if (op.mode === 'blur')
        paintBlur(ctx, raw, op.box, options.scale, useFilter, options.createCanvas);
      else paintMask(ctx, op.box, options.scale);
    }

    // Marks last, on top of the redactions, and that order is the whole design. A mark
    // drawn first would be painted over by the very masks it exists to compensate for --
    // the planner cannot read what is under a black bar, but it can read the number on
    // top of one and look that number up in the element list. Marking before masking
    // would remove the marks from precisely the fields that need them most.
    const marks = drawMarks(ctx as unknown as MarkContext, options.marks ?? [], {
      scale: options.scale,
      width: canvas.width,
      height: canvas.height,
    });

    const manifest = buildManifest(reconciled, kept, ops, options, marks);
    const receipt: Receipt = {
      algo: 'SHA-256',
      // Filled by encode(): these bytes do not exist yet, and producing them is the one
      // thing seal() must not do.
      hash: '',
      manifestHash: await manifestDigest(manifest),
      sealedAt: (options.now ?? Date.now)(),
    };

    const sealed: SealedCanvas = { canvas, receipt, manifest: { ...manifest, receipt } };
    RECEIPTS.set(canvas, receipt);
    return sealed;
  } finally {
    // Every path, including the throwing one.
    raw.close();
  }
}

/**
 * Encode sealed pixels. The only encoder call in the project.
 *
 * Throws when handed a canvas with no receipt. That is not a defensive nicety: it is
 * what makes "unsealed pixels cannot leave" a property of the code rather than of
 * whoever remembered to call seal first.
 */
export async function encode(
  sealed: SealedCanvas,
  mime: 'image/webp' | 'image/jpeg' | 'image/png' = 'image/webp',
  quality = 0.85,
): Promise<{ bytes: Uint8Array; sha256: string; mime: string; width: number; height: number }> {
  const receipt = RECEIPTS.get(sealed.canvas);
  if (!receipt) throw new Error('gate: unsealed canvas reached the encoder');
  if (receipt !== sealed.receipt) {
    throw new Error('gate: receipt does not belong to this canvas');
  }

  const blob = await sealed.canvas.convertToBlob({ type: mime, quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sha256 = await digest(bytes);

  // Complete the receipt in place, so the manifest the worker verifies is the one the
  // gate produced rather than a copy someone assembled afterwards.
  receipt.hash = sha256;
  sealed.receipt.hash = sha256;
  sealed.manifest.receipt.hash = sha256;

  return { bytes, sha256, mime, width: sealed.canvas.width, height: sealed.canvas.height };
}

/** SHA-256 over encoded bytes, hex. The worker recomputes this independently. */
export async function digest(bytes: Uint8Array): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── The manifest ──────────────────────────────────────────────────────────────

function buildManifest(
  findings: Finding[],
  kept: Finding[],
  ops: PaintOp[],
  options: SealOptions,
  marks: number,
): Omit<Manifest, 'receipt'> & { receipt: Receipt } {
  const counts: Partial<Record<PlaceholderClass, number>> = {};
  for (const finding of findings) {
    counts[finding.cls] = (counts[finding.cls] ?? 0) + 1;
  }

  const withPlaceholders = findings.map((finding) => {
    const placeholder = options.placeholders?.get(finding.id);
    return placeholder === undefined ? finding : { ...finding, placeholder };
  });

  const painted = ops.map((op) => op.box);
  const viewportArea = Math.max(1, options.viewport.w * options.viewport.h);
  const paintedArea = unionArea(painted);

  // Two different numbers, deliberately. How much of the page is hidden, and how much
  // of what we hid covered nothing anyone detected.
  const redactedFraction = clamp01(paintedArea / viewportArea);
  const detectedBoxes = findings.filter((f) => f.mode !== 'keep').map((f) => f.box);
  const overRedactedFraction =
    paintedArea === 0 ? 0 : clamp01(areaOutside(painted, detectedBoxes) / paintedArea);

  void kept;
  return {
    findings: withPlaceholders,
    counts,
    // How many indices are drawn on the frame. Not findings -- they are not redactions --
    // but the payload should say what is in the picture it carries.
    marks,
    redactedFraction,
    overRedactedFraction,
    policyVersion: options.policyVersion ?? POLICY_VERSION,
    receipt: {
      algo: 'SHA-256',
      hash: '',
      manifestHash: '',
      sealedAt: 0,
    },
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** SHA-256 over the canonicalised manifest, hex. The worker recomputes it. */
export async function manifestDigest(manifest: Omit<Manifest, 'receipt'>): Promise<string> {
  return digest(new TextEncoder().encode(canonicaliseFindings(manifest)));
}

/**
 * The canonical form. Deterministic by construction: fixed key order, findings sorted
 * by id, and every number formatted to a fixed precision so that 0.1 + 0.2 and 0.3
 * serialise identically.
 *
 * Two processes have to agree on this string, so nothing here may depend on object
 * insertion order or on the default number formatter.
 */
export function canonicaliseFindings(manifest: Omit<Manifest, 'receipt'>): string {
  const findings = [...manifest.findings]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((f) =>
      [
        f.id,
        f.cls,
        f.layer,
        f.mode,
        f.reason,
        f.placeholder ?? '',
        num(f.confidence),
        num(f.box.x),
        num(f.box.y),
        num(f.box.w),
        num(f.box.h),
      ].join('|'),
    );

  const counts = Object.keys(manifest.counts)
    .sort()
    .map((k) => `${k}=${String(manifest.counts[k as PlaceholderClass] ?? 0)}`);

  return [
    `v=${manifest.policyVersion}`,
    `rf=${num(manifest.redactedFraction)}`,
    `orf=${num(manifest.overRedactedFraction)}`,
    `counts=${counts.join(',')}`,
    `findings=${findings.join(';')}`,
  ].join('\n');
}

/** Six decimal places, always, so float noise cannot change the string. */
function num(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : '0.000000';
}

/** Total painted area in CSS px, for the trace and the eval. */
export function paintedArea(ops: PaintOp[]): number {
  return unionArea(ops.map((op) => op.box));
}

/** Exported for the eval harness: area of one box, in CSS px. */
export { area };
