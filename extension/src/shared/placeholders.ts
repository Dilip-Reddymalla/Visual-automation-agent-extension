/**
 * The frozen placeholder vocabulary (CLAUDE.md invariant 5).
 *
 * A placeholder is what the server sees where a value used to be. Numbering is
 * per-class and per-session, and it is *stable across steps*: PERSON_1 on step 9 is the
 * same human as PERSON_1 on step 2. That stability is what lets a planner refer back to
 * something it saw three screens ago without ever learning who it is.
 *
 * Adding a class means editing this file, the server system prompt and the eval harness
 * in one commit. Do not add one on the side.
 */

export const PLACEHOLDER_CLASSES = [
  'PERSON',
  'ADDRESS',
  'EMAIL',
  'PHONE',
  'DOB',
  'AADHAAR',
  'PAN',
  'GSTIN',
  'IFSC',
  'UPI',
  'ACCOUNT',
  'CARD',
  'PASSPORT',
  'LICENCE',
  'ORG',
  'SECRET',
  /**
   * A photograph of a person, found by L3 in pixels the DOM cannot describe.
   *
   * Unnumbered, and that is the interesting part rather than an oversight. Every other
   * class stands for a *string* the device can put back: «EMAIL_1» is typed into a field
   * and becomes an address again. A face has no such value -- there is nothing a planner
   * could emit that should turn back into a photograph -- so FACE never gets a token, and
   * `BLUR_POLICY.numbered` is false to say so. `allocate` refuses it outright.
   */
  'FACE',
] as const;

export type PlaceholderClass = (typeof PLACEHOLDER_CLASSES)[number];

const CLASS_SET: ReadonlySet<string> = new Set<string>(PLACEHOLDER_CLASSES);

/**
 * Classes with no value for a token to stand for.
 *
 * FACE alone, and the distinction from SECRET is worth stating because both are
 * `numbered: false` in policy.ts and they are false for different reasons.
 *
 *   SECRET   has a value. The allocator holds a *vault key*, `resolve` returns that key,
 *            and the executor exchanges it for the credential after a user confirm. It is
 *            unnumbered in the manifest so a planner cannot reference it, but allocating
 *            one is a real and necessary operation.
 *   FACE     has no value at all. There is no string a planner could emit that should
 *            turn back into a photograph, so there is nothing to allocate and nothing to
 *            resolve.
 *
 * Collapsing the two would break the vault; leaving FACE out would create a token that
 * rehydrates to an image.
 */
const NO_VALUE: ReadonlySet<string> = new Set<string>(['FACE']);

/** Opening guillemet, U+00AB. */
export const OPEN = '«';
/** Closing guillemet, U+00BB. */
export const CLOSE = '»';

/** Guillemets, class, underscore, 1-based index. Nothing else is a placeholder. */
export const PLACEHOLDER_RE = /«([A-Z]+)_(\d+)»/g;
const PLACEHOLDER_EXACT_RE = /^«([A-Z]+)_(\d+)»$/;

export function isPlaceholderClass(value: string): value is PlaceholderClass {
  return CLASS_SET.has(value);
}

export function formatPlaceholder(cls: PlaceholderClass, index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new RangeError(`placeholder index must be a positive integer, got ${String(index)}`);
  }
  return `${OPEN}${cls}_${index}${CLOSE}`;
}

export interface ParsedPlaceholder {
  cls: PlaceholderClass;
  index: number;
}

/** null for anything that is not a well-formed placeholder of a known class. */
export function parsePlaceholder(token: string): ParsedPlaceholder | null {
  const m = PLACEHOLDER_EXACT_RE.exec(token);
  if (!m) return null;
  const cls = m[1];
  const digits = m[2];
  if (cls === undefined || digits === undefined || !isPlaceholderClass(cls)) return null;
  const index = Number.parseInt(digits, 10);
  if (!Number.isInteger(index) || index < 1) return null;
  return { cls, index };
}

