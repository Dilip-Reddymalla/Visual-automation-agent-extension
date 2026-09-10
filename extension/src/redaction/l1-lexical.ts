/**
 * L1: lexical patterns over DOM text -- Aadhaar, PAN, GSTIN, IFSC, UPI, card, account,
 * passport, licence, email, phone, DOB.
 *
 * Every numeric pattern goes through validators.ts before it becomes a finding. A
 * twelve-digit invoice number is not an Aadhaar, and shipping a regex without the
 * checksum is how the precision metric gets thrown away (CLAUDE.md, mistakes).
 *
 * But the checksum is only half of it. About one random twelve-digit string in ten
 * passes Verhoeff, so on a page of order numbers the arithmetic alone still lets one in
 * ten through. Two context rules close that gap:
 *
 *   Negative context   a match preceded by "invoice", "order", "receipt", "txn" and
 *                      the like is rejected however well it validates. The label is
 *                      better evidence than the checksum.
 *
 *   Required context   classes with no checksum at all -- a bank account number is
 *                      just digits, a birth date is just a date -- are only reported
 *                      when a keyword nearby says what they are. Without this, account
 *                      numbers match every purchase order on the page.
 *
 * It reads ObservedElement, not the wire Element: the raw value of a field and its text
 * runs are exactly what this layer scans, and they are exactly what the wire format
 * does not carry.
 *
 * Node-pure.
 */

import type { Viewport } from '../shared/contract';
import type { ObservedElement } from '../shared/observed';
import type { PlaceholderClass } from '../shared/placeholders';
import type { FindingDraft } from './findings';
import {
  isAadhaarValid,
  isCardValid,
  isDrivingLicenceValid,
  isEmailValid,
  isGstinValid,
  isIfscValid,
  isIndianMobileValid,
  isKnownIfscBank,
  isPanValid,
  isPassportValid,
  isPlausibleBirthDate,
  isUpiHandleValid,
} from './validators';

export interface LexicalMatch {
  cls: PlaceholderClass;
  start: number;
  end: number;
  text: string;
  reason: string;
  confidence: number;
}

/** How far either side of a match to read for context words. */
const CONTEXT_WINDOW = 40;

/**
 * A label that says the number is something else. These beat any checksum: a business
 * that prints "Invoice no." above a twelve-digit number is telling you what it is.
 *
 * The second half of the list is the vocabulary of an Indian government form rather
 * than a shop's. "Enrolment No.", "Acknowledgement No.", "Application No.", "URN" --
 * each is a long number printed beside the real identifier, and a fair share of them
 * pass Verhoeff by chance. Measured on demo/tier-2-image-id.html, whose enrolment slip
 * carries one directly under the Aadhaar it belongs to: without these words the slip
 * came back with both numbers painted out, and over-redaction is a first-class failure.
 */
