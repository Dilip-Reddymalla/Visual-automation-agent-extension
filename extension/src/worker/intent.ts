/**
 * The user's sentence, turned into something the device can act on.
 *
 * This module exists because of a specific failure. A user typed "fill first name with
 * leo"; the agent filled Last Name and Subject with a canned email address and never
 * touched First Name. The cause was in our own comment in the planner: it was a pure
 * function of the element list. Nothing anywhere read the goal. We had built an agent
 * that could not hear its user.
 *
 * So: parse the sentence, here, on the device, with no model. A single-field instruction
 * is not a reasoning problem -- "fill X with Y" is a grammar, and a grammar is cheaper,
 * faster and more predictable than any model that could be asked the same question.
 *
 * What this deliberately does *not* do is try hard. If a sentence does not parse it is
 * not a failure, it is an open-ended task: "book the next available appointment" has no
 * target field and no value, and belongs to the planner. Returning nothing is the right
 * answer and the caller escalates.
 *
 * ## The residue rule (M16)
 *
 * Trying-not-very-hard is only safe if the parser knows how much of the sentence it did
 * not read. It did not. `PATTERNS[0]` is anchored at the end but not at the start, so
 * `fill` matched the `fill` inside "Dont fill last name with Leo" and the four characters
 * in front of the verb -- the four that reverse the instruction -- were discarded without
 * ever being looked at. The agent filled the field it had been told not to fill, and
 * reported success.
 *
 * So every character of the instruction is now accounted for. A clause records the span a
 * pattern consumed; anything left over is *residue*; and Tier 0 may act only on a sentence
 * with **zero** residue. Not a small amount, not a tolerable fraction -- none. A threshold
 * here is a promise that the words we skipped were unimportant, and the failure above is
 * exactly the case where the skipped words were the whole meaning.
 *
 * Filler that genuinely carries nothing ("please", "can you", "now") is consumed by an
 * explicit ignore list, so it is *visibly* consumed rather than silently tolerated. The
 * difference matters: an ignore list can be read and argued with, and a threshold cannot.
 *
 * Node-pure.
 */

import type { PlaceholderClass } from '../shared/placeholders';

export type IntentVerb = 'fill' | 'click' | 'select' | 'submit' | 'navigate';

export interface Intent {
  verb: IntentVerb;
  /** What the user called the thing: "first name", "the submit button". Normalised. */
  target: string;
  /**
   * The literal value to put there, when the sentence carried one.
   *
   * Raw, and this type is therefore device-only in exactly the way ObservedElement is.
   * What crosses the network is `valueRef`.
   */
  value?: string;
  /** The token standing in for `value`, once it has been through the allocator. */
  valueRef?: string;
  /** The class the value was recognised as, when it was recognised as anything. */
  cls?: PlaceholderClass;
  /**
   * The other way this clause reads, when `as` made it two-ways readable.
   *
   * The grammar cannot settle "enter DL Number as 10001000193" on its own: the pattern says
   * value-then-field, the sentence means field-then-value, and neither half is in any alias
   * table -- "DL Number" is a field on precisely one government website. What *can* settle
   * it is the page, which has a box captioned "DL Number" and nothing called 10001000193.
   *
   * So the parser stops guessing and hands both readings up. `chooseTier` scores the
   * primary, and falls back to this one when the page recognises it and not the other. That
   * is the same evidence a person uses, and it needs no vocabulary at all -- which is what
   * makes it work on a site nobody has seen before.
   */
  alt?: { target: string; value?: string };
}

/**
 * Why Tier 0 may not act on this sentence.
 *
 * Four kinds, and they are deliberately separate rather than one "could not parse": the
 * step note names the exact words nobody understood, and an escalation that cannot say
 * what it escalated on is a shrug with a log line.
 */
export type GoalBlock =
  /** A negation appeared anywhere in the goal. See NEGATIONS for why this refuses. */
  | { kind: 'negation'; token: string }
  /** Text no pattern and no ignore-list entry consumed. */
  | { kind: 'residue'; residue: string[]; coverage: number }
  /** A clause the grammar could not read at all. */
  | { kind: 'unparsed'; clause: string }
  /** A clause that reads two ways, both plausible. See the note on `as`. */
  | { kind: 'ambiguous'; clause: string; readings: [string, string] };

/** What became of one clause. `ignored` is a clause that was pure filler. */
export type ClauseOutcome = 'parsed' | 'unparsed' | 'ambiguous' | 'ignored';

export interface ClauseReport {
  text: string;
  outcome: ClauseOutcome;
  /** Words in this clause that nothing consumed. */
  residue: string[];
}

export interface ParsedGoal {
  intents: Intent[];
  /**
   * True when the sentence yielded nothing to act on.
   *
   * Recorded rather than inferred from an empty array, because "we understood the task
   * and it has no single target" and "we failed to parse" are the same shape and want
   * different words in the step log.
   */
  openEnded: boolean;
  /**
   * Every run of characters the parser did not consume, trimmed, in reading order.
   *
   * This is the field the failure above needed: for "Dont fill last name with Leo" it is
   * `['Dont']`, and one look at the step note says what went wrong.
   */
  residue: string[];
  /** Characters consumed divided by characters in the goal. 1 means all of it. */
  coverage: number;
  /** One entry per clause, in order, whatever became of it. */
  clauses: ClauseReport[];
  /** Set when Tier 0 must not act. Absent when it may. */
  block?: GoalBlock;
}

/**
 * Field names people use for the same field.
 *
 * Not a synonym dictionary and not trying to become one: these are the aliases that
 * appear on the corpus and on the demo pages, plus the handful an English speaker
 * reaches for without thinking. Anything not here still matches by substring, which is
 * what carries the long tail.
 */
