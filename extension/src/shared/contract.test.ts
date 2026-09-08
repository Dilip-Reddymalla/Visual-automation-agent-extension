import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  ActionSchema,
  FindingSchema,
  PROTOCOL_VERSION,
  StepRequestSchema,
  StepResponseSchema,
} from './contract';

const hash = 'a'.repeat(64);

const receipt = {
  algo: 'SHA-256' as const,
  hash,
  manifestHash: 'b'.repeat(64),
  sealedAt: 1,
};

const finding = {
  id: 'f1',
  cls: 'AADHAAR' as const,
  box: { x: 10, y: 20, w: 200, h: 24 },
  layer: 'L1' as const,
  confidence: 0.99,
  mode: 'mask' as const,
  placeholder: '«AADHAAR_1»',
  reason: 'verhoeff-ok',
};

const request = {
  protocolVersion: PROTOCOL_VERSION,
  sessionId: 's1',
  stepIndex: 0,
  goal: 'renew the licence for «PERSON_1»',
  origin: 'http://localhost:8080',
  viewport: { w: 1280, h: 720 },
  capture: {
    mime: 'image/webp' as const,
    width: 2560,
    height: 1440,
    scale: 2,
    sha256: hash,
  },
  elements: [
    {
      index: 0,
      role: 'textbox' as const,
      name: 'Aadhaar number',
      box: { x: 10, y: 20, w: 200, h: 24 },
      state: { visible: true, enabled: true, focused: false },
    },
  ],
  manifest: {
    findings: [finding],
    counts: { AADHAAR: 1 },
    redactedFraction: 0.02,
    overRedactedFraction: 0,
    policyVersion: 'p1',
    receipt,
  },
};

describe('StepRequest', () => {
  it('accepts a well-formed request and fills defaults', () => {
    const parsed = StepRequestSchema.parse(request);
    expect(parsed.history).toEqual([]);
    expect(parsed.title).toBe('');
    expect(parsed.elements[0]?.occluded).toBe(0);
    expect(parsed.elements[0]?.fromPixels).toBe(false);
  });

  it('rejects an unknown top-level field', () => {
    expect(() => StepRequestSchema.parse({ ...request, url: 'http://x/y?id=42' })).toThrow();
  });

  it('rejects a protocol version it does not speak', () => {
    expect(() => StepRequestSchema.parse({ ...request, protocolVersion: 2 })).toThrow();
  });

  it('rejects a negative box size', () => {
    const bad = structuredClone(request);
    const first = bad.elements[0];
    if (!first) throw new Error('fixture lost its element');
    first.box.w = -5;
    expect(() => StepRequestSchema.parse(bad)).toThrow();
  });

  it('rejects a malformed receipt hash', () => {
    const bad = structuredClone(request);
    bad.manifest.receipt.hash = 'not-a-digest';
    expect(() => StepRequestSchema.parse(bad)).toThrow();
  });
});

describe('Finding', () => {
  it('parses the manifest form', () => {
    expect(FindingSchema.parse(finding).cls).toBe('AADHAAR');
  });

  it('has no way to carry the raw value -- an extra field is rejected', () => {
    expect(() => FindingSchema.parse({ ...finding, value: '2345 6789 0123' })).toThrow();
  });

  it('rejects a class outside the frozen vocabulary', () => {
    expect(() => FindingSchema.parse({ ...finding, cls: 'PINCODE' })).toThrow();
  });
});

describe('StepResponse', () => {
  const base = { protocolVersion: PROTOCOL_VERSION, stepIndex: 0 };

  it('accepts a minimal plan and fills defaults', () => {
    const parsed = StepResponseSchema.parse({
      ...base,
      actions: [{ type: 'click', index: 3 }],
    });
    expect(parsed.done).toBe(false);
    expect(parsed.rationale).toBe('');
  });

  it('keeps placeholders in typed text untouched', () => {
    const parsed = StepResponseSchema.parse({
      ...base,
      actions: [{ type: 'type', index: 1, text: '«AADHAAR_1»' }],
    });
    expect(parsed.actions[0]).toEqual({
      type: 'type',
      index: 1,
      text: '«AADHAAR_1»',
      submit: false,
    });
  });

  it('requires at least one action and caps the batch at four', () => {
    expect(() => StepResponseSchema.parse({ ...base, actions: [] })).toThrow();
    const five = Array.from({ length: 5 }, () => ({ type: 'click', index: 0 }));
    expect(() => StepResponseSchema.parse({ ...base, actions: five })).toThrow();
  });

  it('rejects an action type the executor does not implement', () => {
    expect(() => ActionSchema.parse({ type: 'eval', code: 'alert(1)' })).toThrow();
  });

  it('rejects an unknown field inside an action', () => {
    expect(() => ActionSchema.parse({ type: 'click', index: 1, force: true })).toThrow();
  });
});

