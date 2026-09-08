import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  clearPanel,
  getStep,
  listSteps,
  panelSize,
  recordStep,
  PANEL_RING_CAPACITY,
  type PanelDeps,
} from './panel';
import type { Manifest } from '../shared/contract';
import type { FrameRef } from '../shared/frames';

/**
 * The panel holds the one thing in the extension that is deliberately unredacted, so
 * these tests are about when it lets go of it.
 */

const manifest = (findings = 0): Manifest => ({
  findings: Array.from({ length: findings }, (_, i) => ({
    id: `f${i}`,
    cls: 'AADHAAR' as const,
    box: { x: 0, y: 0, w: 10, h: 10 },
    layer: 'L1' as const,
    confidence: 0.98,
    mode: 'mask' as const,
    reason: 'verhoeff-ok',
    origin: 'page' as const,
  })),
  counts: {},
  marks: 0,
  redactedFraction: 0.1,
  overRedactedFraction: 0.01,
  policyVersion: 'p1',
  receipt: {
    algo: 'SHA-256' as const,
    hash: 'a'.repeat(64),
    manifestHash: 'b'.repeat(64),
    sealedAt: 0,
  },
});

const preGate: FrameRef = {
  kind: 'capture-tab',
  dataUrl: 'data:image/png;base64,AA',
  width: 10,
  height: 10,
  scale: 1,
};

function deps(): PanelDeps & { created: string[]; revoked: string[] } {
  const created: string[] = [];
  const revoked: string[] = [];
  let n = 0;
  return {
    created,
    revoked,
    createObjectUrl: () => {
      n += 1;
      const url = `blob:test/${n}`;
      created.push(url);
      return url;
    },
    revokeObjectUrl: (url: string) => void revoked.push(url),
  };
}

function record(d: PanelDeps, stepIndex: number, sessionId = 's1', findings = 1): void {
  recordStep(
    {
      sessionId,
      stepIndex,
      preGate,
      sent: new Blob(['x'], { type: 'image/webp' }),
      manifest: manifest(findings),
      capture: { width: 100, height: 80, scale: 1 },
    },
    d,
  );
}

beforeEach(() => {
  clearPanel({ createObjectUrl: () => '', revokeObjectUrl: () => undefined });
});

describe('the ring', () => {
  it('walks back through ten steps', () => {
    const d = deps();
    for (let i = 0; i < 10; i += 1) record(d, i);

    expect(panelSize()).toBe(10);
    expect(listSteps()).toHaveLength(10);
    // Newest first, which is the order a selector should offer them in.
    expect(listSteps()[0]?.stepIndex).toBe(9);
    expect(getStep(0)?.stepIndex).toBe(0);
  });

  it('drops the oldest beyond the cap, and revokes its url', () => {
    // Every entry pins a decoded frame. A panel that kept the whole session would cost
    // more than the model does.
    const d = deps();
    for (let i = 0; i < PANEL_RING_CAPACITY + 3; i += 1) record(d, i);

    expect(panelSize()).toBe(PANEL_RING_CAPACITY);
    expect(getStep(0)).toBeUndefined();
    expect(d.revoked).toHaveLength(3);
  });

  it('drops the previous session rather than mixing two', () => {
    const d = deps();
    record(d, 0, 's1');
    record(d, 1, 's1');
    record(d, 0, 's2');

    expect(panelSize()).toBe(1);
    expect(listSteps()[0]?.sessionId).toBe('s2');
    // Both of the first session's urls released, not just the one that fell off the end.
    expect(d.revoked).toHaveLength(2);
  });
});

describe('letting go', () => {
  it('revokes every url it created when the panel closes', () => {
    const d = deps();
    for (let i = 0; i < 4; i += 1) record(d, i);

    expect(clearPanel(d)).toBe(4);
    expect(panelSize()).toBe(0);
    expect([...d.revoked].sort()).toEqual([...d.created].sort());
  });

  it('does not revoke the pre-gate url, which it does not own', () => {
    // It was created for the capture and is released when that frame is. Revoking it
    // here would pull an image out from under whoever still holds it.
    const d = deps();
    record(d, 0);
    clearPanel(d);

    expect(d.revoked).not.toContain(preGate.kind === 'capture-tab' ? preGate.dataUrl : '');
  });

  it('holds nothing after a clear', () => {
    const d = deps();
    record(d, 0);
    clearPanel(d);

    expect(listSteps()).toEqual([]);
    expect(getStep(0)).toBeUndefined();
  });
});

describe('what the selector is told', () => {
  it('lists counts, not frames', () => {
    const d = deps();
    record(d, 3, 's1', 7);

    const listed = listSteps();
    expect(listed[0]?.findings).toBe(7);
    expect(JSON.stringify(listed)).not.toContain('data:image');
    expect(JSON.stringify(listed)).not.toContain('blob:');
  });
});

describe('recording', () => {
  it('keeps the sent bytes as an object url and remembers the mime', () => {
    const d = deps();
    const spy = vi.spyOn(d, 'createObjectUrl');
    record(d, 0);

    expect(spy).toHaveBeenCalledOnce();
    expect(getStep(0)?.sentMime).toBe('image/webp');
    expect(getStep(0)?.sentUrl).toBe(d.created[0]);
  });
});