const ALIASES: ReadonlyArray<readonly string[]> = [
  ['first name', 'firstname', 'given name', 'forename', 'fname'],
  ['last name', 'lastname', 'surname', 'family name', 'lname'],
  ['full name', 'fullname', 'name', 'your name'],
  ['email', 'e mail', 'email address', 'mail'],
  ['phone', 'mobile', 'telephone', 'phone number', 'mobile number', 'contact number'],
  ['address', 'street address', 'street'],
  ['date of birth', 'dob', 'birth date', 'birthday'],
  ['aadhaar', 'aadhar', 'uid', 'aadhaar number'],
  ['pan', 'pan number', 'permanent account number'],
  ['country', 'nation'],
  ['state', 'province', 'region'],
  ['subject', 'topic'],
  ['message', 'comments', 'comment', 'reason', 'details'],
  ['password', 'passcode', 'pin'],
  ['video', 'video player', 'player', 'media', 'movie', 'clip', 'audio', 'stream'],
  ['search', 'search box', 'search bar', 'search query', 'query', 'lookup', 'search input'],
  ['cart', 'shopping cart', 'basket', 'bag', 'add to cart', 'buy now'],
  ['from', 'origin', 'departure', 'source', 'leaving from', 'fly from', 'from city', 'source city', 'departure city'],
  ['to', 'destination', 'arrival', 'going to', 'fly to', 'to city', 'destination city', 'arrival city'],
  ['date', 'departure date', 'travel date', 'journey date', 'flight date', 'date of journey', 'date of travel', 'dd mm yyyy', 'dd/mm/yyyy', 'when'],
  ['all checkboxes', 'all checkbox', 'all the checkboxes', 'all the checkbox', 'all boxes', 'every checkbox', 'every checkboxes', 'checkboxes'],
  ['submit', 'send', 'save and continue', 'continue', 'apply', 'sign in', 'log in'],
];

/**
 * The row above that names buttons rather than fields.
 *
 * `labelledPair` reads "<field name> <value>" with no verb, and every entry in the alias
 * table is a candidate opener -- including these, which are not fields. "Apply with
 * asha.menon@example.in" then read as *filling* a field called Apply with "with
 * asha.menon@example.in", which is nonsense, and worse: an unclassifiable target mints no
 * placeholder, so the address was persisted to session storage in the clear. The sweep in
 * router.test.ts caught it.
 */
const BUTTON_ALIASES: readonly string[] = [
  'submit',
  'send',
  'save and continue',
  'continue',
  'apply',
  'sign in',
  'log in',
  'all checkboxes',
  'all checkbox',
  'all the checkboxes',
  'all the checkbox',
  'all boxes',
  'every checkbox',
  'every checkboxes',
  'checkboxes',
];

const ACTION_ALIASES: ReadonlySet<string> = new Set(BUTTON_ALIASES);

/** Lower case, no punctuation, single spaces. Applied to both sides of every match. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .replace(/[^a-z0-9@ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Check if the target refers to all checkboxes on the page. */
export function isAllCheckboxes(target: string): boolean {
  const norm = normalise(target);
  return (
    norm === 'all' ||
    norm === 'all the' ||
    norm === 'all checkbox' ||
    norm === 'all checkboxes' ||
    norm === 'all the checkbox' ||
    norm === 'all the checkboxes' ||
    norm === 'all boxes' ||
    norm === 'all the boxes' ||
    norm === 'every checkbox' ||
    norm === 'every checkboxes' ||
    norm === 'checkboxes'
  );
}

/**
 * Every way of naming the same field, including the one that was asked for.
 *
 * Returned rather than resolved to a canonical form, because the caller scores against
 * several element attributes and any of the aliases may be the one that matches: a field
 * whose label says "Given name" and whose autocomplete says "given-name" is found by
 * different members of the same row.
 */
export function aliasesOf(target: string): string[] {
  const wanted = normalise(target);
  for (const row of ALIASES) {
    if (row.some((alias) => alias === wanted)) return [...row];
  }
  // A target the table does not know is still a target. Its own text is the only alias.
  return wanted ? [wanted] : [];
}

/**
 * Words that mark a goal as reading rather than doing.
 *
 * Three shapes, and each is one the form-fill reader cannot express:
 *
 *   navigate-and-look   scroll, then see/look at what loaded
 *   extract-and-report  show, find, read, list, count, tell, summarise, compare
 *   ask-a-question      what, which, who, where, when, why, how, most, least, best
 *
 * Not a synonym dictionary. It is the minimum that separates "show me the most liked
 * comment" from "put my name down as Asha" -- the first has an answer the agent must
 * read off the page and speak back, the second has a value to type into a box.
 *
 * ## What is deliberately absent, and why
 *
 * A single member anywhere in the sentence flips the whole step to Tier 2, so a word
 * that also lives in an ordinary fill or click command is not a reading signal -- it is
 * a landmine. Excluded on that ground:
 *
 *   first, last, top   field names -- "first name", "last name", "top up amount".
 *   many, much         quantities, not questions -- "how much" already fires on "how".
 *   get, go, open,     each is a click by another name -- "get started", "go", "open
 *   watch, play, view,   menu", the play button. The reader clicking one of these is
 *   browse, visit        the correct action, not a hijack, so let it.
 *
 * The asymmetry that sets the cut: a false positive escalates a step that Tier 2 can
 * still do; a false negative lets the 1.5B reader click a plausible button and report
 * done having read nothing. So the kept words lean toward recall -- but never onto a
 * word that a fill sentence would carry.
 */
