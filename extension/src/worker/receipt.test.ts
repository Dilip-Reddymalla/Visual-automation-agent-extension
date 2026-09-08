import { describe, it, expect } from 'vitest';
import { encode, seal, type SealOptions } from '../redaction/gate';
import { verifyReceipt, canonicalise } from './receipt';
import { checkerboard, createFakeBitmap, createFakeCanvas } from '../testing/fake-canvas';
import type { Finding, Manifest, Viewport } from '../shared/contract';

/**
 * The worker's half of invariant 1.
 *
 * These live here rather than beside the gate for a reason worth stating: the check
 * exists precisely because it is *not* the gate's own. A verification test that
 * imported only gate internals would be testing the gate's opinion of itself.
 */

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
  return { raw, ...(await seal(raw, findings, options(over))) };
}

describe('the receipt', () => {
  it('is completed by encode and verifies in the worker', async () => {
    const s = await sealed([finding()]);
    const { bytes } = await encode(s);
    await expect(verifyReceipt(bytes, s.manifest)).resolves.toEqual({ ok: true });
  });

  it('refuses a payload that never went through encode', async () => {
    const s = await sealed([finding()]);
    const result = await verifyReceipt(new Uint8Array([1, 2, 3]), s.manifest);
    expect(result).toMatchObject({ ok: false, reason: 'receipt-not-completed' });
  });

  it('refuses bytes that are not the ones that were sealed', async () => {
    const s = await sealed([finding()]);
    await encode(s);
    const result = await verifyReceipt(new Uint8Array([9, 9, 9]), s.manifest);
    expect(result).toMatchObject({ ok: false, reason: 'image-digest-mismatch' });
  });

  it('refuses a manifest edited after sealing', async () => {
    const s = await sealed([finding()]);
    const { bytes } = await encode(s);

    // Someone quietly widens a box, or drops a finding, between gate and transmission.
    const tampered: Manifest = {
      ...s.manifest,
      findings: s.manifest.findings.map((f) => ({ ...f, box: { ...f.box, w: 1 } })),
    };
    const result = await verifyReceipt(bytes, tampered);
    expect(result).toMatchObject({ ok: false, reason: 'manifest-digest-mismatch' });
  });

  it('lives only with its canvas', async () => {
    // A WeakMap, so there is no way to ask for "the receipt for these findings" --
    // only "the receipt for this canvas".
    const s = await sealed([finding()]);
    expect(s.receipt).toBe(s.manifest.receipt);
  });
});

describe('canonicalise', () => {
  it('excludes the receipt, which contains the hash of this very string', async () => {
    const s = await sealed([finding()]);
    expect(canonicalise(s.manifest)).not.toContain(s.receipt.manifestHash);
  });

  it('agrees with itself across two runs over the same findings', async () => {
    const a = await sealed([finding({ id: 'b' }), finding({ id: 'a', cls: 'PAN' })]);
    const b = await sealed([finding({ id: 'b' }), finding({ id: 'a', cls: 'PAN' })]);
    expect(canonicalise(a.manifest)).toBe(canonicalise(b.manifest));
  });
});
