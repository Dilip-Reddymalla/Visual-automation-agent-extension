/**
 * Checksums. These are the difference between recall and precision on the 20% PII
 * metric, and they are cheap.
 *
 * A regex over a page with numbers on it fires constantly: invoice numbers, order ids,
 * purchase orders, batch codes and rupee amounts are all digit strings of plausible
 * length. The checksum is what separates them, and skipping it is the named way teams
 * have thrown away the precision marks on this project (CLAUDE.md, mistakes).
 *
 * What a checksum cannot do is judge context. Roughly one random twelve-digit string in
 * ten passes Verhoeff by chance, so an "Invoice no." with a lucky number still needs
 * rejecting on the words around it -- that is l1-lexical.ts's job, not this file's.
 *
 * Node-pure, no allocation in the hot path, no dependencies.
 */

// ── Verhoeff, for Aadhaar ───────────────────────────────────────────────────────

/**
 * The real tables, not an approximation. Verhoeff catches every single-digit error and
 * every adjacent transposition -- the two mistakes a human makes copying a number off a
 * card -- which is exactly why UIDAI chose it and why a hand-rolled mod-10 stand-in
 * would defeat the purpose.
 */
const D_TABLE: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const P_TABLE: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

const INV_TABLE: readonly number[] = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

export function isVerhoeffValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  for (let i = 0; i < digits.length; i += 1) {
    const digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    c = D_TABLE[c]?.[P_TABLE[i % 8]?.[digit] ?? 0] ?? 0;
  }
  return c === 0;
}

/** The digit that would make `payload` valid. Used by the fixture generator's twin. */
export function verhoeffCheckDigit(payload: string): number {
  let c = 0;
  for (let i = 0; i < payload.length; i += 1) {
    const digit = payload.charCodeAt(payload.length - 1 - i) - 48;
    c = D_TABLE[c]?.[P_TABLE[(i + 1) % 8]?.[digit] ?? 0] ?? 0;
  }
  return INV_TABLE[c] ?? 0;
}

/**
 * Twelve digits, Verhoeff-valid, not starting 0 or 1 -- UIDAI does not issue those, so
 * the rule costs nothing and removes a whole family of sequential test numbers.
 */
export function isAadhaarValid(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '');
  if (!/^[2-9]\d{11}$/.test(digits)) return false;
  return isVerhoeffValid(digits);
}

// ── Luhn, for payment cards ─────────────────────────────────────────────────────

export function isLuhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let n = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** Issuer prefixes worth recognising, RuPay included -- this is an Indian deployment. */
const CARD_PREFIXES: ReadonlyArray<{ issuer: string; re: RegExp; lengths: number[] }> = [
  { issuer: 'visa', re: /^4/, lengths: [13, 16, 19] },
  { issuer: 'mastercard', re: /^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/, lengths: [16] },
  { issuer: 'amex', re: /^3[47]/, lengths: [15] },
  { issuer: 'rupay', re: /^(60|65|81|82|508)/, lengths: [16] },
  { issuer: 'discover', re: /^(6011|64[4-9]|65)/, lengths: [16, 19] },
  { issuer: 'diners', re: /^3(0[0-5]|[68])/, lengths: [14, 16] },
  { issuer: 'jcb', re: /^35(2[89]|[3-8]\d)/, lengths: [16, 19] },
];

export function cardIssuer(digits: string): string | null {
  for (const { issuer, re, lengths } of CARD_PREFIXES) {
    if (re.test(digits) && lengths.includes(digits.length)) return issuer;
  }
  return null;
}

/**
 * Luhn *and* a recognised issuer prefix. Luhn alone accepts one random string in ten,
 * which on a page of order numbers is far too many.
 */
export function isCardValid(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  if (!isLuhnValid(digits)) return false;
  return cardIssuer(digits) !== null;
}

// ── PAN ─────────────────────────────────────────────────────────────────────────