const READING_WORDS: ReadonlySet<string> = new Set([
  // Navigate and look. Only `scroll` forces new content to load; see/look name the intent.
  'scroll', 'see', 'look',
  // Extract and report.
  'show', 'find', 'read', 'list', 'count', 'tell', 'display', 'summarise', 'summarize',
  'describe', 'compare', 'inspect', 'extract', 'report',
  // Ask a question, and rank.
  'what', 'whats', 'which', 'who', 'whose', 'whom', 'where', 'when', 'why', 'how',
  'most', 'least', 'best', 'worst', 'highest', 'lowest', 'largest', 'smallest',
  'cheapest', 'latest', 'newest', 'oldest',
]);

/**
 * Is this goal asking the agent to read the page rather than act on a field?
 *
 * Consulted only for a goal the grammar could not parse -- a `fill` sentence never
 * reaches here. So its whole job is to keep the Tier 1 form-fill reader from hijacking an
 * information task: the reader can only `type`, `click` or `select` on a shortlist of
 * controls (worker/local.ts), so asked to "show the most liked comment" it clicks the
 * likeliest-looking button, and a bare click passes every guard in verify-plan.ts because
 * a click carries no value to invent. It reports done having read nothing.
 *
 * A reading task belongs to Tier 2, whose planner can scroll, re-perceive and `finish`
 * with the answer in its summary (server/planner.py already carries the worked examples).
 * So when this is true the reader is skipped and the step escalates straight there.
 *
 * Word-membership rather than a pattern: a single reading word anywhere in a sentence the
 * grammar already declined is enough, and a list can be read and argued with.
 */
export function isReadingTask(goal: string): boolean {
  const words = normalise(goal).split(' ');
  return words.some((word) => READING_WORDS.has(word));
}

/**
 * Filler that sits between the verb and the field name.
 *
 * "fill in the first name box" and "fill first name" name the same field, and the
 * difference is entirely words that carry nothing. Stripped from the target rather than
 * matched around, so the scorer downstream compares field names to field names.
 */
const TARGET_NOISE =
  /^(in|into|the|a|an|my|his|her|their|its|field|box|input|textbox|button|dropdown|checkbox|radio|option|switch|of)\b/;
const TARGET_TAIL = /\b(field|box|input|textbox|button|dropdown|menu|checkbox|checkboxes|radio|radios|option|options|switch|switches)$/;

function cleanTarget(raw: string): string {
  const norm = normalise(raw);
  if (/^(all|every)\s+(?:the\s+)?(checkbox|checkboxes|box|boxes)$/i.test(norm)) {
    return 'all checkboxes';
  }
  let target = norm;
  // Peel leading filler one word at a time: "in the first name" -> "first name".
  for (;;) {
    const next = target.replace(TARGET_NOISE, '').trim();
    if (next === target) break;
    target = next;
  }
  return target.replace(TARGET_TAIL, '').trim();
}

/**
 * The phrasings, in the order they are tried.
 *
 * Longest and most specific first, because "type leo in first name" also matches the
 * looser "type <value>" shape, and the loose one would take "leo in first name" as the
 * value. Each pattern names which capture is the target and which is the value; nothing
 * here infers position.
 */
interface Pattern {
  re: RegExp;
  verb: IntentVerb;
  target: number | string;
  value?: number;
}

const PATTERNS: readonly Pattern[] = [
  // Target first: "fill first name with leo", "set my email to x@y.in".
  //
  // `as` is deliberately absent from this separator list. English puts the *value* first
  // after it -- "enter Asha Menon as full name" names the value, then the field -- and
  // accepting `as` in both patterns let this one win and read the sentence backwards,
  // giving target "asha menon" and value "full name".
  {
    re: /\b(?:fill|set|change|update|enter)\s+(.{1,60}?)\s+(?:with|to|=)\s+(.{1,120}?)\s*$/i,
    verb: 'fill',
    target: 1,
    value: 2,
  },
  // Value first: "type leo in the first name box", "enter Asha Menon as full name".
  {
    re: /\b(?:type|put|write|input|enter)\s+(.{1,120}?)\s+(?:in|into|as|for)\s+(.{1,60}?)\s*$/i,
    verb: 'fill',
    target: 2,
    value: 1,
  },
  // "choose India in country", "select Karnataka for state"
  {
    re: /\b(?:choose|select|pick)\s+(.{1,60}?)\s+(?:in|for|from|as)\s+(.{1,60}?)\s*$/i,
    verb: 'select',
    target: 2,
    value: 1,
  },
  // "check the flexible with date checkbox", "uncheck newsletter", "tick terms and conditions", "toggle dark mode"
  {
    re: /\b(?:check|uncheck|tick|untick|toggle|enable|disable)\s+(.{1,60}?)\s*$/i,
    verb: 'click',
    target: 1,
  },
  // "open spotify", "go to amazon.in", "navigate to https://google.com"
  {
    re: /\b(?:open|go\s+to|navigate\s+to|visit)\s+(.{1,120}?)\s*$/i,
    verb: 'navigate',
    target: 1,
  },
  // "search for best mobile phone under 30k", "search blinding lights"
  {
    re: /\b(?:search\s+for|search)\s+(.{1,120}?)\s*$/i,
    verb: 'fill',
    target: 'search',
    value: 1,
  },
  // "add to cart", "add into cart", "buy now"
  {
    re: /\b(?:add\s+(?:to|into)\s+cart|add\s+to\s+bag|buy\s+now)\s*$/i,
    verb: 'click',
    target: 'cart',
  },
  // "start the video from 6 min 20 sec", "seek video to 6:20", "play video from 3:40"
  {
    re: /\b(?:start|play|seek|jump|skip|fast forward)\s+(?:the\s+)?(video|audio|media|track|clip|player)\s+(?:from|to|at)\s+(.{1,60}?)\s*$/i,
    verb: 'fill',
    target: 1,
    value: 2,
  },
  // "play the video", "pause the video", "resume video"
  {
    re: /\b(play|pause|stop|resume)\s+(?:the\s+)?(video|audio|media|track|clip|player)\s*$/i,
    verb: 'click',
    target: 2,
  },
  // "click submit", "press the apply button", "select flexible with date"
  { re: /\b(?:click|press|tap|push|select|choose|pick)\s+(.{1,60}?)\s*$/i, verb: 'click', target: 1 },
  // "submit the form"
  { re: /\b(submit)\b(?:\s+the\s+form)?\s*$/i, verb: 'submit', target: 1 },
];

