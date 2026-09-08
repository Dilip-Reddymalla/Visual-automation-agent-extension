import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ObservedElement } from '../shared/observed';
import type { DetectionLayer, Viewport } from '../shared/contract';
import { detectStructural } from './l0-structural';
import { detectLexical, disqualifiedByCaption, scanText } from './l1-lexical';
import { findingId, makeFinding, strongerDraft } from './findings';

interface Fixture {
  valid: Array<{ cls: string; text: string; needsContext?: boolean }>;
  negatives: Array<{ text: string; why: string }>;
}

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'eval', 'corpus', 'identifiers.json'), 'utf8'),
) as Fixture;

const VIEWPORT: Viewport = { w: 1280, h: 720 };

function element(over: Partial<ObservedElement> = {}): ObservedElement {
  return {
    index: 1,
    role: 'textbox',
    box: { x: 10, y: 20, w: 200, h: 30 },
    state: { visible: true, enabled: true, focused: false, filled: false },
    occluded: 0,
    isNew: false,
    tag: 'input',
    key: 'k',
    name: '',
    textRuns: [],
    ...over,
  };
}

function textElement(text: string, over: Partial<ObservedElement> = {}): ObservedElement {
  return element({
    tag: 'div',
    role: 'text',
    textRuns: [{ text, box: { x: 10, y: 20, w: 300, h: 18 }, nodeIndex: 0 }],
    ...over,
  });
}

// ── L0 ────────────────────────────────────────────────────────────────────────

describe('L0, structural', () => {
  it("reads the site's own autocomplete declaration", () => {
    const drafts = detectStructural(
      [
        element({ autocomplete: 'cc-number', rawValue: '4111111111111111' }),
        element({ autocomplete: 'shipping street-address', rawValue: '14 Rose Villa' }),
        element({ autocomplete: 'bday', rawValue: '1999-04-17' }),
      ],
      VIEWPORT,
    );

    expect(drafts.map((d) => d.cls)).toEqual(['CARD', 'ADDRESS', 'DOB']);
    expect(drafts[0]?.confidence).toBeGreaterThan(0.98);
    expect(drafts[0]?.reason).toBe('autocomplete-cc-number');
  });

  it('catches a password field', () => {
    const [draft] = detectStructural(
      [element({ inputType: 'password', rawValue: 'hunter2' })],
      VIEWPORT,
    );
    expect(draft?.cls).toBe('SECRET');
    expect(draft?.value).toBe('hunter2');
  });

  it('catches a text field disguised as one with CSS', () => {
    // type=text plus -webkit-text-security: dots on screen, plain text in the DOM.
    const [draft] = detectStructural(
      [element({ inputType: 'text', textSecurity: 'disc', rawValue: '4321' })],
      VIEWPORT,
    );
    expect(draft?.cls).toBe('SECRET');
    expect(draft?.reason).toBe('text-security');
  });

  it('reads Indian field names, in English and Hindi', () => {
    const cases: Array<[Partial<ObservedElement>, string]> = [
      [{ labelText: 'Aadhaar Number' }, 'AADHAAR'],
      [{ labelText: 'आधार संख्या' }, 'AADHAAR'],
      [{ nameAttr: 'uid_no' }, 'AADHAAR'],
      [{ labelText: 'PAN' }, 'PAN'],
      [{ labelText: 'GSTIN' }, 'GSTIN'],
      [{ labelText: 'IFSC Code' }, 'IFSC'],
      [{ labelText: 'UPI ID' }, 'UPI'],
      [{ labelText: 'Bank account number' }, 'ACCOUNT'],
      [{ labelText: "Father's Name" }, 'PERSON'],
      [{ labelText: 'जन्म तिथि' }, 'DOB'],
      [{ labelText: 'Janm Tithi' }, 'DOB'],
      [{ labelText: 'Pincode' }, 'ADDRESS'],
      [{ labelText: 'Mobile Number' }, 'PHONE'],
      [{ labelText: 'मोबाइल' }, 'PHONE'],
      [{ labelText: 'OTP' }, 'SECRET'],
    ];

    for (const [over, expected] of cases) {
      const [draft] = detectStructural([element({ ...over, rawValue: 'x' })], VIEWPORT);
      expect(draft?.cls, `${JSON.stringify(over)} should be ${expected}`).toBe(expected);
    }
  });

  it('normalises separators, so name="aadhaar_no" reads like a label', () => {
    const [draft] = detectStructural(
      [element({ nameAttr: 'aadhaar_no', rawValue: 'x' })],
      VIEWPORT,
    );
    expect(draft?.cls).toBe('AADHAAR');
  });

  it('reports an empty sensitive field, at lower confidence', () => {
    // The box still has to be covered before the user types into it.
    const [draft] = detectStructural([element({ inputType: 'password' })], VIEWPORT);
    expect(draft?.cls).toBe('SECRET');
    expect(draft?.confidence).toBeLessThanOrEqual(0.75);
    expect(draft?.reason).toBe('input-type-password-empty');
    expect(draft?.value).toBeUndefined();
  });

  it('prefers the stronger signal when several fire', () => {
    // autocomplete outranks a label: the site declared it, we only inferred the label.
    const [draft] = detectStructural(
      [element({ autocomplete: 'email', labelText: 'Aadhaar number', rawValue: 'a@b.in' })],
      VIEWPORT,
    );
    expect(draft?.cls).toBe('EMAIL');
  });

  it('says nothing about an ordinary field', () => {
    expect(detectStructural([element({ labelText: 'Search schemes' })], VIEWPORT)).toEqual([]);
  });

  it('never puts the value on a draft it did not read one from', () => {
    const drafts = detectStructural([element({ labelText: 'Aadhaar number' })], VIEWPORT);
    expect(drafts[0]?.value).toBeUndefined();
  });
});