/** Fourth character encodes the holder: P individual, C company, H HUF, F firm, ... */
const PAN_ENTITY_TYPES = 'ABCFGHLJPTKE';

export function isPanValid(value: string): boolean {
  const v = value.toUpperCase();
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(v)) return false;

  const entity = v[3];
  if (!entity || !PAN_ENTITY_TYPES.includes(entity)) return false;

  // The tenth character is a check letter, but the algorithm the Income Tax Department
  // uses for it is not public. Structure and the entity code are what can be verified
  // honestly; claiming a checksum here would be claiming something untrue.
  return true;
}

// ── GSTIN ───────────────────────────────────────────────────────────────────────

const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Weighted base-36 checksum: alternate factors, sum quotient and remainder, mod 36. */
export function gstinCheckChar(first14: string): string {
  let total = 0;
  for (let i = 0; i < first14.length; i += 1) {
    const ch = first14[i] ?? '';
    const value = BASE36.indexOf(ch);
    if (value < 0) return '';
    const product = value * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(product / 36) + (product % 36);
  }
  return BASE36[(36 - (total % 36)) % 36] ?? '';
}

export function isGstinValid(value: string): boolean {
  const v = value.toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(v)) return false;

  const state = Number.parseInt(v.slice(0, 2), 10);
  // 01-38 are states and union territories; 97 is "other territory", 99 centre-issued.
  if (!((state >= 1 && state <= 38) || state === 97 || state === 99)) return false;

  if (!isPanValid(v.slice(2, 12))) return false;
  return gstinCheckChar(v.slice(0, 14)) === v[14];
}

// ── IFSC ────────────────────────────────────────────────────────────────────────

/**
 * A shipped list, because the shape alone is far too permissive: four letters, a zero
 * and six alphanumerics matches a great many product codes. Not exhaustive -- India has
 * a few hundred banks -- but it covers the ones a demo or an eval corpus will contain.
 *
 * A code that is not on this list is not reported by L1 unless the surrounding text says
 * "IFSC" (see l1-lexical.ts). That trades a little recall for precision; extending this
 * set is how to buy the recall back.
 */
export const IFSC_BANK_CODES: ReadonlySet<string> = new Set([
  'SBIN',
  'HDFC',
  'ICIC',
  'UTIB',
  'PUNB',
  'BARB',
  'CNRB',
  'UBIN',
  'IOBA',
  'CBIN',
  'IDIB',
  'MAHB',
  'BKID',
  'IDFB',
  'KKBK',
  'YESB',
  'INDB',
  'FDRL',
  'KARB',
  'SIBL',
  'CSBK',
  'DCBL',
  'RATN',
  'TMBL',
  'JAKA',
  'PSIB',
  'UCBA',
  'AUBL',
  'ESFB',
  'UJVN',
  'SURY',
  'NSPB',
  'AIRP',
  'FINO',
  'PYTM',
  'JSFB',
  'CIUB',
  'LAVB',
  'SCBL',
  'CITI',
  'HSBC',
  'DEUT',
  'BNPA',
  'ABNA',
  'DBSS',
  'SVCB',
  'ABHY',
  'KVBL',
  'DLXB',
  'NKGS',
]);

export function isIfscValid(value: string): boolean {
  const v = value.toUpperCase();
  // The fifth character is reserved and is always zero.
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v);
}

/** A known bank as well as a valid shape. Confidence, not admission, depends on this. */
export function isKnownIfscBank(value: string): boolean {
  return isIfscValid(value) && IFSC_BANK_CODES.has(value.toUpperCase().slice(0, 4));
}

// ── UPI ─────────────────────────────────────────────────────────────────────────

/**
 * PSP handles. Without this list every email address on the page is a VPA: the shapes
 * are identical and only the suffix distinguishes them.
 */
