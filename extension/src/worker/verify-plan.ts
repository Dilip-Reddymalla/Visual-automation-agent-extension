/**
 * What a local model is allowed to have decided.
 *
 * Tier 1 now reads whole sentences, not just ties, and that widens what a wrong answer can
 * do. A tie-break can only ever pick the wrong element from a list someone else built. A
 * plan can name a field nobody offered, and — the failure mode that matters — it can supply
 * a *value the user never said*.
 *
 * That second one is not hypothetical and is not a small-model problem that goes away with
 * a bigger model. A model asked to fill a contact form has seen a million contact forms, and
 * "the text to type into Email" has an overwhelmingly likely answer that has nothing to do
 * with the person sitting in front of it. An invented `john.doe@example.com` typed into a
 * real form is the agent putting words in the user's mouth, and it looks exactly like
 * success: the field is filled, the step says `ok`, the completion check re-reads the field
 * and finds precisely what the plan asked for.
 *
 * So every value is checked against the sentence it is supposed to have come from. The model
 * is choosing among things it was handed; it is not composing. A value that cannot be found
 * in what the user typed is rejected, and the step escalates to a planner that can be asked
 * properly.
 *
 * Node-pure.
 */

import type { Action } from '../shared/contract';
import type { ObservedElement } from '../shared/observed';
import { normalise } from './intent';
import type { LocalAction } from './local';

export type PlanRejection =
  /** An index nobody offered. */
  | { kind: 'unknown-index'; index: number }
  /** The element is real, but not something this action can be done to. */
  | { kind: 'wrong-role'; index: number; role: string }
  /** A value that is not in the user's sentence. */
  | { kind: 'invented-value'; index: number }
  /** The same text in more than one field. See `smeared`. */
  | { kind: 'smeared'; fields: number }
  /** The instruction itself, cut up and distributed. See `shredded`. */
  | { kind: 'shredded'; covered: number }
  /** A value that is a word of the asking rather than a word of the answer. */
  | { kind: 'not-a-value'; index: number }
  /** The field's own caption, typed into the field. See `echoesLabel`. */
  | { kind: 'echoed-label'; index: number }
  /** A click that would have committed a form the plan failed to fill. */
  | { kind: 'unsafe-commit'; index: number };

export type PlanVerdict =
  /**
   * Some actions survived. `dropped` names the ones that did not.
   *
   * A plan is not all-or-nothing any more, and the measurement that changed it is worth
   * recording. Given four lines to place on four fields, a 1.5B produced three correct
   * actions and typed the word "Subject" into the Subject box. Refusing the whole plan for
   * that threw away the three correct ones and left the step to die at a planner that was
   * not running -- for a fault whose whole content is "one field could not be filled".
   *
   * Refusing everything is still right when the *answer* is broken rather than one action in
   * it: see `smeared` and `shredded`, where the model has stopped answering and started
   * filling the shape it was handed. Those still come back as `ok: false`.
   *
   * Dropping is safe here in a way it would not be elsewhere, and the reason is structural:
   * a dropped action types nothing, and `complete.ts` re-reads every field afterwards and
   * ends the session `incomplete` naming what was not done. The half-done case is reported
   * rather than hidden, which is the whole difference from the M16 bug this resembles.
   */
  | { ok: true; actions: Action[]; dropped: PlanRejection[] }
  | { ok: false; reason: PlanRejection };

/** The caption an element is known by, for comparing a proposed value against. */
function labelOf(element: ObservedElement): string {
  return (
    element.labelText ??
    element.ariaLabel ??
    (element.name || undefined) ??
    element.nearbyText ??
    element.placeholder ??
    ''
  );
}

/** Roles a value can be typed into, and roles a click means something for. */
const FILLABLE = new Set(['textbox', 'searchbox', 'spinbutton']);
/** Roles that hold a list of options rather than free text. */
const SELECTABLE = new Set(['combobox', 'listbox']);
const CLICKABLE = new Set([
  'button',
  'link',
  'tab',
  'menuitem',
  'checkbox',
  'radio',
  'switch',
  'combobox',
]);