/**
 * Split a goal into the clauses that might each carry an instruction.
 *
 * Commas, "and", "then", and sentence ends. Over-splitting is safer than running one
 * pattern across two instructions and taking half of each as a value.
 *
 * A full stop splits only when a space or the end follows it. Splitting on every dot cut
 * `x@y.in` down to `x@y` -- a value silently truncated rather than a parse that failed,
 * which is the worse of the two, because the agent then goes and types it.
 *
 * What is emphatically no longer true is the sentence that used to end this comment: "a
 * clause that does not parse costs nothing". It cost a field. "Fill last name with leo and
 * subject as Write Something" splits into two clauses, the first parsed, the second did
 * not, and the second was dropped on the floor -- the agent filled Last Name, left Subject
 * empty and said the task was done. A clause that does not parse is an instruction the
 * user gave that nobody will carry out. It costs exactly that.
 *
 * Positions come back with the text, because residue is measured in characters of the
 * original sentence and a clause trimmed out of its context cannot say where its own
 * leftovers were.
 */
interface Span {
  text: string;
  start: number;
  end: number;
}

/**
 * Where one clause ends and the next begins.
 *
 * The comma carries a caveat. `,(?!\d{3}(?!\d))` refuses to split inside a thousands
 * group: without it "under 30,000" is two clauses -- "under 30" and "000" -- and the
 * limit the user stated is read as thirty. That is not a decomposition problem, it is
 * this splitter's, and "fill amount with 1,200" had the same shape all along.
 */
const SEPARATOR =
  /[;\n]+|,(?!\d{3}(?!\d))|\.(?=\s|$)|\b(?:and then|then)\b|(?<!\b(?:terms|save))\s+\band\b(?!\s+(?:conditions|continue|privacy\b))|(?<=\S)\s+(?=\b(?:tick|check|uncheck|untick|toggle)\s+(?:all\s+)?(?:the\s+)?(?:checkbox|checkboxes|box|boxes)\b)|(?<=\b(?:from|origin|source)\s+\S+)\s+(?=\b(?:to|destination)\s+)|(?<=\S)\s+(?=\b(?:dd[/-]mm[/-]yyyy|ddmmyyyy)\b)/gi;

function clauses(goal: string): Span[] {
  const out: Span[] = [];
  let at = 0;
  SEPARATOR.lastIndex = 0;
  for (let m = SEPARATOR.exec(goal); m; m = SEPARATOR.exec(goal)) {
    pushSpan(out, goal, at, m.index);
    at = m.index + m[0].length;
  }
  pushSpan(out, goal, at, goal.length);
  return out;
}

function pushSpan(out: Span[], goal: string, from: number, to: number): void {
  const raw = goal.slice(from, to);
  const text = raw.trim();
  if (!text) return;
  const lead = raw.length - raw.trimStart().length;
  out.push({ text, start: from + lead, end: from + lead + text.length });
}

// -- The ignore list ----------------------------------------------------------

/**
 * Politeness, and nothing else.
 *
 * The residue rule is absolute, so something has to account for "can you please" -- and
 * the choice is between a list you can read and a threshold you cannot. A list is wrong in
 * ways that can be pointed at; a threshold is wrong in ways that look like working.
 *
 * Longest first, so "can you please" is consumed whole rather than leaving "you please".
 */
const LEADING_FILLER: readonly string[] = [
  'i would like you to',
  'i want you to',
  'could you please',
  'would you please',
  'can you please',
  'please could you',
  'please can you',
  'i need you to',
  'go ahead and',
  'could you',
  'would you',
  'can you',
  'for me',
  'please',
  'kindly',
  'where',
  'just',
  'now',
  'pls',
  'plz',
];

/**
 * Filler at the *end* of a clause, which is a different and more dangerous problem.
 *
 * Leading filler sits in front of the verb, where nothing else can be. Trailing filler sits
 * where the value is -- and "fill message with call me now" ends in a word on this list
 * that is unmistakably part of the message. Stripping it there would be a value silently
 * truncated, which this project has already learned is worse than a parse that failed,
 * because the agent goes and types the truncation.
 *
 * So trailing filler comes off a value only when the *field* the user named has a known
 * class: a first-name box, an email box, a phone box. Those hold shaped values and "now"
 * is not part of a person's name. A subject or a message box keeps every character.
 */
const TRAILING_FILLER: readonly string[] = [
  'thank you',
  'for me',
  'please',
  'thanks',
  'now',
  'ok',
  'okay',
];

/** Peel entries off the front, longest first. Returns the rest and how much was eaten. */
function eatLeading(text: string): { rest: string; eaten: number } {
  let rest = text;
  let eaten = 0;
  for (;;) {
    const lower = rest.toLowerCase();
    const hit = LEADING_FILLER.find(
      (word) => lower.startsWith(word) && /^([\s,]|$)/.test(lower.slice(word.length)),
    );
    if (!hit) return { rest, eaten };
    const after = rest.slice(hit.length).replace(/^[\s,]+/, '');
    eaten += rest.length - after.length;
    rest = after;
  }
}

