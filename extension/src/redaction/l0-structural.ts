/**
 * L0: structural signals. Free, exact, and always right -- password inputs,
 * autocomplete tokens (cc-number, tel, street-address), input[type=tel|email],
 * aria-labels naming a document type, and elements a site marked sensitive.
 *
 * This layer runs first and its findings outrank the probabilistic ones. It is also the
 * only layer that can be sure about an *empty* field: a password input with nothing in
 * it is still a password input, and the box still needs covering before the user types.
 *
 * The lexicon is bilingual and Indian from the start rather than as a later pass.
 * Retrofitting "janm tithi" onto a matcher built around "date of birth" means rebuilding
 * the tokeniser, and a form that says "आधार संख्या" is not an edge case in this
 * deployment -- it is the deployment.
 *
 * It reads ObservedElement, not the wire Element: the signals it needs -- autocomplete,
 * inputmode, the name and id attributes, -webkit-text-security, the raw value itself --
 * are exactly the ones the wire format does not carry, and must not.
 *
 * Node-pure.
 */

import type { Viewport } from '../shared/contract';
import type { ObservedElement } from '../shared/observed';
import type { PlaceholderClass } from '../shared/placeholders';
import type { FindingDraft } from './findings';
import type { BoxKind } from './policy';

/**
 * autocomplete tokens are the strongest signal on the web: the site is telling the
 * browser what the field holds so it can be filled correctly. Nothing guesses better.
 */
const AUTOCOMPLETE_MAP: Readonly<Record<string, PlaceholderClass>> = {
  'cc-number': 'CARD',
  'cc-csc': 'CARD',
  'cc-exp': 'CARD',
  'cc-exp-month': 'CARD',
  'cc-exp-year': 'CARD',
  'cc-name': 'PERSON',
  tel: 'PHONE',
  'tel-national': 'PHONE',
  'tel-local': 'PHONE',
  email: 'EMAIL',
  'street-address': 'ADDRESS',
  'address-line1': 'ADDRESS',
  'address-line2': 'ADDRESS',
  'address-level1': 'ADDRESS',
  'address-level2': 'ADDRESS',
  'postal-code': 'ADDRESS',
  bday: 'DOB',
  'bday-day': 'DOB',
  'bday-month': 'DOB',
  'bday-year': 'DOB',
  name: 'PERSON',
  'given-name': 'PERSON',
  'family-name': 'PERSON',
  'additional-name': 'PERSON',
  'honorific-prefix': 'PERSON',
  organization: 'ORG',
  'one-time-code': 'SECRET',
  'current-password': 'SECRET',
  'new-password': 'SECRET',
};

const INPUT_TYPE_MAP: Readonly<Record<string, PlaceholderClass>> = {
  password: 'SECRET',
  email: 'EMAIL',
  tel: 'PHONE',
};

/**
 * Keyword lexicon, matched against label, aria-label, placeholder, name and id.
 *
 * Hindi and transliterations sit alongside English because Indian government forms mix
 * all three in the same page, often in the same field: a label reading "आधार संख्या /
 * Aadhaar Number" with `name="uid_no"`.
 */
const LEXICON: ReadonlyArray<{ cls: PlaceholderClass; words: readonly string[] }> = [
  {
    cls: 'AADHAAR',
    words: ['aadhaar', 'aadhar', 'adhaar', 'aadar', 'uid', 'uidai', 'आधार', 'आधार संख्या'],
  },
  { cls: 'PAN', words: ['pan', 'pan card', 'permanent account', 'पैन'] },
  { cls: 'GSTIN', words: ['gstin', 'gst no', 'gst number', 'जीएसटी'] },
  { cls: 'IFSC', words: ['ifsc', 'ifs code', 'branch code'] },
  { cls: 'UPI', words: ['upi', 'vpa', 'virtual payment', 'upi id'] },
  {
    cls: 'ACCOUNT',
    words: [
      'account number',
      'account no',
      'a/c no',
      'bank account',
      'acct',
      'खाता',
      'खाता संख्या',
    ],
  },
  {
    cls: 'CARD',
    words: ['card number', 'card no', 'debit card', 'credit card', 'cvv', 'cvc', 'card holder'],
  },
  { cls: 'PASSPORT', words: ['passport', 'पासपोर्ट'] },
  {
    cls: 'LICENCE',
    words: ['driving licence', 'driving license', 'dl no', 'licence no', 'license no'],
  },
  {
    cls: 'DOB',
    words: [
      'date of birth',
      'birth date',
      'dob',
      'd.o.b',
      'janm',
      'janam',
      'जन्म',
      'जन्म तिथि',
      'birthday',
    ],
  },
  {
    cls: 'PERSON',
    words: [
      'full name',
      'first name',
      'last name',
      'middle name',
      'surname',
      'applicant name',
      "father's name",
      'father name',
      "mother's name",
      'mother name',
      'guardian',
      'nominee',
      'नाम',
      'पिता',
      'माता',
    ],
  },
  {
    cls: 'ADDRESS',
    words: [
      'address',
      'street',
      'locality',
      'pincode',
      'pin code',
      'postal code',
      'district',
      'village',
      'town',
      'पता',
      'गाँव',
      'जिला',
    ],
  },
  { cls: 'PHONE', words: ['mobile', 'phone', 'contact number', 'whatsapp', 'मोबाइल'] },
  { cls: 'EMAIL', words: ['email', 'e-mail', 'ईमेल'] },
  {
    cls: 'SECRET',
    words: ['password', 'passcode', 'pin', 'otp', 'one time password', 'security code', 'mpin'],
  },
  {
    cls: 'ORG',
    words: ['company name', 'organisation', 'organization', 'employer', 'firm name'],
  },
];

