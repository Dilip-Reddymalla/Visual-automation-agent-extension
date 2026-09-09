/**
 * Executes one planner action against the live DOM.
 *
 * Three traps, all of which look like working code until they are not:
 *
 *   - Never assign `element.value`. React's synthetic layer tracks the last value it
 *     set and swallows the change event when the property is written directly, so the
 *     field shows the text and the application never hears about it. Use the prototype
 *     native setter, then dispatch a bubbling InputEvent.
 *   - Never type a placeholder literally. Text arrives with tokens in it and is
 *     rehydrated through the session map first; a token that does not resolve is a
 *     rejected action, not a string to type (CLAUDE.md invariant 6).
 *   - Never take an index on trust. The indices in a plan belong to the walk that
 *     produced them, and a page that has moved on since will happily hand back a
 *     different element at the same number -- measured in demo/NAVIGATION.md, where 7
 *     of 12 indices came to mean something else across a single navigation.
 *
 * Everything the executor needs from the outside is injected, so the whole thing runs
 * in tests against a jsdom document with no extension around it.
 */

import type { Action } from '../shared/contract';
import type { ExecutionOutcome, RejectionReason } from '../shared/messages';
import { PLACEHOLDER_RE } from '../shared/placeholders';
import { formatValue, type FieldShape } from './format';
import type { DomEl } from './walker';

export type ExecutionResult = ExecutionOutcome;

/** What resolving one placeholder can produce. Mirrors the offscreen allocator. */
export type ResolveOutcome =
  { ok: true; value: string } | { ok: false; reason: 'unknown-placeholder' | 'session-lost' };

export interface ExecutorEnv {
  /**
   * The document being operated.
   *
   * Injected rather than reached for, because everything the executor constructs --
   * MouseEvent, KeyboardEvent, the HTMLInputElement it type-checks against -- has to
   * come from the same realm as the nodes it is operating. Taking them from globals
   * works in a browser and silently fails across a realm boundary, which is exactly
   * the shape of bug that only shows up in an iframe.
   */
  doc: Document;
  /** index -> live node, from the walk named by `snapshotId`. */
  handleFor(index: number): DomEl | undefined;
  /** Which walk the handles came from. Compared against the plan's. */
  snapshotId(): string;
  /** Turn one token back into its value. Goes to the offscreen allocator. */
  resolve(placeholder: string): Promise<ResolveOutcome>;
  /** For `navigate` and `scroll`. Injected so tests do not need a real window. */
  window: Pick<Window, 'scrollBy' | 'location'>;
  /** For `wait`. Injected so tests do not actually wait. */
  sleep(ms: number): Promise<void>;
}

/**
 * A step-ending failure, as opposed to one bad action.
 *
 * `session-lost` and `stale-snapshot` are both *our* state going missing, and neither
 * says anything about the remaining actions except that they were built on something
 * that is no longer true. Everything else rejects one action and lets the batch carry
 * on.
 */
export class StepEndingRejection extends Error {
  constructor(readonly reason: Extract<RejectionReason, 'stale-snapshot' | 'session-lost'>) {
    super(reason);
    this.name = 'StepEndingRejection';
  }
}

function rejected(reason: RejectionReason, detail?: string): ExecutionResult {
  return { outcome: 'failed', note: detail ? `${reason}: ${detail}` : reason };
}

/**
 * Substitute every placeholder in a string.
 *
 * A SECRET token never gets here: it is refused before resolution, because refusing it
 * at the point of use is the whole of invariant 6. Anything else that fails to resolve
 * distinguishes the planner's fault from ours -- see RejectionReason.
 */
export async function rehydrate(
  text: string,
  env: Pick<ExecutorEnv, 'resolve'>,
): Promise<{ ok: true; text: string } | { ok: false; reason: RejectionReason; token: string }> {
  const tokens = [...new Set(text.match(PLACEHOLDER_RE) ?? [])];
  let out = text;

  for (const token of tokens) {
    const outcome = await env.resolve(token);
    if (!outcome.ok) {
      if (outcome.reason === 'session-lost') throw new StepEndingRejection('session-lost');
      return { ok: false, reason: 'unknown-placeholder', token };
    }
    out = out.split(token).join(outcome.value);
  }

  return { ok: true, text: out };
}