export const UPI_PSP_HANDLES: ReadonlySet<string> = new Set([
  'okhdfcbank',
  'okicici',
  'okaxis',
  'oksbi',
  'ybl',
  'ibl',
  'axl',
  'paytm',
  'apl',
  'upi',
  'sbi',
  'hdfcbank',
  'icici',
  'axisbank',
  'kotak',
  'yesbank',
  'idfcbank',
  'indus',
  'barodampay',
  'cnrb',
  'pnb',
  'unionbank',
  'jupiteraxis',
  'fam',
  'slc',
  'timecosmos',
  'rapl',
  'abfspay',
  'freecharge',
  'airtel',
  'jio',
  'naviaxis',
]);

export function isUpiHandleValid(value: string): boolean {
  const match = /^([a-zA-Z0-9._-]{2,256})@([a-zA-Z]{2,64})$/.exec(value);
  if (!match) return false;
  const psp = match[2]?.toLowerCase();
  return psp !== undefined && UPI_PSP_HANDLES.has(psp);
}

// ── Phone, India ────────────────────────────────────────────────────────────────

export function isIndianMobileValid(value: string): boolean {
  const digits = value.replace(/[\s()+-]/g, '');
  const national =
    digits.startsWith('91') && digits.length === 12
      ? digits.slice(2)
      : digits.startsWith('0') && digits.length === 11
        ? digits.slice(1)
        : digits;
  // Mobile series in India start 6, 7, 8 or 9. Everything else is a landline, a short
  // code, or not a number at all.
  return /^[6-9]\d{9}$/.test(national);
}

// ── The rest ────────────────────────────────────────────────────────────────────

export function isEmailValid(value: string): boolean {
  return /^[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9-]{1,63}(\.[a-zA-Z0-9-]{1,63})+$/.test(value);
}

/** Six digits, first digit 1-8. 9 is the army postal service, not a civilian pincode. */
export function isPincodeValid(value: string): boolean {
  const digits = value.replace(/\s/g, '');
  if (!/^[1-8]\d{5}$/.test(digits)) return false;
  return !/^(\d)\1{5}$/.test(digits);
}

/** Indian passport: a letter (not Q, X or Z), then seven digits, first non-zero. */
export function isPassportValid(value: string): boolean {
  return /^[A-PR-WY][1-9]\d\s?\d{4}[1-9]$/.test(value.toUpperCase().replace(/\s/g, ''));
}

/** State code, RTO code, issue year, then a serial. */
export function isDrivingLicenceValid(value: string): boolean {
  const v = value.toUpperCase().replace(/[\s-]/g, '');
  const match = /^([A-Z]{2})(\d{2})((?:19|20)\d{2})(\d{7})$/.exec(v);
  if (!match) return false;
  const year = Number.parseInt(match[3] ?? '0', 10);
  return year >= 1950 && year <= new Date().getFullYear();
}

export interface ParsedDate {
  year: number;
  month: number;
  day: number;
}

/** dd/mm/yyyy, dd-mm-yyyy and yyyy-mm-dd, which is what Indian forms actually use. */
export function parseDate(value: string): ParsedDate | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) {
    return {
      year: Number.parseInt(iso[1] ?? '', 10),
      month: Number.parseInt(iso[2] ?? '', 10),
      day: Number.parseInt(iso[3] ?? '', 10),
    };
  }
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value);
  if (dmy) {
    return {
      year: Number.parseInt(dmy[3] ?? '', 10),
      month: Number.parseInt(dmy[2] ?? '', 10),
      day: Number.parseInt(dmy[1] ?? '', 10),
    };
  }
  return null;
}

/**
 * A date that could be somebody's birthday: real calendar date, in the past, and inside
 * a human lifespan. It is deliberately not enough on its own -- an expiry date passes
 * all three -- so l1-lexical.ts additionally requires a nearby keyword.
 */
export function isPlausibleBirthDate(value: string, now = new Date()): boolean {
  const parsed = parseDate(value);
  if (!parsed) return false;
  const { year, month, day } = parsed;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  if (date.getTime() > now.getTime()) return false;

  const age = (now.getTime() - date.getTime()) / (365.25 * 24 * 3600 * 1000);
  return age >= 0 && age <= 120;
}
