import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  isAadhaarValid,
  isCardValid,
  isDrivingLicenceValid,
  isGstinValid,
  isIndianMobileValid,
  isKnownIfscBank,
  isPanValid,
  isPassportValid,
  isUpiHandleValid,
} from '../extension/src/redaction/validators';

/**
 * The demo pages' identifiers, run through the same validators the extension uses.
 *
 * This exists because of a specific failure. Page A shipped with `234567890123` and
 * `ABCDE1234F` -- the right shapes, the wrong checksums -- so L1 correctly ignored both,
 * and the first real browser load produced six L0 findings and zero L1. The demo would
 * have shown nothing from the checksum layer, on stage, and the cause would have looked
 * like a broken detector rather than bad test data.
 *
 * `demo/README.md` had warned about exactly this since week one. A warning in a README
 * is not a mechanism, which is the general form of the bug and the reason for this file.
 *
 * The check does not need the pages to declare where their PII is -- annotating them
 * would both be a maintenance burden and look, to anyone reading the page source, like
 * the detector was being helped. Instead: anything shaped like an identifier must
 * validate as one. A value that matches a class's pattern and fails its checksum is a
 * fixture bug by definition, because no detector will ever find it.
 */

const DEMO = join(process.cwd(), 'demo');

interface ShapeCheck {
  cls: string;
  /** What the class looks like, ignoring whether it is valid. */
  shape: RegExp;
  valid(value: string): boolean;
  /** Why a page might legitimately carry this shape without meaning it. */
  note?: string;
}

const CHECKS: ShapeCheck[] = [
  {
    cls: 'AADHAAR',
    shape: /^[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}$/,
    valid: isAadhaarValid,
    note: 'twelve digits starting 2-9 must pass Verhoeff',
  },
  {
    cls: 'PAN',
    shape: /^[A-Z]{5}\d{4}[A-Z]$/,
    valid: isPanValid,
    note: 'the fourth character must be a real entity type',
  },
  {
    cls: 'GSTIN',
    shape: /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/,
    valid: isGstinValid,
  },
  {
    cls: 'IFSC',
    shape: /^[A-Z]{4}0[A-Z0-9]{6}$/,
    valid: isKnownIfscBank,
    note: 'the bank code must be one L1 ships in IFSC_BANK_CODES',
  },
  {
    cls: 'UPI',
    shape: /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z]{2,32}$/,
    valid: isUpiHandleValid,
    note: 'the suffix must be a PSP handle L1 knows',
  },
  {
    cls: 'CARD',
    shape: /^(?:\d[ -]?){12,18}\d$/,
    valid: isCardValid,
    note: 'must pass Luhn and carry a recognised issuer prefix',
  },
  {
    cls: 'PHONE',
    shape: /^(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{4,5}$/,
    valid: isIndianMobileValid,
  },
  {
    cls: 'PASSPORT',
    shape: /^[A-PR-WY]\d{7}$/,
    valid: isPassportValid,
  },
  {
    cls: 'LICENCE',
    shape: /^[A-Z]{2}[\s-]?\d{2}[\s-]?(?:19|20)\d{2}\d{7}$/,
    valid: isDrivingLicenceValid,
  },
];

function demoPages(): string[] {
  return readdirSync(DEMO)
    .filter((f) => f.endsWith('.html'))
    .map((f) => join(DEMO, f));
}

/**
 * Text a tier-2 page paints rather than marks up.
 *
 * The DOM-shaped scan below strips `<script>` and never opens a data URI, which is
 * exactly where the two tier-2 pages keep their identifiers: `tier-2-pixels.html` draws
 * them with `ctx.fillText`, and `tier-2-image-id.html` ships them inside a base64 SVG.
 * Those are the pages whose whole argument is that the checksum layers fire on pixels,
 * so they are the last pages that can afford an unvalidated fixture -- and they were the
 * two this file could not see. Sources of glyphs, in the order a page tends to use them.
 */