/**
 * The option a user meant, out of the ones a <select> actually has.
 *
 * Exact-and-case-sensitive was the whole matcher, and it failed the first real dropdown it
 * met: the user typed "telangana", the option's text is "Telangana" and its value is "tg",
 * so nothing matched and the step reported `not done` on a field it had resolved perfectly.
 * A person choosing from a list does not match its capitalisation.
 *
 * Four passes, narrowest first, so a page with both "India" and "Indiana" cannot have the
 * exact match stolen by a prefix:
 *
 *   1. the value or text, exactly as given -- the planner emits these, and it is reading
 *      the same list;
 *   2. the same, case-insensitively and with surrounding space ignored;
 *   3. the option text as a whole word inside what the user said, or the reverse, which is
 *      what "Telangana (TG)" and "choose telangana state" both need;
 *   4. nothing, and the executor says so rather than picking the nearest.
 */
function findOption<T extends { value: string; text: string }>(
  options: T[],
  wanted: string,
): T | undefined {
  const exact = options.find((o) => o.value === wanted || o.text.trim() === wanted);
  if (exact) return exact;

  const asked = wanted.trim().toLowerCase();
  const loose = options.find(
    (o) => o.value.toLowerCase() === asked || o.text.trim().toLowerCase() === asked,
  );
  if (loose) return loose;

  // Only options that say something: an empty "Select State" placeholder is a caption, not
  // a choice, and `''.includes` is true of everything.
  const real = options.filter((o) => o.text.trim().length > 0 && o.value !== '');

  // Exactly one, or none. Containment had no margin and took the first match, so "pradesh"
  // -- equally true of five options on the real list -- silently chose Andhra. Picking one
  // of five is a coin toss with a confident tone of voice, and this refuses coin tosses
  // everywhere else.
  const contained = real.filter((o) => {
    const text = o.text.trim().toLowerCase();
    return text.includes(asked) || asked.includes(text);
  });
  if (contained.length === 1) return contained[0];

  return nearestOption(real, asked);
}

/**
 * The option a person meant when they did not spell it the way the page does.
 *
 * "Select state as andra pradesh" resolved to the right dropdown, on the right page, and
 * then matched nothing: the option reads "Andhra Pradesh" and the user left out the h.
 * Every earlier pass is an equality or a containment, and neither survives a typo.
 *
 * The discrimination this needs is real rather than nominal -- that list has five options
 * ending in "Pradesh" -- so it borrows the rule the resolver already uses for elements: a
 * floor, and a margin over the runner-up. Similarity is averaged per word, so the shared
 * "pradesh" cannot carry a match on its own and the word that differs is the word that
 * decides.
 *
 *   andra pradesh  vs  Andhra Pradesh     0.92
 *                  vs  Arunachal Pradesh  0.67
 *                  vs  Himachal Pradesh   0.63
 *
 * `NEAR_ENOUGH` is one character in five, which is a typo rather than a different word.
 * `NEAR_MARGIN` is the same idea as the resolver's `CLEAR_MARGIN`: two candidates within a
 * hair of each other are a coin toss, and this refuses coin tosses.
 */
const NEAR_ENOUGH = 0.8;
const NEAR_MARGIN = 0.15;