/** Classes a site marks itself: the page is telling us it considers this sensitive. */
const MASKING_CLASS_RE = /\b(mask|masked|sensitive|redact|redacted|pii|secure-field|obfuscat)/i;

/**
 * A field this layer identified but which is empty.
 *
 * Still worth a *finding*: the planner is told what belongs there, and the manifest that
 * omitted it would be describing a page it had not fully read. It is not worth a *paint
 * op*, and the difference is the whole of this constant.
 *
 * An empty field contains nothing to redact. Painting one covers a caption and a blank
 * box, which costs visual context and buys no privacy at all -- and it is not a small
 * effect. Measured over the fifty-page corpus with this at 0.75: the `-empty` rules
 * produced **58 of 91 false positives and 4 true positives**, and their boxes were the
 * widest painted anywhere, so they dominated over-redaction as well as precision.
 *
 * So the value sits below every floor in policy.ts (the lowest is SECRET at 0.4). That
 * is not a threshold tuned until the number looked better: it is the existing machinery
 * being told the truth. `merge.ts` already reports a finding below its class floor as
 * `mode: 'keep'` -- detected, named in the manifest, deliberately not painted -- which is
 * exactly the right answer for a field that is going to hold an Aadhaar number and does
 * not hold one yet.
 */
export const EMPTY_FIELD_CONFIDENCE = 0.3;

interface Signal {
  cls: PlaceholderClass;
  reason: string;
  confidence: number;
}

function fromAutocomplete(el: ObservedElement): Signal | null {
  const token = el.autocomplete?.toLowerCase().trim();
  if (!token) return null;
  // "shipping street-address" and "billing cc-number" are both legal.
  for (const part of token.split(/\s+/)) {
    const cls = AUTOCOMPLETE_MAP[part];
    if (cls) return { cls, reason: `autocomplete-${part}`, confidence: 0.99 };
  }
  return null;
}

function fromInputType(el: ObservedElement): Signal | null {
  const type = el.inputType?.toLowerCase();
  if (!type) return null;
  const cls = INPUT_TYPE_MAP[type];
  return cls ? { cls, reason: `input-type-${type}`, confidence: 0.99 } : null;
}

function fromTextSecurity(el: ObservedElement): Signal | null {
  if (!el.textSecurity || el.textSecurity === 'none') return null;
  // A text input drawn as dots is a password field whose author avoided type=password.
  return { cls: 'SECRET', reason: 'text-security', confidence: 0.97 };
}

function fromMaskingClass(el: ObservedElement): Signal | null {
  const marked = `${el.idAttr ?? ''} ${el.nameAttr ?? ''}`;
  if (!MASKING_CLASS_RE.test(marked)) return null;
  return { cls: 'SECRET', reason: 'site-marked-sensitive', confidence: 0.7 };
}

/** Everything a human would read to work out what a field is for. */
/**
 * The text that describes what an element is *for*, as opposed to what it holds.
 *
 * For a control these are all fair game: an `<input name="aadhaar_no">` is telling us
 * what it is, and it holds its value somewhere else entirely.
 *
 * For a text block they are not. A block's id and its own caption describe the block
 * itself, and a block whose text reads "Aadhaar number" is a **label**, not an Aadhaar
 * number -- so matching on it and then taking that same text as the value detects the
 * caption and paints the whole row. Measured: doing this cost 59 false positives and
 * took over-redaction from 0.094 to 0.327, and every example was a caption.
 *
 * So a text block may only be identified by an *external* association -- the `<dt>` for
 * its `<dd>`, the `<th>` for its `<td>`, an explicit aria-label. Something else on the
 * page saying what this value is.
 */
function describingText(el: ObservedElement): string {
  const external = typeof el.rawValue !== 'string';
  if (external) {
    return [el.labelText, el.ariaLabel]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join(' ')
      .toLowerCase();
  }

  return [
    el.labelText,
    el.ariaLabel,
    el.placeholder,
    el.nameAttr,
    el.idAttr,
    el.ariaDescribedByText,
  ]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ')
    .toLowerCase();
}