/** The same from the back. Only applied where the caller has decided it is safe. */
function eatTrailing(text: string): { rest: string; eaten: number } {
  let rest = text;
  let eaten = 0;
  for (;;) {
    const lower = rest.toLowerCase();
    const hit = TRAILING_FILLER.find(
      (word) =>
        lower.endsWith(word) && /([\s,]|^)$/.test(lower.slice(0, lower.length - word.length)),
    );
    if (!hit) return { rest, eaten };
    const before = rest.slice(0, rest.length - hit.length).replace(/[\s,]+$/, '');
    eaten += rest.length - before.length;
    rest = before;
  }
}

// -- Negation -----------------------------------------------------------------

/**
 * Words that mean the sentence is not a plain instruction. Tier 0 refuses on any of them.
 *
 * The residue rule already catches "Dont fill last name with Leo" structurally, and this
 * rule is here anyway, because negation is the one error class where being wrong *inverts*
 * the action rather than merely misplacing it. A misresolved field types the right value in
 * the wrong box, and anyone looking at the page sees it. A misread negation does the thing
 * the user explicitly forbade, and the page then looks exactly as it would have if they had
 * asked for it.
 *
 * Two cheaper rules were considered and rejected. Stripping the token and parsing the rest
 * is precisely how "don't fill X" becomes "fill X". Implementing scope -- "fill everything
 * except the email" -- is a reasoning problem about how far the negation reaches, and
 * reasoning problems are what a planner is for. Refuse, and name the word that caused it.
 *
 * `n't` is spelled out as its members rather than written as a suffix pattern. A pattern
 * like `n'?t` also matches "account", "want" and "print", and a grammar that refuses to
 * fill an account-number field would be its own severity-one bug.
 */
export const NEGATIONS: readonly string[] = [
  'instead of',
  'rather than',
  'but not',
  'do not',
  "don't",
  'dont',
  'never',
  'without',
  'except',
  'unless',
  'avoid',
  'skip',
  'not',
  "can't",
  'cant',
  "won't",
  "isn't",
  "aren't",
  "didn't",
  "doesn't",
  "shouldn't",
  "wouldn't",
  "couldn't",
  "haven't",
  "hasn't",
  'didnt',
  'doesnt',
  'isnt',
  'arent',
  'shouldnt',
  'wouldnt',
  'couldnt',
  'havent',
  'hasnt',
];

/**
 * The first negation in the goal, or undefined.
 *
 * Matched on the lower-cased original rather than on `normalise`, which strips apostrophes
 * and would turn "don't" into "don t" -- leaving the shortest and most important entries on
 * the list unmatchable. Boundaries are written out because `\b` does not mean what you want
 * next to an apostrophe.
 */
export function findNegation(goal: string): string | undefined {
  const text = goal.toLowerCase();
  let best: { token: string; at: number } | undefined;

  for (const token of NEGATIONS) {
    const at = text.search(new RegExp(`(?<![a-z0-9'])${token}(?![a-z0-9'])`));
    if (at === -1) continue;
    const better =
      !best || at < best.at || (at === best.at && token.length > best.token.length);
    if (better) best = { token, at };
  }

  return best?.token;
}

/**
 * What a field of this name holds, when the field name is enough to say.
 *
 * The value in "fill first name with leo" is PII and nothing in the project would have
 * noticed: L1 finds structured identifiers by their shape, and "leo" has no shape. What
 * classifies it is the field the user named -- a value going into a first-name box is a
 * person's name, and that is a fact about the sentence rather than a guess about the
 * string.
 *
 * Only the unambiguous ones. A target this table does not know yields no class, the value
 * is not tokenised on the strength of a guess, and L1 still gets its own look at it.
 */
const TARGET_CLASS: ReadonlyArray<readonly [string, PlaceholderClass]> = [
  ['first name', 'PERSON'],
  ['last name', 'PERSON'],
  ['full name', 'PERSON'],
  ['email', 'EMAIL'],
  ['phone', 'PHONE'],
  ['address', 'ADDRESS'],
  ['date of birth', 'DOB'],
  ['aadhaar', 'AADHAAR'],
  ['pan', 'PAN'],
  ['password', 'SECRET'],
];

/** The class a value takes from the field it was named for, if any. */
export function classForTarget(target: string): PlaceholderClass | undefined {
  const aliases = aliasesOf(target);
  for (const [name, cls] of TARGET_CLASS) {
    if (aliases.includes(name)) return cls;
  }
  return undefined;
}

/**
 * Is this a field name the alias table recognises?
 *
 * Used only to decide ambiguity, and deliberately strict: "does the table know it" is a
 * question with a yes or a no, whereas "is this plausibly a field name" is a judgement and
 * would need exactly the reasoning this layer exists to avoid.
 */
export function isKnownField(target: string): boolean {
  const wanted = normalise(target);
  return ALIASES.some((row) => row.includes(wanted));
}

/**
 * The field name hiding inside a longer phrase, if there is one.
 *
 * `isKnownField` asks whether a capture *is* a field name. This asks whether it *contains*
 * one, which is the question the `as` readings actually turn on: "my first name down" is
 * not a field name and unmistakably names one.
 *
 * Longest match wins, so "first name" beats "name" in "my first name down" -- taking the
 * shorter one would resolve to whichever name field the page happened to list first, which
 * is the coin-toss this whole layer exists to avoid.
 */
export function fieldWithin(text: string): string | undefined {
  const haystack = ` ${normalise(text)} `;
  let best: string | undefined;
  let bestCanonical: string | undefined;
  for (const row of ALIASES) {
    for (const alias of row) {
      if (!haystack.includes(` ${alias} `)) continue;
      if (!best || alias.length > best.length) {
        best = alias;
        bestCanonical = row[0];
      }
    }
  }
  return bestCanonical ?? best;
}