function nearestOption<T extends { text: string }>(options: T[], asked: string): T | undefined {
  const scored = options
    .map((option) => ({ option, score: similarity(asked, option.text.trim().toLowerCase()) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < NEAR_ENOUGH) return undefined;
  const runnerUp = scored[1]?.score ?? 0;
  return best.score - runnerUp >= NEAR_MARGIN ? best.option : undefined;
}

/** Word-by-word closeness, 0 to 1. Unequal word counts are penalised by the longer side. */
function similarity(a: string, b: string): number {
  const left = a.split(/\s+/).filter(Boolean);
  const right = b.split(/\s+/).filter(Boolean);
  const span = Math.max(left.length, right.length);
  if (span === 0) return 0;

  let total = 0;
  for (let i = 0; i < span; i += 1) {
    total += wordCloseness(left[i] ?? '', right[i] ?? '');
  }
  return total / span;
}

function wordCloseness(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return Math.max(0, 1 - editDistance(a, b) / longest);
}

/** Levenshtein, one row at a time. Option lists are short and words are shorter. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

/**
 * True when the text names a secret.
 *
 * The planner is told secrets cannot be substituted and that it must emit `ask`
 * instead. This is where that is enforced rather than hoped for: the check is on the
 * token shape, so it catches «SECRET», «SECRET_1» and anything else that tries, whether
 * the model invented it or read it somewhere.
 */
export function namesASecret(text: string): boolean {
  return /«SECRET(_\d+)?»/.test(text);
}

/** Sets a value the way React notices. See the note at the top of the file. */
/**
 * Every node this extension has typed into, in this document.
 *
 * The counter used to report our own keystrokes as protected user data. The agent types
 * an address into two fields, the next step photographs the page, the filter correctly
 * masks what it finds, and the panel says "Values redacted this session: 10" about a page
 * that never held one value of the user's. Redacting it is right -- it is in the
 * screenshot and must not cross -- but counting it is a claim about protection that
 * nothing earned.
 *
 * A WeakSet of nodes rather than a set of indices, because indices are reissued on every
 * walk and the mark has to survive re-perception. It is also exactly document-scoped: a
 * navigation replaces the content script and the set with it, which is correct -- the
 * values in the new document are that document's, not ours.
 */
const TYPED_BY_AGENT = new WeakSet<object>();

/** Has the agent written into this node, this step or any earlier one? */
export function typedByAgent(node: object): boolean {
  return TYPED_BY_AGENT.has(node);
}

/**
 * What a field says about the value it takes.
 *
 * Read here rather than passed in, because the executor holds the live node and this is the
 * only place that needs it. Everything on it is a public attribute the page author wrote
 * for a human to read.
 */
export function shapeOf(el: DomEl): FieldShape {
  const input = el as unknown as { type?: string; maxLength?: number };
  const shape: FieldShape = {};
  if (input.type) shape.inputType = input.type;
  const placeholder = el.getAttribute('placeholder');
  if (placeholder) shape.placeholder = placeholder;
  const title = el.getAttribute('title');
  if (title) shape.title = title;
  const pattern = el.getAttribute('pattern');
  if (pattern) shape.pattern = pattern;
  if (typeof input.maxLength === 'number' && input.maxLength > 0) {
    shape.maxLength = input.maxLength;
  }
  return shape;
}

export function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  // Marked here rather than at the call site so that every path that writes a value is
  // covered -- the executor's `type`, and FILL_SECRET releasing from the vault.
  TYPED_BY_AGENT.add(el);

  const view = realmOf(el.ownerDocument);
  // The setter lives on the prototype, and which prototype depends on the tag. Taking
  // it from the instance would find React's own shadowed property, which is the bug.
  const proto = Object.getPrototypeOf(el) as object;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');

  if (descriptor?.set) {
    descriptor.set.call(el, value);
  } else {
    // No prototype setter at all: not a React-managed field, and a plain write is both
    // safe and the only thing left.
    el.value = value;
  }

  // Order matters and both are required. `input` is what React's onChange listens to;
  // `change` is what plain HTML forms and most validation libraries listen to.
  el.dispatchEvent(new view.Event('input', { bubbles: true }));
  el.dispatchEvent(new view.Event('change', { bubbles: true }));
}

type Realm = Window & typeof globalThis;

function isTextField(el: DomEl, view: Realm): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof view.HTMLInputElement || el instanceof view.HTMLTextAreaElement;
}

