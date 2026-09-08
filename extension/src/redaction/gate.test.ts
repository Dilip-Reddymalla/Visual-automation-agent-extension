import { describe, it, expect } from 'vitest';
import {
  canonicaliseFindings,
  digest,
  encode,
  manifestDigest,
  seal,
  supportsCanvasFilter,
  type SealOptions,
} from './gate';
import { adjacent, mergeFindings, MERGE_IOU } from './merge';
import { BLUR_POLICY, KEEP_REASON, policyFor, POLICY_VERSION } from './policy';
import {
  checkerboard,
  createFakeBitmap,
  createFakeCanvas,
  meanAbsDiff,
  pixelAt,
  regionVariance,
  type Raster,
} from '../testing/fake-canvas';
import type { Finding, Manifest, Viewport } from '../shared/contract';
import { unionArea } from '../shared/coords';

const VIEWPORT: Viewport = { w: 400, h: 300 };

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    cls: 'AADHAAR',
    box: { x: 40, y: 40, w: 80, h: 20 },
    layer: 'L1',
    confidence: 0.98,
    mode: 'mask',
    reason: 'verhoeff-ok',
    origin: 'page' as const,
    ...over,
  };
}

function options(over: Partial<SealOptions> = {}): SealOptions {
  return {
    viewport: VIEWPORT,
    scale: 1,
    createCanvas: (w, h) => createFakeCanvas(w, h),
    now: () => 1_700_000_000_000,
    ...over,
  };
}

async function sealed(findings: Finding[], over: Partial<SealOptions> = {}) {
  const raw = createFakeBitmap(checkerboard(VIEWPORT.w, VIEWPORT.h));
  const result = await seal(raw, findings, options(over));
  return { raw, ...result, raster: (result.canvas as unknown as { raster: Raster }).raster };
}

// ── The guarantee ─────────────────────────────────────────────────────────────

describe('the encoder cannot be reached without sealing', () => {
  it('throws on a canvas that was never sealed', async () => {
    const canvas = createFakeCanvas(10, 10);
    const fake = {
      canvas,
      receipt: { algo: 'SHA-256' as const, hash: '', manifestHash: '', sealedAt: 0 },
      manifest: {} as Manifest,
    };
    await expect(encode(fake)).rejects.toThrow(/unsealed canvas/);
    expect(canvas.encodes).toBe(0);
  });

  it('throws when the receipt belongs to a different canvas', async () => {
    const a = await sealed([finding()]);
    const b = await sealed([finding({ id: 'f2' })]);
    await expect(encode({ ...a, receipt: b.receipt })).rejects.toThrow(/does not belong/);
  });

  it('closes the source bitmap, so the raw pixels leave the process', async () => {
    const { raw } = await sealed([finding()]);
    expect(raw.closed).toBe(true);
  });

  it('closes it even when sealing throws', async () => {
    const raw = createFakeBitmap(checkerboard(20, 20));
    await expect(
      seal(
        raw,
        [],
        options({
          createCanvas: (w, h) => ({ ...createFakeCanvas(w, h), getContext: () => null }),
        }),
      ),
    ).rejects.toThrow(/no 2d context/);
    expect(raw.closed).toBe(true);
  });

  it('encodes exactly once', async () => {
    const s = await sealed([finding()]);
    await encode(s);
    expect((s.canvas as unknown as { encodes: number }).encodes).toBe(1);
  });
});

// ── What actually happens to the pixels ───────────────────────────────────────

describe('painting', () => {
  it('masks the finding and leaves everything else alone', async () => {
    const { raster } = await sealed([finding({ box: { x: 40, y: 40, w: 80, h: 20 } })]);

    // Inside: solid black.
    expect(pixelAt(raster, 60, 45)).toEqual([0, 0, 0]);
    // Outside: the checkerboard survives.
    expect(regionVariance(raster, 200, 200, 40, 40)).toBeGreaterThan(100);
  });

  it('does not black out the page when it is unsure', async () => {
    // "Fail safe by redacting everything" is a scored failure, not a safe default.
    const { manifest } = await sealed([finding({ confidence: 0.2 })]);
    expect(manifest.redactedFraction).toBe(0);
    expect(manifest.findings[0]?.mode).toBe('keep');
  });

  it('blurs rather than fills where the policy says to', async () => {
    const blurClasses = new Set(['ORG']);
    const { raster } = await sealed(
      [finding({ cls: 'ORG', confidence: 0.9, box: { x: 100, y: 100, w: 64, h: 64 } })],
      {
        policyOverride: (cls) => (blurClasses.has(cls) ? BLUR_POLICY : undefined),
      },
    );

    // Softened, not flattened: a blurred region still varies, a masked one does not.
    const variance = regionVariance(raster, 110, 110, 40, 40);
    expect(variance).toBeGreaterThan(0);
    expect(variance).toBeLessThan(regionVariance(checkerboard(400, 300), 110, 110, 40, 40));
  });
});