// ── L1 ────────────────────────────────────────────────────────────────────────

describe('L1, checksums', () => {
  it('finds each class in running text', () => {
    const found = scanText('Aadhaar 7237 2429 6561 and PAN AAAPA1234C on file');
    expect(found.map((m) => m.cls).sort()).toEqual(['AADHAAR', 'PAN']);
  });

  it('does not report the same span twice', () => {
    // A GSTIN contains a PAN. Whichever pattern claims the span first keeps it.
    const gstin = fixture.valid.find((v) => v.cls === 'GSTIN')?.text ?? '';
    const found = scanText(`GSTIN ${gstin}`);
    expect(found).toHaveLength(1);
    expect(found[0]?.cls).toBe('GSTIN');
  });

  it('reports where in the string it found the match', () => {
    const [match] = scanText('ref: asha.menon@example.in');
    expect(match?.start).toBe(5);
    expect(match?.end).toBe(26);
    expect(match?.text).toBe('asha.menon@example.in');
  });
});

describe('L1 class boundaries', () => {
  it('calls an ordinary address an email, not a UPI handle', () => {
    // Identical shapes; only the suffix separates them, which is why the PSP list
    // exists. Detecting it as EMAIL is right -- an email address is PII too.
    const found = scanText('write to name@company.com');
    expect(found.map((m) => m.cls)).toEqual(['EMAIL']);
  });

  it('calls a VPA a VPA', () => {
    expect(scanText('pay ravi@ybl').map((m) => m.cls)).toEqual(['UPI']);
  });

  it('does not pull a phone number out of a longer digit run', () => {
    // A sixteen-digit string contains a ten-digit substring starting with 7. Word
    // boundaries do not exist between two digits, so the guard has to be explicit.
    expect(scanText('1234567890123456')).toEqual([]);
  });

  it('keeps an email that follows a reference label', () => {
    // The "Invoice no." rule is for things that are only digits. An email after "Ref:"
    // is still an email.
    expect(scanText('Ref: asha.menon@example.in').map((m) => m.cls)).toEqual(['EMAIL']);
  });

  it('needs a label for an IFSC whose bank is not on the shipped list', () => {
    expect(scanText('ZZZZ0123456')).toEqual([]);
    expect(scanText('IFSC: ZZZZ0123456').map((m) => m.cls)).toEqual(['IFSC']);
    expect(scanText('HDFC0001234').map((m) => m.cls)).toEqual(['IFSC']);
  });
});