/** The realm the nodes belong to. See the note on ExecutorEnv.doc. */
function realmOf(doc: Document): Realm {
  const view = doc.defaultView;
  if (!view) throw new Error('executor: the document has no window');
  return view;
}

/** Convert timestamps like "6 min 20 sec", "6:20", "380s" or "380" into seconds. */
export function parseTimeToSeconds(text: string): number | null {
  const clean = text.trim().toLowerCase();
  // 6:20 or 1:20:30
  const colons = clean.match(/^(?:(\d+):)?(\d+):(\d{2})$/);
  if (colons && colons[2] && colons[3]) {
    const hours = colons[1] ? Number.parseInt(colons[1], 10) : 0;
    const mins = Number.parseInt(colons[2], 10);
    const secs = Number.parseInt(colons[3], 10);
    return hours * 3600 + mins * 60 + secs;
  }
  // 6 min 20 sec, 6 mins 20 seconds, 6m 20s
  const minSec = clean.match(
    /(?:(\d+)\s*(?:hours?|hrs?|h))?\s*(?:(\d+)\s*(?:minutes?|mins?|m))?\s*(?:(\d+)\s*(?:seconds?|secs?|s))?/i,
  );
  if (minSec && (minSec[1] || minSec[2] || minSec[3])) {
    const hours = minSec[1] ? Number.parseInt(minSec[1], 10) : 0;
    const mins = minSec[2] ? Number.parseInt(minSec[2], 10) : 0;
    const secs = minSec[3] ? Number.parseInt(minSec[3], 10) : 0;
    return hours * 3600 + mins * 60 + secs;
  }
  const bareNum = clean.match(/^(\d+(?:\.\d+)?)\s*s?$/);
  if (bareNum && bareNum[1]) return Number.parseFloat(bareNum[1]);
  return null;
}

/**
 * Run one action.
 *
 * `ask` and `finish` are not the page's business -- they are answered by the worker,
 * which owns the session -- so they come back as no-ops rather than as failures. A
 * failure would end up in the history as something the page refused, which is not what
 * happened.
 */