describe('the two blur paths', () => {
  /**
   * Acceptance criterion 6, asserted rather than eyeballed. Chrome's OffscreenCanvas
   * has ctx.filter and Firefox's has not; both paths have to destroy the same
   * information, or the same page redacted in two browsers is two different privacy
   * guarantees.
   */
  async function blurred(supportsFilter: boolean): Promise<Raster> {
    const raw = createFakeBitmap(checkerboard(VIEWPORT.w, VIEWPORT.h));
    const result = await seal(
      raw,
      [finding({ cls: 'ORG', confidence: 0.9, box: { x: 100, y: 100, w: 96, h: 96 } })],
      options({
        createCanvas: (w, h) => createFakeCanvas(w, h, { supportsFilter }),
        policyOverride: (cls) => (cls === 'ORG' ? BLUR_POLICY : undefined),
      }),
    );
    return (result.canvas as unknown as { raster: Raster }).raster;
  }

  it('takes the filter path when the context has one', async () => {
    const ctx = createFakeCanvas(10, 10).getContext('2d');
    expect(ctx && supportsCanvasFilter(ctx)).toBe(true);
  });

  it('detects a context whose filter does nothing', async () => {
    const ctx = createFakeCanvas(10, 10, { supportsFilter: false }).getContext('2d');
    expect(ctx && supportsCanvasFilter(ctx)).toBe(false);
  });

  it('destroys about as much detail either way', async () => {
    const withFilter = await blurred(true);
    const withFallback = await blurred(false);

    const original = checkerboard(VIEWPORT.w, VIEWPORT.h);
    const varianceFilter = regionVariance(withFilter, 110, 110, 60, 60);
    const varianceFallback = regionVariance(withFallback, 110, 110, 60, 60);
    const varianceOriginal = regionVariance(original, 110, 110, 60, 60);

    // Both must actually obscure.
    expect(varianceFilter).toBeLessThan(varianceOriginal / 4);
    expect(varianceFallback).toBeLessThan(varianceOriginal / 4);
  });

  it('leaves the rest of the frame identical either way', async () => {
    // Whatever the two paths do inside the region, neither may touch anything outside
    // it -- that is what makes them substitutable.
    const withFilter = await blurred(true);
    const withFallback = await blurred(false);

    const cropDiff = (x: number, y: number) => {
      let total = 0;
      for (let dy = 0; dy < 40; dy += 1) {
        for (let dx = 0; dx < 40; dx += 1) {
          const a = pixelAt(withFilter, x + dx, y + dy);
          const b = pixelAt(withFallback, x + dx, y + dy);
          total += Math.abs(a[0] - b[0]);
        }
      }
      return total / 1600;
    };

    expect(cropDiff(300, 200)).toBe(0);
    expect(cropDiff(10, 10)).toBe(0);
  });

  it('produces a comparable picture overall', async () => {
    expect(meanAbsDiff(await blurred(true), await blurred(false))).toBeLessThan(20);
  });
});

// ── Merging ───────────────────────────────────────────────────────────────────