describe('L1 context rules', () => {
  it('rejects a Verhoeff-valid number labelled as an invoice', () => {
    // About one random twelve-digit string in ten passes Verhoeff. The label is better
    // evidence than the arithmetic, and this is where the precision metric is won.
    const invoice =
      fixture.negatives.find((n) => n.why.startsWith('verhoeff-valid'))?.text ?? '';
    expect(scanText(invoice)).toEqual([]);
  });

  it('rejects a currency amount that looks like a mobile number', () => {
    expect(scanText('INR 9845012345.00')).toEqual([]);
  });

  it('requires a label before calling digits an account number', () => {
    expect(scanText('50100234567890')).toEqual([]);
    expect(scanText('Account number 50100234567890').map((m) => m.cls)).toEqual(['ACCOUNT']);
  });

  it('requires a label before calling a date a birthday', () => {
    expect(scanText('Valid until 31/12/2030')).toEqual([]);
    expect(scanText('Issued on 01/04/2024')).toEqual([]);
    expect(scanText('DOB: 17/04/1999').map((m) => m.cls)).toEqual(['DOB']);
  });

  it('disqualifies a DOB span whose caption says the date is not a birthday', () => {
    // L2 maps any DATE label to DOB, so the caption is the only thing standing
    // between "Filed on 04/07/2023" and a redaction box over a non-personal date.
    expect(disqualifiedByCaption('Filed on ', '', 'DOB')).toBe(true);
    expect(disqualifiedByCaption('Issue date: ', '', 'DOB')).toBe(true);
    expect(disqualifiedByCaption('Valid until ', '', 'DOB')).toBe(true);
    expect(disqualifiedByCaption('Payment date : ', '', 'DOB')).toBe(true);

    // A genuine birthday caption survives the rule.
    expect(disqualifiedByCaption('Date of birth: ', '', 'DOB')).toBe(false);
    expect(disqualifiedByCaption('Born ', '', 'DOB')).toBe(false);

    // The rule is caption-wide: it still refuses identifier labels, but a genuine
    // "Aadhaar number" label is what lets the value survive, not what kills it.
    expect(disqualifiedByCaption('Invoice no. ', '', 'AADHAAR')).toBe(true);
    expect(disqualifiedByCaption('Aadhaar number ', '', 'AADHAAR')).toBe(false);
  });
});

describe('L1 over elements', () => {
  it('reads a field value and a text run alike', () => {
    const aadhaar = fixture.valid.find((v) => v.cls === 'AADHAAR')?.text ?? '';
    const drafts = detectLexical(
      [element({ rawValue: aadhaar }), textElement(`Aadhaar on record: ${aadhaar}`)],
      VIEWPORT,
    );
    expect(drafts).toHaveLength(2);
    expect(drafts.every((d) => d.cls === 'AADHAAR')).toBe(true);
    expect(drafts.every((d) => d.layer === 'L1')).toBe(true);
  });

  it('boxes a text run at the run, and a field value at the field', () => {
    const aadhaar = fixture.valid.find((v) => v.cls === 'AADHAAR')?.text ?? '';
    const [fromValue] = detectLexical([element({ rawValue: aadhaar })], VIEWPORT);
    const [fromRun] = detectLexical([textElement(aadhaar)], VIEWPORT);

    expect(fromValue?.box).toEqual({ x: 10, y: 20, w: 200, h: 30 });
    expect(fromRun?.box).toEqual({ x: 10, y: 20, w: 300, h: 18 });
  });

  it('carries the value on the draft, and the span with it', () => {
    const drafts = detectLexical(
      [textElement('write to asha.menon@example.in today')],
      VIEWPORT,
    );
    expect(drafts[0]?.value).toBe('asha.menon@example.in');
    expect(drafts[0]?.textSpan).toEqual([9, 30]);
  });

  it('does not scan labels -- "Aadhaar number" is not an Aadhaar number', () => {
    const drafts = detectLexical(
      [element({ labelText: 'Aadhaar number', placeholder: 'Enter 12 digits' })],
      VIEWPORT,
    );
    expect(drafts).toEqual([]);
  });
});

// ── The acceptance gate ───────────────────────────────────────────────────────