export async function execute(
  action: Action,
  env: ExecutorEnv,
  planSnapshotId: string,
): Promise<ExecutionResult> {
  const view = realmOf(env.doc);

  // Before anything touches the DOM. An index from a previous walk is not a missing
  // element, it is a *different* one, and that failure is silent by nature.
  if (planSnapshotId !== env.snapshotId()) {
    throw new StepEndingRejection('stale-snapshot');
  }

  switch (action.type) {
    case 'ask':
    case 'finish':
      return { outcome: 'no-op', note: `${action.type} is the worker's to answer` };

    case 'wait':
      await env.sleep(action.ms);
      return { outcome: 'ok', note: `waited ${action.ms}ms` };

    case 'navigate':
      // Not validated here beyond being a string: the worker holds the origin policy,
      // and duplicating it would be a second copy of a rule that must not drift.
      env.window.location.href = action.url;
      return { outcome: 'ok', note: 'navigating' };

    case 'key': {
      const target = env.doc.activeElement ?? env.doc.body;
      for (const kind of ['keydown', 'keyup'] as const) {
        target.dispatchEvent(
          new view.KeyboardEvent(kind, { key: action.key, bubbles: true, cancelable: true }),
        );
      }
      return { outcome: 'ok', note: `pressed ${action.key}` };
    }

    case 'scroll': {
      if (action.index === undefined) {
        env.window.scrollBy(action.dx, action.dy);
        return { outcome: 'ok', note: `scrolled ${action.dx},${action.dy}` };
      }
      const el = env.handleFor(action.index);
      if (!el) return rejected('unknown-index', `no element at [${action.index}]`);
      el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      return { outcome: 'ok', note: `scrolled [${action.index}] into view` };
    }

    case 'click': {
      const el = env.handleFor(action.index);
      if (!el) return rejected('unknown-index', `no element at [${action.index}]`);
      if (el instanceof view.HTMLElement) el.focus({ preventScroll: true });

      const media =
        el instanceof view.HTMLMediaElement
          ? el
          : (el.querySelector?.('video, audio') as HTMLMediaElement | null);
      if (media && typeof media.play === 'function') {
        if (media.paused) media.play().catch(() => {});
        else media.pause();
      }

      if (el instanceof view.HTMLElement && typeof el.click === 'function') {
        el.click();
      } else {
        el.dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true, view }));
      }
      return { outcome: 'ok', note: `clicked [${action.index}]` };
    }

    case 'select': {
      const el = env.handleFor(action.index);
      if (!el) return rejected('unknown-index', `no element at [${action.index}]`);

      // Deliberately narrow. A custom listbox -- a div with role="combobox" and options
      // that do not exist until it is opened -- is not a <select>, and reaching into one
      // by matching its text would be a shortcut around the perception layer rather than
      // a use of it. The honest path is click, wait for the DOM to settle, look again,
      // click the option. Demo page B exists to keep that path exercised.
      if (!(el instanceof view.HTMLSelectElement)) {
        return rejected(
          'unknown-index',
          `[${action.index}] is not a native <select>; open it and click the option`,
        );
      }

      const option = findOption([...el.options], action.option);
      if (!option) return rejected('unknown-index', `no option matching "${action.option}"`);

      el.value = option.value;
      el.dispatchEvent(new view.Event('input', { bubbles: true }));
      el.dispatchEvent(new view.Event('change', { bubbles: true }));
      return { outcome: 'ok', note: `selected option in [${action.index}]` };
    }

    case 'type': {
      // Checked before the element is even looked up: whether the field exists has no
      // bearing on whether a secret may be typed into it.
      if (namesASecret(action.text)) {
        return rejected(
          'secret-declined',
          'a secret cannot be substituted from a plan -- emit `ask`',
        );
      }

      const el = env.handleFor(action.index);
      if (!el) return rejected('unknown-index', `no element at [${action.index}]`);

      const media =
        el instanceof view.HTMLMediaElement
          ? el
          : (el.querySelector?.('video, audio') as HTMLMediaElement | null);
      if (media && typeof media.play === 'function') {
        const filled = await rehydrate(action.text, env);
        if (!filled.ok) return rejected(filled.reason, filled.token);
        const seconds = parseTimeToSeconds(filled.text);
        if (seconds !== null) {
          media.currentTime = seconds;
          media.play().catch(() => {});
          return { outcome: 'ok', note: `seeked video to ${seconds}s` };
        }
      }

      if (!isTextField(el, view)) {
        return rejected('unknown-index', `[${action.index}] is not a text field`);
      }

      const filled = await rehydrate(action.text, env);
      if (!filled.ok) return rejected(filled.reason, filled.token);

      // The shape the field says it takes, before the value is handed to it.
      //
      // "DOB is 24th jan 2000" reached the right box on the real page and left it empty:
      // the field is maxlength 10, its placeholder is DD-MM-YYYY and it validates on
      // change, so `24th jan 2000` was thrown away by the page. A person reads the format
      // off the box. So does this, and it costs no model call -- see content/format.ts.
      const shaped = formatValue(filled.text, shapeOf(el));

      el.focus({ preventScroll: true });
      setNativeValue(el, shaped.text);

      if (action.submit) {
        el.dispatchEvent(
          new view.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
        el.form?.requestSubmit?.();
      }

      // The note says which token was used, never what it stood for. This string ends
      // up in the step log, in the trace, and in a screenshot on a slide.
      const tokens = [...new Set(action.text.match(PLACEHOLDER_RE) ?? [])];
      const what = tokens.length > 0 ? tokens.join(' ') : `${shaped.text.length} chars`;
      // The reshaping is named, never the value it produced. An operator who sees a date in
      // a box they did not type that way should be able to find out why from the log.
      const how = shaped.note ? `, ${shaped.note}` : '';
      return { outcome: 'ok', note: `typed ${what} into [${action.index}]${how}` };
    }
  }
}