/**
 * One clause, read.
 *
 * `consumed` counts only characters the parser actually *read* -- not characters it walked
 * past. That distinction is the entire module. Every pattern is anchored at the end and not
 * at the start, so a match reports where it began, and everything before that point is text
 * a rule skipped over on its way to a verb. Counting `match.index + match[0].length` as
 * consumed -- the end offset, which is the easy mistake -- says a sentence was fully read
 * whenever a rule matched anywhere in it, which is exactly the bug being fixed.
 */
interface ClauseParse {
  outcome: ClauseOutcome;
  intent?: Intent;
  consumed: number;
  /** Runs of the clause nothing accounted for, trimmed, in reading order. */
  residue: string[];
  /** For an ambiguous clause: the two field names it could be naming. */
  readings?: [string, string];
}

/** The text on either side of a match: what a rule stepped over, and what it left behind. */
function around(clause: string, from: number, to: number): string[] {
  return [clause.slice(0, from).trim(), clause.slice(to).trim()].filter(
    (part) => part.length > 0,
  );
}

/**
 * Read one clause, and say exactly how much of it was read.
 *
 * The span accounting is the whole point. Every pattern is anchored at the end but not at
 * the start, so `match.index` is the number of characters in front of the verb that no
 * pattern looked at -- four of them, in the sentence that started this module.
 */
/**
 * Whole clauses that set context for the instruction without naming a field or value.
 * Ignored so that multi-clause sentences like "fill the form, where first name is dilip" do not fail.
 */
const PREAMBLE_CLAUSES: readonly string[] = [
  'fill the form',
  'fill in the form',
  'fill out the form',
  'complete the form',
  'fill form',
  'fill in form',
  'fill out form',
  'complete form',
  'fill the details',
  'fill in the details',
  'fill out the details',
];