describe('Session A acceptance: precision and recall', () => {
  /**
   * The whole fixture at once: every valid identifier must be found, and none of the
   * sixty hard negatives may fire. Precision is the number that matters -- over-firing
   * on invoice numbers loses the redaction metric while gaining nothing.
   */
  function run() {
    let truePositives = 0;
    let falseNegatives = 0;
    const missed: string[] = [];

    for (const item of fixture.valid) {
      const found = scanText(item.text).some((m) => m.cls === item.cls);
      if (found) truePositives += 1;
      else {
        falseNegatives += 1;
        missed.push(`${item.cls}: ${item.text}`);
      }
    }

    let falsePositives = 0;
    const spurious: string[] = [];
    for (const item of fixture.negatives) {
      const found = scanText(item.text);
      if (found.length > 0) {
        falsePositives += found.length;
        spurious.push(`${item.text} -> ${found.map((f) => f.cls).join(',')} (${item.why})`);
      }
    }

    return { truePositives, falseNegatives, falsePositives, missed, spurious };
  }

  it('finds the identifiers and refuses the decoys', () => {
    const r = run();
    const precision = r.truePositives / (r.truePositives + r.falsePositives);
    const recall = r.truePositives / (r.truePositives + r.falseNegatives);

    // Reported on failure, because "precision 0.94" is useless without the offenders.
    expect(r.spurious, `false positives:\n${r.spurious.join('\n')}`).toEqual([]);
    expect(precision).toBeGreaterThanOrEqual(0.97);
    expect(recall, `missed:\n${r.missed.join('\n')}`).toBeGreaterThanOrEqual(0.75);
  });

  it('runs in well under 10 ms with no model loaded', () => {
    const all = [...fixture.valid.map((v) => v.text), ...fixture.negatives.map((n) => n.text)];
    const started = performance.now();
    for (const text of all) scanText(text);
    const ms = performance.now() - started;

    expect(ms).toBeLessThan(10);
  });
});

// ── Findings ──────────────────────────────────────────────────────────────────

describe('findings', () => {
  it('drops the value on the way to the wire', () => {
    const finding = makeFinding(
      {
        cls: 'AADHAAR',
        box: { x: 1, y: 2, w: 3, h: 4 },
        layer: 'L1',
        confidence: 0.98,
        reason: 'verhoeff-ok',
        value: '723724296561',
      },
      '«AADHAAR_1»',
    );

    expect(JSON.stringify(finding)).not.toContain('723724296561');
    expect(finding.placeholder).toBe('«AADHAAR_1»');
  });

  it('gives the same value in the same place the same id across steps', () => {
    const a = findingId('PAN', { x: 10.2, y: 20.4, w: 100.1, h: 30.9 }, 'L1');
    const b = findingId('PAN', { x: 10.4, y: 20.1, w: 100.3, h: 31.2 }, 'L1');
    // Sub-pixel reflow must not produce a new id, or the side-by-side view flickers.
    expect(a).toBe(b);
  });

  it('does not derive the id from the value', () => {
    // A hash of an Aadhaar number is still an Aadhaar number to anyone with a table.
    const id = findingId('AADHAAR', { x: 0, y: 0, w: 10, h: 10 }, 'L1');
    expect(id).toBe('l1-aadhaar-0x0x10x10');
  });

  it('clamps a confidence a detector got wrong', () => {
    const f = makeFinding({
      cls: 'PAN',
      box: { x: 0, y: 0, w: 1, h: 1 },
      layer: 'L2',
      confidence: 1.4,
      reason: 'x',
    });
    expect(f.confidence).toBe(1);
  });

  it('prefers the more confident draft, then the more authoritative layer', () => {
    const base = {
      cls: 'PAN' as const,
      box: { x: 0, y: 0, w: 1, h: 1 },
      reason: 'x',
      layer: 'L0' as DetectionLayer,
      confidence: 0.9,
    };
    const l0 = { ...base, layer: 'L0' as DetectionLayer, confidence: 0.9 };
    const l2 = { ...base, layer: 'L2' as DetectionLayer, confidence: 0.9 };
    const better = { ...base, layer: 'L2' as DetectionLayer, confidence: 0.95 };

    expect(strongerDraft(l0, l2)).toBe(l0);
    expect(strongerDraft(l0, better)).toBe(better);
  });
});

/**
 * A finding says where its value came from, because the session counter depends on it.
 *
 * The counter was reporting the agent's own keystrokes as protected user data: we type an
 * address into two fields, the next step photographs the page, the gate covers what it
 * finds, and the panel claims ten values protected on a page that never held one of the
 * user's. Redacting it is right. Counting it is not.
 */
describe('finding origin', () => {
  const draft = {
    cls: 'EMAIL' as const,
    box: { x: 0, y: 0, w: 10, h: 10 },
    layer: 'L1' as const,
    confidence: 0.9,
    reason: 'email-shape',
  };

  it('defaults to the page, which is what a detector with no reason to think otherwise saw', () => {
    expect(makeFinding(draft).origin).toBe('page');
  });

  it('carries the agent mark onto the wire', () => {
    expect(makeFinding({ ...draft, origin: 'agent' }).origin).toBe('agent');
  });
});