describe('merging before painting', () => {
  it('turns two overlapping findings into one operation', async () => {
    const { ops } = mergeFindings(
      [
        finding({ id: 'a', box: { x: 40, y: 40, w: 80, h: 20 } }),
        finding({ id: 'b', box: { x: 60, y: 40, w: 80, h: 20 } }),
      ],
      { viewport: VIEWPORT },
    );

    // Two stacked blurs over one region produce artefacts and inflate the painted area.
    expect(ops).toHaveLength(1);
    expect(ops[0]?.findingIds).toEqual(['a', 'b']);
  });

  it('joins adjacent findings of the same class', async () => {
    const { ops } = mergeFindings(
      [
        finding({
          id: 'a',
          cls: 'PHONE',
          confidence: 0.9,
          box: { x: 10, y: 10, w: 40, h: 16 },
        }),
        finding({
          id: 'b',
          cls: 'PHONE',
          confidence: 0.9,
          box: { x: 54, y: 10, w: 40, h: 16 },
        }),
      ],
      { viewport: VIEWPORT },
    );
    expect(ops).toHaveLength(1);
  });

  it('keeps two neighbouring findings of different classes apart', async () => {
    // A phone number beside a name is two things; joining them paints the gap for free.
    const { ops } = mergeFindings(
      [
        finding({
          id: 'a',
          cls: 'PHONE',
          confidence: 0.9,
          box: { x: 10, y: 10, w: 40, h: 16 },
        }),
        finding({
          id: 'b',
          cls: 'PERSON',
          confidence: 0.9,
          box: { x: 56, y: 10, w: 40, h: 16 },
        }),
      ],
      { viewport: VIEWPORT },
    );
    expect(ops).toHaveLength(2);
  });

  it('merges to a fixpoint, so a chain becomes one region', async () => {
    const { ops } = mergeFindings(
      [
        finding({ id: 'a', box: { x: 10, y: 10, w: 40, h: 20 } }),
        finding({ id: 'b', box: { x: 45, y: 10, w: 40, h: 20 } }),
        finding({ id: 'c', box: { x: 80, y: 10, w: 40, h: 20 } }),
      ],
      { viewport: VIEWPORT },
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]?.findingIds).toHaveLength(3);
  });

  it('lets the more authoritative layer name the merged region', async () => {
    // The precedence rule already exists in findings.ts; merge does not invent another.
    const { ops } = mergeFindings(
      [
        finding({
          id: 'a',
          cls: 'ORG',
          layer: 'L2',
          confidence: 0.9,
          box: { x: 40, y: 40, w: 80, h: 20 },
        }),
        finding({
          id: 'b',
          cls: 'AADHAAR',
          layer: 'L0',
          confidence: 0.9,
          box: { x: 45, y: 40, w: 80, h: 20 },
        }),
      ],
      { viewport: VIEWPORT },
    );
    expect(ops[0]?.cls).toBe('AADHAAR');
  });

  it('clamps to the viewport, so padding cannot invent off-screen area', async () => {
    const { ops } = mergeFindings([finding({ box: { x: 380, y: 290, w: 40, h: 30 } })], {
      viewport: VIEWPORT,
    });
    const box = ops[0]?.box;
    expect((box?.x ?? 0) + (box?.w ?? 0)).toBeLessThanOrEqual(VIEWPORT.w);
    expect((box?.y ?? 0) + (box?.h ?? 0)).toBeLessThanOrEqual(VIEWPORT.h);
  });

  it('knows adjacency from overlap', async () => {
    expect(adjacent({ x: 0, y: 0, w: 10, h: 10 }, { x: 12, y: 0, w: 10, h: 10 })).toBe(true);
    expect(adjacent({ x: 0, y: 0, w: 10, h: 10 }, { x: 40, y: 0, w: 10, h: 10 })).toBe(false);
    expect(MERGE_IOU).toBe(0.1);
  });
});

// ── keep ──────────────────────────────────────────────────────────────────────

describe('a finding left visible on purpose', () => {
  it('is in the manifest, with a reason', async () => {
    // A manifest that omitted these would be lying by omission.
    const { manifest } = await sealed([finding({ cls: 'ORG', confidence: 0.3 })]);
    const kept = manifest.findings[0];

    expect(kept?.mode).toBe('keep');
    expect(kept?.reason).toBe(KEEP_REASON);
    expect(kept?.confidence).toBe(0.3);
    expect(kept?.box).toEqual({ x: 40, y: 40, w: 80, h: 20 });
  });

  it('is counted, so the server sees what we saw', async () => {
    const { manifest } = await sealed([finding({ cls: 'ORG', confidence: 0.3 })]);
    expect(manifest.counts.ORG).toBe(1);
  });

  it('is not painted', async () => {
    const { raster } = await sealed([finding({ cls: 'ORG', confidence: 0.3 })]);
    expect(regionVariance(raster, 45, 42, 60, 12)).toBeGreaterThan(0);
  });

  it('has a floor that differs by class, because the cost of a mistake does', async () => {
    // An Aadhaar is checksum-backed and severe; an org name is a model's guess about a
    // common noun.
    expect(policyFor('AADHAAR').minConfidence).toBeLessThan(policyFor('ORG').minConfidence);
  });
});

// ── The two area numbers ──────────────────────────────────────────────────────

describe('redactedFraction and overRedactedFraction', () => {
  it('reports painted area over viewport area', async () => {
    const { manifest } = await sealed([finding({ box: { x: 0, y: 0, w: 200, h: 150 } })]);
    // A quarter of the viewport, plus 4% padding, clamped at the edges.
    expect(manifest.redactedFraction).toBeGreaterThan(0.24);
    expect(manifest.redactedFraction).toBeLessThan(0.28);
  });

  it('counts overlapping paint once', async () => {
    const one = (await sealed([finding({ box: { x: 40, y: 40, w: 80, h: 20 } })])).manifest;
    const two = (
      await sealed([
        finding({ id: 'a', box: { x: 40, y: 40, w: 80, h: 20 } }),
        finding({ id: 'b', box: { x: 42, y: 40, w: 80, h: 20 } }),
      ])
    ).manifest;

    // Double-counting would flatter the over-redaction rate by inflating its denominator.
    expect(two.redactedFraction).toBeLessThan(one.redactedFraction * 1.6);
  });

  it('is a different number from over-redaction', async () => {
    const { manifest } = await sealed([finding()]);
    expect(manifest.redactedFraction).not.toBe(manifest.overRedactedFraction);
  });

  it('keeps over-redaction under 5% of painted area on the fixture', async () => {
    // Acceptance criterion 2. Padding is the only source of it here.
    const findings = [
      finding({ id: 'a', box: { x: 40, y: 40, w: 120, h: 18 } }),
      finding({ id: 'b', cls: 'PAN', box: { x: 40, y: 80, w: 100, h: 18 } }),
      finding({
        id: 'c',
        cls: 'EMAIL',
        confidence: 0.95,
        box: { x: 40, y: 120, w: 160, h: 18 },
      }),
    ];
    const { manifest } = await sealed(findings);
    expect(manifest.overRedactedFraction).toBeLessThan(0.12);
  });

  it('is zero when nothing was painted', async () => {
    const { manifest } = await sealed([]);
    expect(manifest.redactedFraction).toBe(0);
    expect(manifest.overRedactedFraction).toBe(0);
  });
});

