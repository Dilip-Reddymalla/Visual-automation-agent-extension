/**
 * The value a field will actually accept, from the value a person said.
 *
 * ## Why this exists
 *
 * "DOB is 24th jan 2000" reached the right field on the real page, typed `24th jan 2000`
 * into it, and the field was empty a moment later. The box is `maxlength="10"`, its
 * placeholder is `DD-MM-YYYY`, its title says "Enter Date of Birth in DD-MM-YYYY Format",
 * and it runs `CheckDobDate()` on change. Nothing was wrong with the perception, the
 * resolution or the plan. The agent simply handed the page a string in a shape the page
 * does not take, and the page threw it away.
 *
 * A person does not do that. They read "DD-MM-YYYY" off the box and type `24-01-2000`. That
 * is not a reasoning problem and it should not cost a model call: the field states its own
 * format, in the placeholder, in the title, in `type="date"`, sometimes in `pattern`. This
 * module reads that statement and reshapes the value to match.
 *
 * ## Deterministic, and deliberately so
 *
 * Every rule here is a function of the field and the string. That matters more than it
 * sounds: a model asked to reformat a date is slower, is not reproducible between runs, and
 * has an opinion about which of 06/07 is the month. A parser has no opinion -- it reads the
 * order off the placeholder, and when the placeholder does not say, it does not guess.
 *
 * ## What it will not do
 *
 * Reformat on a hunch. If the field declares no format, the value is passed through
 * untouched apart from trimming. Inventing a shape for a field that never asked for one is
 * how you turn a value the user typed into a value they did not.
 *
 * Node-pure: takes a description of the field, not the field.
 */

/** What a field says about itself. Everything here is readable from the DOM. */
export interface FieldShape {
  inputType?: string;
  placeholder?: string;
  title?: string;
  pattern?: string;
  maxLength?: number;
}

export interface Formatted {
  text: string;
  /** What was done, for the step note. A shape, never a value. */
  note?: string;
}

// -- Date order, as the field states it ---------------------------------------

type Part = 'D' | 'M' | 'Y';

interface DateFormat {
  order: [Part, Part, Part];
  separator: string;
  /** Four-digit year, or two. */
  longYear: boolean;
}

/**
 * `DD-MM-YYYY`, `MM/DD/YY`, `YYYY-MM-DD` and the rest, wherever the field mentions one.
 *
 * Looked for in the placeholder first and the title second, because a placeholder is a
 * statement about this box and a title is often a sentence containing one. Both are how a
 * page tells a human what it wants, which is exactly the question being asked.
 */
const DATE_HINT = /\b([DMY]{1,4})([-/.])([DMY]{1,4})\2([DMY]{1,4})\b/i;

export function dateFormatOf(shape: FieldShape): DateFormat | undefined {
  // `type="date"` is the one case with no placeholder to read: the value a date input
  // takes is ISO, whatever the browser shows the user.
  if (shape.inputType === 'date') {
    return { order: ['Y', 'M', 'D'], separator: '-', longYear: true };
  }

  for (const source of [shape.placeholder, shape.title, shape.pattern]) {
    const match = source ? DATE_HINT.exec(source) : null;
    if (!match) continue;

    const parts = [match[1], match[3], match[4]].map((p) => (p ?? '').toUpperCase());
    const order = parts.map((p) => p[0]) as [Part, Part, Part];
    // Three distinct fields, or it is not a date format -- "MM-MM-YY" is a coincidence.
    if (new Set(order).size !== 3) continue;
    if (!order.every((p) => p === 'D' || p === 'M' || p === 'Y')) continue;

    const yearPart = parts[order.indexOf('Y')] ?? '';
    return { order, separator: match[2] ?? '-', longYear: yearPart.length >= 4 };
  }
  return undefined;
}