function parseClause(raw: string): ClauseParse {
  const lead = eatLeading(raw);
  const clause = lead.rest;

  // A clause of pure politeness or preamble filler ("fill the form"). Understood to mean nothing,
  // which is different from not understood.
  if (!clause || PREAMBLE_CLAUSES.includes(normalise(clause))) {
    return { outcome: 'ignored', consumed: raw.length, residue: [] };
  }

  for (const pattern of PATTERNS) {
    const match = pattern.re.exec(clause);
    if (!match) continue;

    const rawTarget =
      typeof pattern.target === 'string'
        ? pattern.target
        : (match[pattern.target] ?? '');
    const targetIsLast =
      typeof pattern.target === 'number' &&
      pattern.value !== undefined &&
      pattern.target > pattern.value;

    // A target at the end of the clause may carry trailing politeness -- "type leo in the
    // first name box please". A target never legitimately ends in "please", so this one is
    // unconditional, unlike the value case below.
    const target =
      pattern.verb === 'navigate'
        ? rawTarget.trim()
        : cleanTarget(targetIsLast ? eatTrailing(rawTarget).rest : rawTarget);
    if (!target) break;

    // `as` reads both ways and no regex can tell which. "enter Asha Menon as full name"
    // names the value then the field; "select state as telangana" names the field then the
    // value. The pattern has to commit to one, and whichever it commits to is wrong half
    // the time -- so the commitment is checked against what the page could plausibly have.
    //
    //   both halves name a field   -> ambiguous, and Tier 1 is asked
    //   only the pattern's half    -> the pattern was right
    //   only the *other* half      -> the pattern was backwards; swap
    //   neither                    -> nothing to go on; leave it as the pattern read it
    //
    // The swap is the case this was missing. "Select state as telangana" gave target
    // "telangana" and value "state", so the agent looked for a field called Telangana on a
    // page whose only dropdown was the state one, found nothing, and died at a planner.
    let intentTarget = target;
    let valueCapture: number | undefined = pattern.value;
    let otherReading = '';

    if (
      typeof pattern.target === 'number' &&
      /\bas\b/i.test(match[0]) &&
      pattern.value !== undefined
    ) {
      const other = cleanTarget(match[pattern.value] ?? '');
      otherReading = other;
      const hereIsField = fieldWithin(target);
      const thereIsField = fieldWithin(other);

      if (other && hereIsField && thereIsField) {
        return {
          outcome: 'ambiguous',
          consumed: lead.eaten + match[0].length,
          residue: around(clause, match.index, match.index + match[0].length),
          readings: [target, other],
        };
      }

      if (other && thereIsField && !hereIsField) {
        // Read backwards, and the alias table can say so. The field name is trimmed out of
        // the phrase that carried it, so "my first name down" becomes "first name" rather
        // than a target nothing matches.
        intentTarget = thereIsField;
        valueCapture = pattern.target;
        otherReading = target;
      }
    }

    const intent: Intent = { verb: pattern.verb, target: intentTarget };
    const cls = classForTarget(intentTarget);
    if (cls) intent.cls = cls;

    // Both readings of `as`, when they differ. See Intent.alt.
    if (otherReading && otherReading !== intentTarget && typeof pattern.target === 'number') {
      // Whichever capture the primary reading did *not* take as its value.
      const altCapture = valueCapture === pattern.target ? pattern.value : pattern.target;
      const altValue =
        altCapture === undefined
          ? ''
          : (match[altCapture] ?? '').trim().replace(/^["']|["']$/g, '');
      intent.alt = altValue
        ? { target: otherReading, value: altValue }
        : { target: otherReading };
    }

    if (valueCapture !== undefined) {
      // The value keeps its case and punctuation: it is going to be typed verbatim, and
      // "Leo" is not "leo" in a name field.
      let value = (match[valueCapture] ?? '').trim().replace(/^["']|["']$/g, '');
      // Trailing politeness comes off only where the field's class says the value has a
      // shape. See TRAILING_FILLER: "fill message with call me now" keeps its "now".
      if (cls && !targetIsLast) value = eatTrailing(value).rest;
      if (value) intent.value = value;
    }

    return {
      outcome: 'parsed',
      intent,
      consumed: lead.eaten + match[0].length,
      residue: around(clause, match.index, match.index + match[0].length),
    };
  }

  // No verb, but a field name at the front and something after it.
  //
  // "date of birth 24/06/2000" is not an instruction the way the patterns above mean it --
  // there is no verb at all -- and it is the commonest shorthand anybody types. It is also
  // the shape of a form filled down the page one line at a time, which is a real transcript
  // this project has already had to handle.
  //
  // Read *after* the patterns, never instead of them, so an explicit verb always wins. And
  // it is not a sixth pattern: the evidence is the alias table saying the clause opens with
  // a field name, which is the same evidence `as` is settled by. The page gets the final
  // say through `alt`, exactly as it does there.
  const pair = labelledPair(clause);
  if (pair) {
    return {
      outcome: 'parsed',
      intent: pair,
      consumed: lead.eaten + clause.length,
      residue: [],
    };
  }

  // Nothing read it. The whole clause, less any politeness peeled off the front, is text
  // the user wrote and nobody will act on.
  return { outcome: 'unparsed', consumed: lead.eaten, residue: [clause] };
}

/**
 * Words that join a field name to its value, and carry nothing themselves.
 *
 * "DOB is 24th jan 2000", "state: telangana", "name - leo". Stripped so the value is the
 * value; kept short, because anything longer than a copula is probably a sentence.
 */
const PAIR_JOINERS = /^(?:is|as|=|:|-|to|was|should be|shall be|will be|means)\s*/i;

/**
 * A clause that names a field and then gives its value, with no verb between them.
 *
 * Returns nothing unless the clause *opens* with a name the alias table knows. That is the
 * whole guard: "book the next available appointment" opens with a verb nobody knows, "fill
 * in this form for me" opens with one that is not a field, and neither produces an intent.
 * The remainder must also say something -- a field name followed by nothing but filler is
 * a fragment, not an instruction.
 */
export function labelledPair(clause: string): Intent | undefined {
  const opener = openingField(clause) ?? openerBeforeValue(clause);
  if (!opener) return undefined;

  const rest = clause.slice(opener.length).replace(/^[\s,:=-]+/, '');
  const value = rest
    .replace(PAIR_JOINERS, '')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!value) return undefined;

  // A remainder made only of the words the instruction is asked in is not a value. Without
  // this "name the file" reads as filling a name field with "the file".
  const words = normalise(value).split(' ').filter(Boolean);
  if (words.length === 0) return undefined;

  const target = fieldWithin(opener) ?? normalise(opener);
  const intent: Intent = { verb: 'fill', target, value };
  const cls = classForTarget(target);
  if (cls) intent.cls = cls;
  return intent;
}

/**
 * Something that is unmistakably a value, ending a clause that has no verb.
 *
 * The alias table cannot cover the web. "DL Number 10001000193" is a field on precisely one
 * government website, and a table that grew to hold it would still miss the next site --
 * which is the wrong shape of answer for a tool that has to work on a page nobody has seen.
 *
 * What generalises is the *value*. A bare number, a date, an email or an identifier sitting
 * at the end of a verbless clause is not prose: it is the thing being entered, and whatever
 * comes before it is what it is being entered into. That reading needs no vocabulary, and
 * the page still gets the last word -- an opener naming nothing resolves to nothing and the
 * step escalates exactly as it did before.
 *
 * Deliberately narrow. The tail must be entirely value-shaped, the head must be one to four
 * words, and the head must say something of its own: without that, "book me a table for 4"
 * reads as filling a field called "book me a table for".
 */
const VALUE_TOKEN = /^(?:\d[\d\-/.:]*|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/;
const MAX_OPENER_WORDS = 4;

function openerBeforeValue(clause: string): string | undefined {
  const words = [...clause.matchAll(/\S+/g)];
  if (words.length < 2) return undefined;

  // The longest run of value-shaped tokens at the end.
  let firstValue = words.length;
  while (firstValue > 0 && VALUE_TOKEN.test(words[firstValue - 1]?.[0] ?? '')) firstValue -= 1;

  if (firstValue === words.length) return undefined; // nothing value-shaped at the end
  if (firstValue === 0) return undefined; // all value, no field name
  if (firstValue > MAX_OPENER_WORDS) return undefined; // that is a sentence, not a caption

  const head = words.slice(0, firstValue).map((w) => w[0]);
  // A head of nothing but the words instructions are asked in is not a field name.
  if (head.every((word) => STOP_HEAD.has(normalise(word)))) return undefined;
  // Nor is one that opens with a button. "Apply with asha@example.in" is a thing to click
  // and an address, not a field called "apply with".
  if (ACTION_ALIASES.has(normalise(head[0] ?? ''))) return undefined;

  const last = words[firstValue - 1];
  return clause.slice(0, (last?.index ?? 0) + (last?.[0].length ?? 0));
}

/** Words that cannot, alone, be what somebody called a field. */
const STOP_HEAD = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'be',
  'by',
  'for',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'that',
  'the',
  'then',
  'with',
  'you',
  'your',
]);

/**
 * The longest field name this clause starts with, in the clause's own characters.
 *
 * Matched against the normalised text but measured against the original, so the value that
 * follows keeps its case and punctuation -- "DOB is 24th Jan 2000" must not become
 * "24th jan 2000" on its way to a field.
 */
function openingField(clause: string): string | undefined {
  const lower = normalise(clause);
  let best = '';
  for (const row of ALIASES) {
    for (const alias of row) {
      // Buttons are not fields, and a pair has no verb to say otherwise.
      if (ACTION_ALIASES.has(alias)) continue;
      if (lower !== alias && !lower.startsWith(`${alias} `)) continue;
      if (alias.length > best.length) best = alias;
    }
  }
  if (!best) return undefined;

  // Walk the original forward by the same number of words, so punctuation between them
  // ("date-of-birth", "date of birth:") does not shift the boundary.
  const wanted = best.split(' ').length;
  let seen = 0;
  let at = 0;
  const parts = clause.matchAll(/[A-Za-z0-9@]+/g);
  for (const part of parts) {
    seen += 1;
    at = (part.index ?? 0) + part[0].length;
    if (seen === wanted) break;
  }
  return clause.slice(0, at);
}

/**
 * Parse a goal. Never throws, and an unparseable goal is a normal outcome.
 *
 * Three things come out and all three are needed downstream. `intents` is what Tier 0 would
 * act on. `residue` and `coverage` say how much of the sentence that acting would be
 * ignoring. `block`, when set, says Tier 0 must not act at all and why -- and the "why" is
 * the part that was missing: an agent that escalates without being able to name what it did
 * not understand is only slightly better than one that guesses.
 *
 * `openEnded` keeps its old meaning: nothing matched, which is the common case for a real
 * task and is exactly what the remote planner exists for.
 */
export function parseGoal(goal: string): ParsedGoal {
  const intents: Intent[] = [];
  const reports: ClauseReport[] = [];
  const residue: string[] = [];
  let consumedChars = 0;
  let firstUnparsed: string | undefined;
  let firstAmbiguous: ClauseParse | undefined;
  let ambiguousText = '';

  const spans = clauses(goal);
  // Separators and the whitespace between clauses are understood by the splitter, so they
  // count as consumed. Only what is inside a clause and unaccounted for is residue.
  const inClauses = spans.reduce((sum, span) => sum + span.text.length, 0);
  consumedChars = goal.length - inClauses;

  let parsedClauses = 0;

  for (const span of spans) {
    const parsed = parseClause(span.text);
    consumedChars += parsed.consumed;
    residue.push(...parsed.residue);

    reports.push({ text: span.text, outcome: parsed.outcome, residue: parsed.residue });

    if (parsed.intent) intents.push(parsed.intent);
    if (parsed.outcome === 'parsed') parsedClauses += 1;
    if (parsed.outcome === 'unparsed' && firstUnparsed === undefined) {
      firstUnparsed = span.text;
    }
    if (parsed.outcome === 'ambiguous' && !firstAmbiguous) {
      firstAmbiguous = parsed;
      ambiguousText = span.text;
    }
  }

  const coverage =
    goal.length === 0 ? 1 : Math.min(1, Math.max(0, consumedChars / goal.length));
  const openEnded = intents.length === 0;

  return {
    intents,
    openEnded,
    residue,
    coverage,
    clauses: reports,
    ...blockFor({
      goal,
      residue,
      coverage,
      parsedClauses,
      unparsed: firstUnparsed,
      ambiguous: firstAmbiguous?.readings,
      ambiguousText,
    }),
  };
}

interface BlockInput {
  goal: string;
  residue: string[];
  coverage: number;
  /** How many clauses yielded an intent. Zero means the sentence was not an instruction. */
  parsedClauses: number;
  unparsed?: string;
  ambiguous?: [string, string];
  ambiguousText: string;
}

/**
 * Why Tier 0 may not act, most specific reason first.
 *
 * Negation leads, because it is the only reason where acting does the *opposite* of what
 * was asked; an operator reading the step note should be told that rather than told about
 * the residue it also happens to produce.
 *
 * Then the open-ended escape hatch, and its position is the load-bearing part. "Book the
 * next available appointment" consumes nothing, so by the letter of the residue rule it is
 * a sentence we failed to read. It is not: it is a task with no single target, which is the
 * normal case for real work and exactly what the remote planner exists for. A goal where
 * *no* clause parsed is open-ended; a goal where some clauses parsed and others did not is
 * a half-understood instruction, which is a different and more dangerous thing. Collapsing
 * the two would file every ordinary task under "did not understand", and a log in which
 * everything is a comprehension failure says nothing when something really is one.
 *
 * After that, `unparsed` before `residue`, because a whole clause nobody read names itself
 * more usefully than the leftovers it contributes.
 */
function blockFor(input: BlockInput): { block?: GoalBlock } {
  const negation = findNegation(input.goal);
  if (negation) return { block: { kind: 'negation', token: negation } };

  if (input.parsedClauses === 0 && !input.ambiguous) return {};

  if (input.unparsed !== undefined) {
    return { block: { kind: 'unparsed', clause: input.unparsed } };
  }
  if (input.ambiguous) {
    return {
      block: { kind: 'ambiguous', clause: input.ambiguousText, readings: input.ambiguous },
    };
  }
  if (input.residue.length > 0) {
    return { block: { kind: 'residue', residue: input.residue, coverage: input.coverage } };
  }
  return {};
}

/** The block as one line for a step note. Field names and counts only, never a value. */
export function describeBlock(block: GoalBlock): string {
  switch (block.kind) {
    case 'negation':
      return `the goal says "${block.token}" — a negation is not something a grammar may guess at`;
    case 'residue':
      return (
        `did not understand ${block.residue.map((r) => `"${r}"`).join(', ')} ` +
        `(${Math.round(block.coverage * 100)}% of the sentence was read)`
      );
    case 'unparsed':
      return `no rule read the clause "${block.clause}"`;
    case 'ambiguous':
      return (
        `"${block.clause}" reads two ways — it could be naming ` +
        `"${block.readings[0]}" or "${block.readings[1]}"`
      );
  }
}