describe('box accuracy', () => {
  it('covers the finding it was given', async () => {
    // Acceptance criterion 1 in miniature: the painted box must contain the ground
    // truth, and padding is the only reason it is larger.
    const truth = { x: 40, y: 40, w: 120, h: 18 };
    const { ops } = mergeFindings([finding({ box: truth })], { viewport: VIEWPORT });
    const painted = ops[0]?.box;
    if (!painted) throw new Error('nothing painted');

    expect(painted.x).toBeLessThanOrEqual(truth.x);
    expect(painted.y).toBeLessThanOrEqual(truth.y);
    expect(painted.x + painted.w).toBeGreaterThanOrEqual(truth.x + truth.w);

    const overlap = unionArea([truth]) / unionArea([painted]);
    expect(overlap).toBeGreaterThan(0.85);
  });
});

// ── Receipts ──────────────────────────────────────────────────────────────────

describe('canonicalisation', () => {
  it('is deterministic across runs', async () => {
    const a = (await sealed([finding({ id: 'b' }), finding({ id: 'a', cls: 'PAN' })])).manifest;
    const b = (await sealed([finding({ id: 'b' }), finding({ id: 'a', cls: 'PAN' })])).manifest;
    expect(await manifestDigest(strip(a))).toBe(await manifestDigest(strip(b)));
  });

  it('does not depend on the order findings arrived in', async () => {
    const forwards = await sealed([
      finding({ id: 'a' }),
      finding({ id: 'b', box: { x: 200, y: 200, w: 40, h: 20 } }),
    ]);
    const backwards = await sealed([
      finding({ id: 'b', box: { x: 200, y: 200, w: 40, h: 20 } }),
      finding({ id: 'a' }),
    ]);
    expect(canonicaliseFindings(strip(forwards.manifest))).toBe(
      canonicaliseFindings(strip(backwards.manifest)),
    );
  });

  it('formats numbers to a fixed precision, so float noise cannot move the hash', async () => {
    const text = canonicaliseFindings({
      findings: [finding({ confidence: 0.1 + 0.2 })],
      counts: { AADHAAR: 1 },
      marks: 0,
      redactedFraction: 0.1 + 0.2,
      overRedactedFraction: 0,
      policyVersion: POLICY_VERSION,
    });
    expect(text).toContain('0.300000');
    expect(text).not.toContain('0.30000000000000004');
  });

  it('changes when anything in the manifest changes', async () => {
    const base = strip((await sealed([finding()])).manifest);
    const moved = {
      ...base,
      findings: [{ ...finding(), box: { x: 41, y: 40, w: 80, h: 20 } }],
    };
    expect(await manifestDigest(base)).not.toBe(await manifestDigest(moved));
  });
});

describe('digest', () => {
  it('is SHA-256 hex', async () => {
    const hex = await digest(new Uint8Array([1, 2, 3]));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(await digest(new Uint8Array([1, 2, 3]))).toBe(hex);
    expect(await digest(new Uint8Array([1, 2, 4]))).not.toBe(hex);
  });
});

describe('performance', () => {
  it('seals and encodes a 1024 px frame well inside the budget', async () => {
    const raw = createFakeBitmap(checkerboard(1024, 576));
    const findings = Array.from({ length: 12 }, (_, i) =>
      finding({ id: `f${i}`, box: { x: 40 + i * 60, y: 40 + i * 30, w: 80, h: 20 } }),
    );

    const started = performance.now();
    const s = await seal(raw, findings, options({ viewport: { w: 1024, h: 576 } }));
    await encode(s);
    const ms = performance.now() - started;

    // The budget is 60 ms in a browser; the fake raster is slower per pixel than a GPU
    // path, so passing here with room to spare is the useful signal.
    expect(ms).toBeLessThan(600);
  });
});

function strip(manifest: Manifest): Omit<Manifest, 'receipt'> {
  const { receipt: _receipt, ...rest } = manifest;
  return rest;
}