// -- Reading a date a person wrote --------------------------------------------

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** The month a word names, 1-12, or 0. Matches on the first three letters. */
function monthFrom(word: string): number {
  const lower = word.toLowerCase();
  if (lower.length < 3) return 0;
  const at = MONTHS.findIndex((name) => name.startsWith(lower.slice(0, 3)));
  // "may" is the only month that is also an English word; nothing here reads prose, so
  // the collision cannot arise -- this only ever sees a value the user gave as a date.
  return at + 1;
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

/**
 * The pivot for a two-digit year.
 *
 * A date of birth is in the past, so a year that would land in the future is the previous
 * century. "24-6-20" in 2026 is 2020; the same string in 2019 would have been 1920, and
 * both readings are defensible -- which is why this is stated rather than assumed. A field
 * that wants four digits and is given two has been given an ambiguous thing, and the
 * completion check re-reads the box afterwards so the operator sees what landed.
 */
function expandYear(yy: number, now: number): number {
  const century = Math.floor(now / 100) * 100;
  const candidate = century + yy;
  return candidate > now ? candidate - 100 : candidate;
}

/**
 * A date out of the ways people write one, or undefined.
 *
 * `order` is the field's declared order and is used only to break the genuine ambiguity in
 * an all-numeric date: 06/07/2000 is the sixth of July or the seventh of June depending on
 * who wrote it, and the *field* is the only thing on the page that knows which it wants.
 * Where the string itself settles it -- a month name, a four-digit year, a part above 12 --
 * the string wins, because that is evidence and the field's order is only a convention.
 */
export function parseDate(
  value: string,
  order?: [Part, Part, Part],
  now = new Date().getFullYear(),
): Ymd | undefined {
  // Ordinals, articles, commas and the word "of": "the 24th of Jan, 2000".
  const cleaned = value
    .toLowerCase()
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/g, '$1')
    .replace(/\b(of|the|on)\b|,/g, ' ')
    .trim();

  const words = cleaned.split(/[\s\-/.]+/).filter(Boolean);
  if (words.length !== 3) return undefined;

  const named = words.findIndex((w) => /[a-z]/.test(w) && monthFrom(w) > 0);
  if (named !== -1) {
    const month = monthFrom(words[named] ?? '');
    const rest = words.filter((_, i) => i !== named).map(Number);
    if (rest.some((n) => !Number.isFinite(n))) return undefined;
    // Whichever of the two is the year: the four-digit one, or the larger.
    const [a = 0, b = 0] = rest;
    const yearIsSecond =
      String(words.filter((_, i) => i !== named)[1] ?? '').length === 4 || b > 31;
    const y = yearIsSecond ? b : a;
    const d = yearIsSecond ? a : b;
    return finish({ y, m: month, d }, now);
  }

  const nums = words.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return undefined;
  const [a = 0, b = 0, c = 0] = nums;

  // A four-digit part is the year wherever it sits, and settles the rest by elimination.
  if (String(words[0]).length === 4) {
    return finish({ y: a, m: b, d: c }, now);
  }
  if (String(words[2]).length === 4 || c > 31) {
    // Day and month, in whichever order. A part above 12 cannot be a month.
    if (a > 12) return finish({ y: c, m: b, d: a }, now);
    if (b > 12) return finish({ y: c, m: a, d: b }, now);
    const dayFirst = !order || order.indexOf('D') < order.indexOf('M');
    return finish(dayFirst ? { y: c, m: b, d: a } : { y: c, m: a, d: b }, now);
  }

  // All three short, so nothing has declared itself a year. A part above 12 still cannot be
  // a month, and once the day is placed the rest follows the convention every day-first and
  // day-last format shares: the year sits at the far end from the day.
  const dayAt = [a, b, c].findIndex((n) => n > 12);
  if (dayAt === 0) return finish({ y: c, m: b, d: a }, now);
  if (dayAt === 2) return finish({ y: a, m: b, d: c }, now);

  // Genuinely ambiguous: three numbers, none of which can rule itself out. Only the field's
  // declared order can say, and without one there is nothing to go on -- 06/07/08 is three
  // different dates and picking one is a coin toss.
  if (!order) return undefined;
  const at = (part: Part): number => [a, b, c][order.indexOf(part)] ?? 0;
  return finish({ y: at('Y'), m: at('M'), d: at('D') }, now);
}

/** Expand a short year, then check the date is one. */
function finish(ymd: Ymd, now: number): Ymd | undefined {
  const y = ymd.y < 100 ? expandYear(ymd.y, now) : ymd.y;
  if (ymd.m < 1 || ymd.m > 12) return undefined;
  if (ymd.d < 1 || ymd.d > 31) return undefined;
  if (y < 1000 || y > 9999) return undefined;
  return { y, m: ymd.m, d: ymd.d };
}

function render(ymd: Ymd, format: DateFormat): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const year = format.longYear ? String(ymd.y).padStart(4, '0') : pad(ymd.y % 100);
  const parts = format.order.map((p) =>
    p === 'Y' ? year : p === 'M' ? pad(ymd.m) : pad(ymd.d),
  );
  return parts.join(format.separator);
}

// -- The one entry point -------------------------------------------------------

/**
 * Reshape a value to what the field says it takes.
 *
 * Applied to every `type` action from every tier, so a date said any of a dozen ways
 * reaches the page in the one way that page accepts -- whether the grammar, the local model
 * or the remote planner produced it.
 */
export function formatValue(value: string, shape: FieldShape, now?: number): Formatted {
  const trimmed = value.trim();
  if (!trimmed) return { text: trimmed };

  const format = dateFormatOf(shape);
  if (format) {
    const parsed = parseDate(trimmed, format.order, now);
    if (parsed) {
      const text = render(parsed, format);
      if (text !== trimmed) {
        return { text, note: `reformatted to ${format.order.join(format.separator)}` };
      }
      return { text };
    }
    // Says it wants a date and this is not one. Left alone: the page's own validation is
    // a better judge than a guess, and the completion check re-reads the field either way.
  }

  return { text: trimmed };
}