/** Every placeholder occurring in a string, in order, duplicates included. */
export function extractPlaceholders(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const token = m[0];
    if (parsePlaceholder(token)) out.push(token);
  }
  return out;
}

/**
 * Hands out stable placeholders and holds the local rehydration map.
 *
 * The map never leaves the device and is never serialised. Callers get exactly two
 * verbs: allocate and resolve.
 *
 * SECRET is deliberately different (CLAUDE.md invariant 6). A secret's plaintext is
 * never handed to this class. `allocate('SECRET', vaultKey)` records a *vault key*, and
 * `resolve` returns that key -- the caller must then read the vault and get an explicit
 * user confirm before anything is typed. So a plan that invents SECRET_7 resolves to
 * nothing, and an allocator dumped into a bug report leaks no credential.
 */
export class PlaceholderAllocator {
  readonly sessionId: string;

  /** `${cls} ${value}` -> placeholder. Private: no iteration, no export. */
  readonly #byValue = new Map<string, string>();
  /** placeholder -> original value (or, for SECRET, a vault key). */
  readonly #byPlaceholder = new Map<string, string>();
  /** class -> highest index handed out so far. */
  readonly #counters = new Map<PlaceholderClass, number>();
  /**
   * Placeholders whose value came out of the operator's own sentence.
   *
   * Provenance travels with the token, not with the sighting. "leo" typed into the task
   * box and then typed by the executor into a field is the user's private data on both
   * occasions; the second sighting is our keystroke, but the datum is theirs. Recording
   * it here -- once, where the token is minted -- is what lets every later finding of the
   * same value inherit it, whichever layer notices.
   */
  readonly #fromUser = new Set<string>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * The placeholder for this value in this session. Idempotent: the same class and
   * value always come back to the same placeholder, which is what makes numbering
   * stable across steps.
   *
   * For SECRET, `value` must be a vault key, never the secret itself.
   */
  allocate(cls: PlaceholderClass, value: string, fromUser = false): string {
    if (!isPlaceholderClass(cls)) {
      throw new TypeError(`unknown placeholder class: ${String(cls)}`);
    }
    // A face is a region, not a string. Handing out «FACE_1» would create a token that
    // resolves to something -- and the only thing it could resolve to is a photograph,
    // which is the one substitution this project must never be able to perform. Refused
    // here rather than left to the caller, because "never" is not a convention.
    if (NO_VALUE.has(cls)) {
      throw new TypeError(`${cls} has no value to stand for and cannot be allocated`);
    }
    const key = `${cls} ${value}`;
    const existing = this.#byValue.get(key);
    if (existing !== undefined) {
      // A value first seen on the page and later recognised as the user's own gains the
      // provenance; it never loses it. The user's claim on a datum does not lapse because
      // something else saw it too.
      if (fromUser) this.#fromUser.add(existing);
      return existing;
    }

    const next = (this.#counters.get(cls) ?? 0) + 1;
    this.#counters.set(cls, next);
    const placeholder = formatPlaceholder(cls, next);
    this.#byValue.set(key, placeholder);
    this.#byPlaceholder.set(placeholder, value);
    if (fromUser) this.#fromUser.add(placeholder);
    return placeholder;
  }

  /** Did this token's value come from the operator's own sentence? */
  isFromUser(placeholder: string): boolean {
    return this.#fromUser.has(placeholder);
  }

  /**
   * The value behind a placeholder, or undefined when this session never issued it.
   * A planner that invents a placeholder gets undefined here -- callers must reject the
   * action, never type the placeholder literally.
   */
  resolve(placeholder: string): string | undefined {
    return this.#byPlaceholder.get(placeholder);
  }

  /** How many placeholders of a class this session has issued. Counts only, no values. */
  count(cls: PlaceholderClass): number {
    return this.#counters.get(cls) ?? 0;
  }
}