function paintedValues(html: string): string[] {
  const values: string[] = [];

  // Canvas text: the string argument of fillText/strokeText, and the literals in the
  // key/value tables those calls are usually fed from.
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
  for (const script of scripts) {
    for (const m of script.matchAll(/(?:fill|stroke)Text\(\s*(['"`])([\s\S]*?)\1/g)) {
      if (m[2]) values.push(m[2].trim());
    }
    for (const m of script.matchAll(/(['"])([^'"\n]{8,})\1/g)) {
      if (m[2]) values.push(m[2].trim());
    }
  }

  // base64 data URIs: decode, then recurse through the same text scan. An SVG carries its
  // glyphs in <text> nodes, which the tag strip below turns back into words.
  for (const m of html.matchAll(/;base64,([A-Za-z0-9+/=]{64,})/g)) {
    if (!m[1]) continue;
    let decoded = '';
    try {
      decoded = Buffer.from(m[1], 'base64').toString('utf8');
    } catch {
      continue;
    }
    values.push(...textTokens(decoded));
  }

  return values;
}

/**
 * Words of 8+ characters in whatever is left once tags, script and style are gone, plus
 * grouped digit runs rejoined.
 *
 * The word split alone cannot see a spaced identifier. `6933 7752 9506` in an SVG `<text>`
 * node is three four-digit tokens, every one of them under the floor, so no candidate ever
 * holds the whole number and its checksum is never checked -- which is how the second
 * tier-2 page stayed unguarded even after the canvas one was covered. A page that prints
 * an Aadhaar as content rather than into a `value=` has the same problem.
 */
function textTokens(source: string): string[] {
  const text = source
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  const out: string[] = [];
  for (const token of text.split(/[\s,;()<>[\]"']+/)) {
    const trimmed = token.trim();
    if (trimmed.length >= 8) out.push(trimmed);
  }
  // Digits printed in groups: Aadhaar as 4-4-4, a card as 4-4-4-4. Kept as written so the
  // class shapes, which allow one separator, match what a reader would copy off the page.
  for (const m of text.matchAll(/\b\d{4}(?:[\s-]\d{4}){2,3}\b/g)) {
    out.push(m[0].trim());
  }
  return out;
}

/**
 * Every string a detector could plausibly read: field values, selected options, the
 * page's own text, and -- for the tier-2 pages -- the glyphs it paints into a canvas or
 * ships inside a data URI. Attribute names and ids are excluded: a field called
 * `aadhaar_no` is a label, not an Aadhaar number.
 */
function candidateValues(html: string): string[] {
  const values: string[] = [];

  for (const m of html.matchAll(/\bvalue="([^"]+)"/g)) {
    if (m[1]) values.push(m[1].trim());
  }
  // Text between tags, split into words and short runs -- enough to catch an identifier
  // printed as page content rather than typed into a field.
  values.push(...textTokens(html));
  values.push(...paintedValues(html));

  return [...new Set(values)];
}

describe('the demo pages carry identifiers the detectors can actually find', () => {
  const pages = demoPages();

  it('finds some demo pages to check', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  for (const page of pages) {
    const name = page.split(/[\\/]/).pop() ?? page;

    it(`${name}: every identifier-shaped value validates`, () => {
      const html = readFileSync(page, 'utf8');
      const offenders: string[] = [];

      for (const value of candidateValues(html)) {
        for (const check of CHECKS) {
          if (!check.shape.test(value)) continue;
          if (check.valid(value)) continue;
          offenders.push(
            `${value} looks like a ${check.cls} but is not one` +
              (check.note ? ` -- ${check.note}` : ''),
          );
        }
      }

      expect(
        offenders,
        `${name} carries values no detector will ever find:\n  ${offenders.join('\n  ')}\n\n` +
          'Take replacements from eval/corpus/identifiers.json, which ' +
          'scripts/make-pii-fixture.py generates with independent checksum implementations.',
      ).toEqual([]);
    });
  }

  it('pages A and B carry the same person, byte for byte', () => {
    // The cross-page half of the demo rests on this. PlaceholderAllocator keys its map
    // on `${cls} ${value}` with no normalisation, so «PERSON_1» stays «PERSON_1» on the
    // second page only if the string is identical -- a stray double space, a non-breaking
    // space, or a changed spelling silently turns the same human into PERSON_2 and the
    // demo stops showing the property it exists to show.
    //
    // Measured, not assumed: demo/NAVIGATION.md records the browser run where the same
    // values re-allocate to the same tokens across a real document load.
    const a = readFileSync(join(DEMO, 'page-a-enrolment.html'), 'utf8');
    const b = readFileSync(join(DEMO, 'page-b-application.html'), 'utf8');

    for (const [what, pattern] of [
      ['name', /id="b?-?name"[\s\S]{0,300}?value="([^"]+)"/],
      ['aadhaar', /id="b?-?aadhaar"[\s\S]{0,300}?value="([^"]+)"/],
    ] as const) {
      const inA = a.match(pattern)?.[1];
      const inB = b.match(pattern)?.[1];
      expect(inA, `page A has no ${what} value to carry over`).toBeTruthy();
      expect(inB, `page B has no ${what} value carried over`).toBeTruthy();
      expect(
        inB,
        `page B's ${what} differs from page A's, so it will be allocated a new ` +
          'placeholder number and the cross-page demo will show nothing.',
      ).toBe(inA);
    }
  });

  it('page A carries at least one valid Aadhaar and one valid PAN', () => {
    // The positive half. A page that carries nothing at all would pass the check above
    // trivially, and a demo with no detectable PII demonstrates nothing.
    const html = readFileSync(join(DEMO, 'page-a-enrolment.html'), 'utf8');
    const values = candidateValues(html);

    expect(
      values.some((v) => isAadhaarValid(v)),
      'no Verhoeff-valid Aadhaar on page A',
    ).toBe(true);
    expect(
      values.some((v) => isPanValid(v)),
      'no structurally valid PAN on page A',
    ).toBe(true);
  });
});