describe('generated server schemas', () => {
  it('match contract.ts (run npm run schema:gen if this fails)', () => {
    const root = resolve(import.meta.dirname, '..', '..', '..');
    expect(() =>
      execFileSync(process.execPath, ['scripts/gen-schema.mjs', '--check'], {
        cwd: root,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});

// ── The documented examples ───────────────────────────────────────────────────

describe('the worked examples from the M7 prompt', () => {
  /**
   * The literals as they appear in the prompt, validated as written.
   *
   * The transport tests build requests from a real seal, which proves the pipeline
   * produces something valid. These prove the *documentation* still matches the
   * contract -- a different failure, and the one that bites when someone reads the
   * prompt six weeks from now and writes a server against it.
   *
   * Where a field name here differs from the prompt's sketch, the sketch was
   * illustrative and the schema is the contract; the differences are noted inline.
   */

  const DEVICE_TO_SERVER = {
    protocolVersion: 1,
    sessionId: 's_9f2c',
    stepIndex: 4,
    goal: 'Complete the scholarship application from my saved profile',
    // Origin only, never the full URL -- query strings routinely carry identifiers.
    origin: 'https://scholarships.gov.in',
    title: 'Application \u2014 \u00abORG_1\u00bb',
    viewport: { w: 1280, h: 720 },
    capture: {
      mime: 'image/webp' as const,
      width: 1024,
      height: 576,
      scale: 0.8,
      sha256: '3f1a'.padEnd(64, '0'),
    },
    elements: [
      {
        index: 4,
        role: 'textbox' as const,
        name: 'Full name',
        value: '\u00abPERSON_1\u00bb',
        box: { x: 220, y: 470, w: 380, h: 32 },
        state: { visible: true, enabled: true, focused: false, filled: true },
        occluded: 0,
        fromPixels: false,
        isNew: false,
      },
      {
        index: 6,
        role: 'textbox' as const,
        name: 'Email address',
        box: { x: 220, y: 530, w: 380, h: 32 },
        state: { visible: true, enabled: true, focused: false, filled: false, required: true },
        occluded: 0,
        fromPixels: false,
        isNew: false,
      },
    ],
    manifest: {
      findings: [
        {
          id: 'l0-aadhaar-220x470x380x32',
          cls: 'AADHAAR' as const,
          box: { x: 220, y: 470, w: 380, h: 32 },
          layer: 'L0' as const,
          confidence: 0.99,
          mode: 'mask' as const,
          placeholder: '\u00abAADHAAR_1\u00bb',
          reason: 'autocomplete-cc-number',
        },
      ],
      counts: { AADHAAR: 1, PERSON: 1, EMAIL: 2, SECRET: 1 },
      redactedFraction: 0.09,
      overRedactedFraction: 0.01,
      policyVersion: 'p1',
      receipt: {
        algo: 'SHA-256' as const,
        hash: '3f1a'.padEnd(64, '0'),
        manifestHash: '7b2c'.padEnd(64, '0'),
        sealedAt: 1_700_000_000_000,
      },
    },
    history: [{ stepIndex: 3, action: 'click [3]', outcome: 'ok' as const }],
  };

  const SERVER_TO_DEVICE = {
    protocolVersion: 1,
    stepIndex: 4,
    rationale:
      'Name and Aadhaar are already filled -- the manifest says both are redacted, not ' +
      'empty. Email at [6] is empty and [8] shows a validation error for it.',
    actions: [
      { type: 'type' as const, index: 6, text: '\u00abEMAIL_1\u00bb', submit: false },
      { type: 'click' as const, index: 9 },
    ],
    done: false,
  };

  it('validates the device-to-server example', () => {
    const parsed = StepRequestSchema.safeParse(DEVICE_TO_SERVER);
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3), null, 1)).toBe(
      true,
    );
  });

  it('validates the server-to-device example', () => {
    const parsed = StepResponseSchema.safeParse(SERVER_TO_DEVICE);
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3), null, 1)).toBe(
      true,
    );
  });

  it('carries no raw value anywhere in either example', () => {
    // The examples are documentation, and documentation gets copied. A plausible-looking
    // raw value in one of these would end up in somebody's test fixture.
    const both = JSON.stringify([DEVICE_TO_SERVER, SERVER_TO_DEVICE]);
    for (const raw of ['Asha Menon', '7237', 'hunter2', '@example.in']) {
      expect(both).not.toContain(raw);
    }
  });

  it('shows a filled field carrying a token and an empty one carrying none', () => {
    // The distinction the whole `filled` state exists for.
    const [filled, empty] = DEVICE_TO_SERVER.elements;
    expect(filled?.state.filled).toBe(true);
    expect(filled?.value).toBe('\u00abPERSON_1\u00bb');
    expect(empty?.state.filled).toBe(false);
    expect(empty).not.toHaveProperty('value');
  });

  it('only types into the empty field', () => {
    const typed = SERVER_TO_DEVICE.actions.filter((a) => a.type === 'type');
    expect(typed.map((a) => a.index)).toEqual([6]);
  });
});