/**
 * Is this text actually in the sentence the user typed?
 *
 * Compared through `normalise`, so case, punctuation and spacing do not decide it: a model
 * that returns "Asha Menon" for a sentence saying "asha menon" has copied, not invented, and
 * refusing that would make the guard useless in practice while catching nothing real.
 *
 * Substring rather than token-set, deliberately. "leo" appearing somewhere in the sentence is
 * the claim being checked, and a model that reassembles the user's words into a different
 * order has composed something the user did not say.
 */
export function fromSentence(text: string, sentence: string): boolean {
  const wanted = normalise(text);
  if (!wanted) return true; // A click carries no value; there is nothing to invent.
  return normalise(sentence).includes(wanted);
}

/**
 * Did the model give up and put the same thing everywhere?
 *
 * The failure this catches was measured, not imagined. Asked "fill in this form for me" --
 * a sentence containing no values at all -- every local model tried answers with the user's
 * own instruction typed into every box on the page:
 *
 *   [{"index":1,"text":"fill in this form for me"},{"index":2,"text":"fill in this form ..."}]
 *
 * Every one of those values passes `fromSentence`, because the text genuinely is in the
 * sentence. It is the same string four times, which is not an answer -- it is a model with
 * nothing to say filling the shape it was handed. And it is precisely the bug this project
 * started with: an agent typing a canned string into First Name, Last Name and Subject and
 * reporting success.
 *
 * One value may legitimately repeat -- "put leo in both name boxes" -- so this fires on
 * three or more, which no real instruction produces and every collapse does.
 */
const SMEAR_LIMIT = 3;

/** The value an action carries, whether it is typed or chosen. Empty for a click. */
function valueOf(action: Action): string {
  if (action.type === 'type') return action.text;
  if (action.type === 'select') return action.option;
  return '';
}