function fromLexicon(el: ObservedElement): Signal | null {
  const haystack = normaliseForLexicon(describingText(el));
  if (!haystack) return null;

  let best: Signal | null = null;
  for (const entry of LEXICON) {
    for (const word of entry.words) {
      if (!haystack.includes(normaliseForLexicon(word))) continue;
      // Longer keywords are more specific: "account number" beats "account".
      const confidence = Math.min(0.95, 0.72 + word.length * 0.015);
      if (!best || confidence > best.confidence) {
        best = { cls: entry.cls, reason: `label-${entry.cls.toLowerCase()}`, confidence };
      }
    }
  }
  return best;
}

/**
 * `name="aadhaar_no"`, `id="pan-card"` and `aria-label="Aadhaar Number"` should all
 * match the same lexicon entry, so separators become spaces and case is dropped.
 */
function normaliseForLexicon(text: string): string {
  return text
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Signals in order of authority. The first one that fires wins, because they are
 * genuinely ranked: an autocomplete token is the site's own declaration, an input type
 * is a browser behaviour, and a label is an inference from words.
 */
const DETECTORS: ReadonlyArray<(el: ObservedElement) => Signal | null> = [
  fromAutocomplete,
  fromInputType,
  fromTextSecurity,
  fromLexicon,
  fromMaskingClass,
];

/**
 * What kind of box this element offers, when it is not a wrapper with a known control.
 *
 * A form control's rect is its own. Anything else that L0 matched on -- a `<dd>`, a
 * `<td>` -- is a block that may hold a caption alongside the value, so it is a container
 * until something proves otherwise, and a container is never painted.
 */
/**
 * The value an element holds, whichever way it holds it.
 *
 * A control's is in `rawValue`. A text block's is its own text, and only its own -- the
 * runs are direct children, so a `<dd>` returns the value beside its `<dt>` rather than
 * the whole row.
 *
 * Deliberately not the accessible name: for a text block that is often the same string,
 * but for a control it is the *label*, and treating a caption as a value would make
 * every labelled field its own finding.
 */
function valueHeldBy(el: ObservedElement): string | undefined {
  if (typeof el.rawValue === 'string' && el.rawValue.length > 0) return el.rawValue;

  // Captions by definition. A <label>, a <dt> and a <th> exist to say what something
  // else is, so their own text is never the thing.
  //
  // This is not hypothetical tidiness. `associatedLabelText` resolves a label through
  // `closest('label')`, which for a bare `<label>Aadhaar number *</label>` returns the
  // element itself -- so the caption identified itself, its own text was then taken as
  // the value, and the whole 550px row was painted as an Aadhaar number. Eight such
  // boxes on one page, and over-redaction went from 0.094 to 0.327.
  const tag = el.tag ?? '';
  if (tag === 'label' || tag === 'dt' || tag === 'th' || tag === 'legend') return undefined;

  const own = el.textRuns
    .map((run) => run.text)
    .join(' ')
    .trim();
  if (own.length === 0) return undefined;

  // The general form of the same mistake: if what the element holds is the same string
  // that identified it, we have found a caption whatever it is called.
  if (own.toLowerCase() === (el.labelText ?? '').trim().toLowerCase()) return undefined;

  return own;
}

function boxKindFor(el: ObservedElement): BoxKind {
  const tag = el.tag ?? '';
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return 'element';
  return 'container';
}

export function detectStructural(
  elements: ObservedElement[],
  viewport: Viewport,
): FindingDraft[] {
  void viewport;
  const drafts: FindingDraft[] = [];

  for (const el of elements) {
    for (const detect of DETECTORS) {
      const signal = detect(el);
      if (!signal) continue;

      // What this element actually holds. A control keeps it in `rawValue`; a text block
      // has no value property at all and holds it as its own text, which is the ordinary
      // shape of a read-only portal: <dt>Date of birth</dt><dd>26/09/1968</dd>.
      //
      // Without this, every labelled value in prose was a finding with no value, and a
      // finding with no value is now reported rather than painted -- so the label rules
      // fired, produced nothing, and the misses looked like a lexicon problem.
      const held = valueHeldBy(el);
      const hasValue = held !== undefined;
      // A wrapper's rect spans the caption and the value together, and painting it
      // blacks out both. When perception recorded what the control alone occupies, the
      // finding goes there instead. Measured: container-shaped boxes were roughly half
      // of all over-redaction across the corpus.
      const box = el.controlBox ?? el.box;
      drafts.push({
        cls: signal.cls,
        box,
        // Always an element rect: this layer reads attributes, never glyphs.
        boxKind: el.controlBox ? 'element' : boxKindFor(el),
        layer: 'L0',
        // An empty field is still a field. Lower confidence, because there is nothing
        // there yet, but the box is reserved and the planner is told what it is for.
        confidence: hasValue
          ? signal.confidence
          : Math.min(signal.confidence, EMPTY_FIELD_CONFIDENCE),
        reason: hasValue ? signal.reason : `${signal.reason}-empty`,
        elementIndex: el.index,
        // Still redacted, but not counted as protection: see Finding.origin.
        origin: el.agentTyped ? 'agent' : 'page',
        ...(hasValue ? { value: held } : {}),
      });
      break;
    }
  }

  return drafts;
}