const NEGATIVE_CONTEXT =
  /\b(invoice|inv|order|ord|receipt|challan|txn|transaction|reference|ref|ticket|po|purchase\s*order|batch|sku|serial|isbn|case|docket|voucher|bill|awb|tracking|consignment|enrolment|enrollment|acknowledgement|acknowledgment|ack|application|registration|urn|srn|file)\b(?:\s*(?:no|number|num|nos|id|#)\.?)?[\s.:#-]*$/i;

/** Currency, decimals and thousands separators: an amount, not an identifier. */
const MONEY_BEFORE = /(₹|rs\.?|inr|usd|\$|total|amount|balance|paid|due)\s*[-]?\s*$/i;
const MONEY_AFTER = /^\s*(\.\d{1,2}\b|%|\s*(lakh|crore|cr|k)\b)/i;

const ACCOUNT_CONTEXT =
  /\b(a\/c|ac|acct|account|bank\s*account|savings|current|beneficiary)\s*(no\.?|number|#)?[\s.:#-]*$/i;

const DOB_CONTEXT =
  /\b(dob|d\.o\.b|date\s*of\s*birth|birth\s*date|born|janm|janam)\b[\s.:#-]*$/i;

/**
 * A date caption that says the date is not personal data. DOB already needs
 * DOB_CONTEXT to be reported (above), but L2 maps every DATE label and would still
 * propose "Filed on 04/07/2023" as a birthday -- the caption is the one thing L1's
 * required-context rule had that L2 lacked until this existed.
 */
const NON_BIRTH_DATE_CONTEXT =
  /\b(filed|issued|issue|expir(y|es|ation)|valid\s*(?:until|from|through|till)|last\s*(?:updated|modified|edited|paid)|payment|received|notified|date\s*of\s*(?:issue|filing|registration|appointment|joining|recruitment|purchase|payment|transaction|invoice|receipt|report|submission|verification))\b(?:\s*(?:on|date|dt\.?))?[\s.:#-]*$/i;

const IFSC_CONTEXT = /\b(ifsc|ifs\s*code|branch\s*code|neft|rtgs)\b[\s.:#-]*$/i;

/**
 * Ordered because the first match at a position wins: GSTIN contains a PAN, and a card
 * number contains runs that look like other things.
 */
interface Pattern {
  cls: PlaceholderClass;
  re: RegExp;
  /**
   * Whether a preceding "Invoice no." style label disqualifies this match.
   *
   * True only for classes that are otherwise just digits. An email address after
   * "Ref:" is still an email address, and an early version of this rule suppressed it
   * -- the label tells you what a *number* is, not what an email is.
   */
  labelCanDisqualify: boolean;
  /** Rejects, or upgrades/downgrades the confidence. Returning null drops the match. */
  check(
    text: string,
    before: string,
    after: string,
  ): { reason: string; confidence: number } | null;
}

const PATTERNS: readonly Pattern[] = [
  {
    cls: 'GSTIN',
    labelCanDisqualify: true,
    re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/g,
    check: (text) =>
      isGstinValid(text) ? { reason: 'gstin-checksum', confidence: 0.99 } : null,
  },
  {
    cls: 'AADHAAR',
    labelCanDisqualify: true,
    re: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    check: (text) =>
      isAadhaarValid(text) ? { reason: 'verhoeff-ok', confidence: 0.98 } : null,
  },
  {
    cls: 'CARD',
    labelCanDisqualify: true,
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    check: (text) =>
      isCardValid(text) ? { reason: 'luhn-and-issuer', confidence: 0.97 } : null,
  },
  {
    cls: 'PAN',
    labelCanDisqualify: true,
    re: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    check: (text) => (isPanValid(text) ? { reason: 'pan-structure', confidence: 0.94 } : null),
  },
  {
    cls: 'IFSC',
    labelCanDisqualify: false,
    re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    check: (text, before) => {
      if (!isIfscValid(text)) return null;
      if (isKnownIfscBank(text)) return { reason: 'ifsc-known-bank', confidence: 0.97 };
      // Four letters, a zero and six alphanumerics is a shape a great many product
      // codes share, so an unknown bank needs the label to vouch for it. The bank list
      // is not exhaustive; this trades a little recall for precision, and extending
      // IFSC_BANK_CODES is the way to buy the recall back.
      if (IFSC_CONTEXT.test(before)) return { reason: 'ifsc-labelled', confidence: 0.85 };
      return null;
    },
  },
  {
    cls: 'UPI',
    labelCanDisqualify: false,
    re: /\b[a-zA-Z0-9._-]{2,64}@[a-zA-Z]{2,32}\b/g,
    check: (text) => (isUpiHandleValid(text) ? { reason: 'upi-psp', confidence: 0.96 } : null),
  },
  {
    cls: 'EMAIL',
    labelCanDisqualify: false,
    re: /\b[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9-]{1,63}(?:\.[a-zA-Z0-9-]{1,63})+\b/g,
    check: (text) => (isEmailValid(text) ? { reason: 'email-shape', confidence: 0.95 } : null),
  },
  {
    cls: 'PHONE',
    labelCanDisqualify: true,
    re: /(?<![\d@.])(?:\+91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?![\d.])/g,
    check: (text) =>
      isIndianMobileValid(text) ? { reason: 'in-mobile-series', confidence: 0.9 } : null,
  },
  {
    cls: 'PASSPORT',
    labelCanDisqualify: true,
    re: /\b[A-PR-WY][1-9]\d\s?\d{4}[1-9]\b/g,
    check: (text) =>
      isPassportValid(text) ? { reason: 'passport-shape', confidence: 0.88 } : null,
  },
  {
    cls: 'LICENCE',
    labelCanDisqualify: true,
    re: /\b[A-Z]{2}[\s-]?\d{2}[\s-]?(?:19|20)\d{2}\d{7}\b/g,
    check: (text) =>
      isDrivingLicenceValid(text) ? { reason: 'licence-shape', confidence: 0.9 } : null,
  },
  {
    cls: 'ACCOUNT',
    labelCanDisqualify: true,
    re: /\b\d{9,18}\b/g,
    check: (text, before) => {
      // No checksum exists for a bank account number, so the label has to carry it.
      if (!ACCOUNT_CONTEXT.test(before)) return null;
      return { reason: 'account-with-label', confidence: 0.85 };
    },
  },
  {
    cls: 'DOB',
    labelCanDisqualify: false,
    re: /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{4}-\d{2}-\d{2})\b/g,
    check: (text, before) => {
      // Every expiry date, issue date and timestamp on the page matches this shape.
      // Only the words around it say which one is a birthday.
      if (!DOB_CONTEXT.test(before)) return null;
      if (!isPlausibleBirthDate(text)) return null;
      return { reason: 'dob-with-label', confidence: 0.92 };
    },
  },
];

/** Matches within one string, checksum-validated and context-checked. */
/**
 * Is this value captioned as something that is not personal data?
 *
 * "Waybill 736561952930" is Verhoeff-valid and is not an Aadhaar number. "Filed on
 * 04/07/2023" is a real date and is not a birthday. The caption is the evidence, and it
 * is the single highest-precision signal on a page full of identifier-shaped strings --
 * disabling it takes the corpus's hard-negative survival from 0.87 to 0.62.
 *
 * Exported because the rule is about the *page*, not about the layer that happened to
 * find the value. L2 proposes spans over the same document text and was, until it used
 * this, redacting the same decoys L1 had been correctly refusing for weeks.
 */
export function disqualifiedByCaption(before: string, after: string, cls?: string): boolean {
  if (NEGATIVE_CONTEXT.test(before)) return true;
  if (cls === 'DOB' && NON_BIRTH_DATE_CONTEXT.test(before)) return true;
  return MONEY_BEFORE.test(before) || MONEY_AFTER.test(after);
}

/** How much text either side of a match counts as its caption. */
export const CAPTION_WINDOW = CONTEXT_WINDOW;

export function scanText(text: string): LexicalMatch[] {
  const matches: LexicalMatch[] = [];
  const taken: Array<[number, number]> = [];

  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = pattern.re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      // A GSTIN contains a PAN; whichever pattern claimed the span first keeps it.
      if (taken.some(([s, e]) => start < e && end > s)) continue;

      const before = text.slice(Math.max(0, start - CONTEXT_WINDOW), start);
      const after = text.slice(end, end + CONTEXT_WINDOW);

      if (pattern.labelCanDisqualify && disqualifiedByCaption(before, after, pattern.cls)) {
        continue;
      }

      const verdict = pattern.check(m[0], before, after);
      if (!verdict) continue;

      taken.push([start, end]);
      matches.push({
        cls: pattern.cls,
        start,
        end,
        text: m[0],
        reason: verdict.reason,
        confidence: verdict.confidence,
      });
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}

/**
 * Every string an element carries that could hold a value: the field's own contents
 * first, then its visible text. Labels and placeholders are deliberately excluded --
 * "Aadhaar number" is a label, not an Aadhaar number, and scanning it produces nothing
 * but noise.
 */
function scannableStrings(el: ObservedElement): Array<{ text: string; runIndex: number }> {
  const out: Array<{ text: string; runIndex: number }> = [];
  if (el.rawValue) out.push({ text: el.rawValue, runIndex: -1 });
  if (el.selectedText) out.push({ text: el.selectedText, runIndex: -1 });
  el.textRuns.forEach((run, i) => out.push({ text: run.text, runIndex: i }));
  return out;
}

export function detectLexical(elements: ObservedElement[], viewport: Viewport): FindingDraft[] {
  void viewport;
  const drafts: FindingDraft[] = [];

  for (const el of elements) {
    for (const { text, runIndex } of scannableStrings(el)) {
      for (const match of scanText(text)) {
        drafts.push({
          cls: match.cls,
          // A run has its own box; a field's value is covered by the field itself.
          box: runIndex >= 0 ? (el.textRuns[runIndex]?.box ?? el.box) : el.box,
          // Which of the two it was decides the padding: a field rect already carries
          // the site's own CSS padding, a text rect is drawn tight around glyphs.
          boxKind: runIndex >= 0 ? 'text' : 'element',
          layer: 'L1',
          confidence: match.confidence,
          reason: match.reason,
          elementIndex: el.index,
          // Still redacted, but not counted as protection: see Finding.origin.
          origin: el.agentTyped ? 'agent' : 'page',
          textSpan: [match.start, match.end],
          value: match.text,
        });
      }
    }
  }

  return drafts;
}