function smeared(actions: readonly Action[]): number {
  const counts = new Map<string, number>();
  for (const action of actions) {
    const value = valueOf(action);
    if (!value) continue;
    const key = normalise(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

/**
 * Did the model redistribute the instruction instead of extracting from it?
 *
 * `smeared` catches the collapse where every field gets the same string. This catches its
 * sibling, which is what the larger models do instead: asked "fill in this form for me" --
 * again, a sentence containing no values -- a 4B answers with

 *   [{"index":1,"text":"fill"},{"index":2,"text":"in"},{"index":3,"text":"this"},...]
 *
 * Every value is genuinely in the sentence, and no two are the same, so both earlier guards
 * pass it. What gives it away is that the values together account for essentially the whole
 * instruction. A real extraction takes a small part of what was said -- "asha" out of "put
 * my name down as asha" -- because most of a sentence is the asking, not the answer.
 *
 * Only when more than one field is being filled: a single value that happens to be most of
 * a short sentence is an ordinary extraction, and there is nothing to shred between.
 *
 * Like every check here, a false rejection costs a round trip to a planner that can be asked
 * properly, and a false acceptance types nonsense into somebody's form. The threshold is set
 * accordingly.
 */
const SHRED_COVERAGE = 0.7;

/**
 * Applies to one value as much as to four.
 *
 * A single action whose text is most of the instruction is the same failure as four that
 * add up to it: the model has handed the question back rather than answered it. What makes
 * 0.7 the right side of the line is that a real extraction takes the answer out of a
 * sentence that is mostly asking -- "put my name down as Asha" is 23 characters of which
 * four are the value.
 */

function shredded(actions: readonly Action[], sentence: string): number {
  const values = actions.flatMap((action) => {
    const value = valueOf(action);
    return value ? [normalise(value)] : [];
  });
  // One value counts too, and that was a hole. Asked to read "DL Number 10001000193" -- a
  // field name and a value with no verb -- a 1.5B answered with one action whose text was
  // the whole sentence, and typed "DL Number 10001000193" into the DL Number box. Every
  // other guard passed it: the text is in the sentence, it is not a stop word, it is not
  // the field's label, and one action cannot smear.
  if (values.length === 0) return 0;

  const total = normalise(sentence).length;
  if (total === 0) return 0;
  return values.reduce((sum, value) => sum + value.length, 0) / total;
}

/**
 * Words that are never what somebody meant to type into a box.
 *
 * The third shape of the same collapse, and the one the coverage check misses. A 4B asked
 * "fill in this form for me" -- a sentence with no values in it -- answers
 *
 *   [{"index":1,"text":"fill"},{"index":2,"text":"in"},{"index":3,"text":"this"},
 *    {"index":4,"text":"form"}]
 *
 * Four different values, every one of them genuinely in the sentence, together accounting
 * for 58% of it: under the coverage threshold, past the smear check, and it would have put
 * the word "in" into somebody's Last Name box.
 *
 * What actually distinguishes it is that these are words of the *asking*. "in", "this" and
 * "the" are grammar; "fill", "type" and "submit" are the instruction's own verbs. A value
 * made of nothing but those is the model handing back the question.
 *
 * An explicit list rather than a heuristic, for the reason every list in this project is
 * explicit: it can be read and argued with, and a threshold cannot.
 */
const NOT_VALUES = new Set([
  // Function words.
  'a',
  'an',
  'and',
  'as',
  'at',
  'be',
  'by',
  'do',
  'for',
  'from',
  'i',
  'in',
  'into',
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
  'there',
  'this',
  'to',
  'with',
  'you',
  'your',
  // The instruction's own verbs and nouns. A value of "submit" into a text box is the
  // model repeating the request back.
  'box',
  'button',
  'click',
  'enter',
  'field',
  'fill',
  'form',
  'input',
  'page',
  'press',
  'put',
  'select',
  'set',
  'submit',
  'type',
  'write',
]);

/** Is every word of this value a word of the asking? */
export function isNotAValue(text: string): boolean {
  const words = normalise(text).split(' ').filter(Boolean);
  if (words.length === 0) return false;
  return words.every((word) => NOT_VALUES.has(word));
}

/**
 * Is the value just the field's own caption?
 *
 * Measured: given four lines to place on four fields, a 1.5B put "Leo" in First Name, "A"
 * in Last Name, chose Australia in the country dropdown -- and typed the word **"Subject"**
 * into the Subject box. It ran out of sentence and filled the last field with the label it
 * had been shown.
 *
 * `fromSentence` happens to catch that one, because "subject" is not in the user's text. It
 * would not catch it on a page whose field names the user had mentioned, which is most pages
 * where someone says "put my name in the name box". So the echo is named directly.
 */
function echoesLabel(value: string, label: string): boolean {
  const said = normalise(value);
  const caption = normalise(label);
  return said.length > 0 && caption.length > 0 && said === caption;
}

/**
 * Turn a local model's answer into actions, or say why not.
 *
 * Every check is a refusal rather than a repair. Dropping the one bad action and running the
 * rest would leave the page in a state neither the model nor the planner intended, which is
 * the same "half an instruction" failure the grammar already refuses to commit.
 */
export function verifyPlan(
  proposed: readonly LocalAction[],
  elements: readonly ObservedElement[],
  sentence: string,
): PlanVerdict {
  let actions: Action[] = [];
  const dropped: PlanRejection[] = [];

  for (const item of proposed) {
    const fault = checkOne(item, elements, sentence);
    if (fault) dropped.push(fault);
    else actions.push(actionFor(item));
  }

  // The collapse signals are about the answer as a whole, so they refuse it as a whole. A
  // model that put the same string in four boxes, or cut the instruction up and shared it
  // out, has not produced a plan with a bad action in it -- it has stopped answering, and
  // running the part that happens to typecheck is running noise.
  const repeats = smeared(actions);
  if (repeats >= SMEAR_LIMIT)
    return { ok: false, reason: { kind: 'smeared', fields: repeats } };

  const covered = shredded(actions, sentence);
  if (covered > SHRED_COVERAGE) return { ok: false, reason: { kind: 'shredded', covered } };

  // A click is the *end* of a plan, not an independent action.
  //
  // Measured on a real page: "fill in this form for me" had all three of its invented
  // values dropped and the surviving action was a click on Submit -- so the agent
  // submitted an empty form on an instruction that named nothing. Dropping is safe for a
  // value, because a dropped value types nothing; it is not safe for the button that
  // commits whatever is there.
  //
  // So the clicks come out and the fills stay in. Refusing the whole plan instead would be
  // the safe-and-useless answer: on the instruction this was found with -- four lines down
  // a form, ending "Then click submit" -- three fields were placed correctly and the fourth
  // echoed a label, and throwing away three good fills to avoid one bad submit helps
  // nobody. What the operator gets is the three fields, an unsubmitted form, and a session
  // that ends `incomplete` naming both the field it could not fill and the click it did not
  // make.
  let held: PlanRejection[] = [];
  if (dropped.length > 0) {
    held = actions.flatMap((action) =>
      action.type === 'click' ? [{ kind: 'unsafe-commit' as const, index: action.index }] : [],
    );
    if (held.length > 0) {
      actions = actions.filter((action) => action.type !== 'click');
    }
  }

  // Nothing survived. There is no partial plan to run, and the first fault is the most
  // useful thing to say about why not.
  if (actions.length === 0) {
    return { ok: false, reason: dropped[0] ?? { kind: 'unknown-index', index: -1 } };
  }

  return { ok: true, actions, dropped: [...dropped, ...held] };
}

/** One proposed action to a real one, once it has passed. */
function actionFor(item: LocalAction): Action {
  if (item.action === 'select') return { type: 'select', index: item.index, option: item.text };
  if (item.action === 'click') return { type: 'click', index: item.index };
  return { type: 'type', index: item.index, text: item.text, submit: false };
}

/** What is wrong with one proposed action, or undefined. */
function checkOne(
  item: LocalAction,
  elements: readonly ObservedElement[],
  sentence: string,
): PlanRejection | undefined {
  const element = elements.find((candidate) => candidate.index === item.index);
  if (!element) return { kind: 'unknown-index', index: item.index };

  // A dropdown is neither typing nor clicking. The country field on the page this project
  // keeps being tested on is a native <select>, and an instruction naming a country was
  // otherwise refused as "typing into a combobox" -- a correct refusal of an action the
  // reader had no way to express.
  const roles =
    item.action === 'select' ? SELECTABLE : item.action === 'click' ? CLICKABLE : FILLABLE;
  if (!roles.has(element.role)) {
    return { kind: 'wrong-role', index: item.index, role: element.role };
  }

  // A click carries no value, so there is nothing to invent.
  if (item.action === 'click') return undefined;

  if (!fromSentence(item.text, sentence)) return { kind: 'invented-value', index: item.index };
  if (isNotAValue(item.text)) return { kind: 'not-a-value', index: item.index };
  if (echoesLabel(item.text, labelOf(element)))
    return { kind: 'echoed-label', index: item.index };
  return undefined;
}

/** One line for the step log. Indices and roles only — never the value that was refused. */
export function describeRejection(reason: PlanRejection): string {
  switch (reason.kind) {
    case 'unknown-index':
      return `the local model named element [${reason.index}], which is not on the page`;
    case 'wrong-role':
      return `[${reason.index}] is a ${reason.role}, which is not what that action does`;
    case 'invented-value':
      return `the local model made up a value for [${reason.index}] that the user never typed`;
    case 'smeared':
      return (
        `the local model put the same text into ${reason.fields} fields, ` +
        `which is what it does instead of saying it does not know`
      );
    case 'shredded':
      return (
        `the local model spread ${Math.round(reason.covered * 100)}% of the instruction ` +
        `across the fields rather than taking a value out of it`
      );
    case 'not-a-value':
      return (
        `the local model wanted to type a word of the instruction into [${reason.index}] ` +
        `rather than a value from it`
      );
    case 'echoed-label':
      return (
        `the local model wanted to type [${reason.index}]'s own label into it, ` +
        `which means it ran out of sentence`
      );
    case 'unsafe-commit':
      return (
        `did not click [${reason.index}]: the plan could not fill every field it named, ` +
        `and submitting a form the agent knows is incomplete is not its call to make`
      );
  }
}
