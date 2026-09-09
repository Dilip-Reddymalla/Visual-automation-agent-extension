/**
 * Tier 0, against the page that produced the bug.
 *
 * A w3schools contact form: First Name, Last Name, Country, Subject. The agent was asked
 * to fill First Name and filled Last Name and Subject instead, because nothing matched
 * anything -- the planner never read the goal at all.
 */

import { describe, it, expect } from 'vitest';
import type { ObservedElement } from '../shared/observed';
import { parseGoal } from './intent';
import { CLEAR_MARGIN, resolveTarget, SCORE_FLOOR } from './resolve';
import { chooseTier } from './tiers';

function el(over: Partial<ObservedElement> & { index: number }): ObservedElement {
  return {
    role: 'textbox',
    box: { x: 0, y: 0, w: 200, h: 30 },
    state: { visible: true, enabled: true, focused: false, filled: false },
    occluded: 0,
    isNew: false,
    tag: 'input',
    key: `k${over.index}`,
    name: '',
    textRuns: [],
    ...over,
  };
}

/** The contact form, as perception actually reports it. */
const CONTACT_FORM: ObservedElement[] = [
  el({ index: 1, labelText: 'First Name', autocomplete: 'given-name', idAttr: 'fname' }),
  el({ index: 2, labelText: 'Last Name', autocomplete: 'family-name', idAttr: 'lname' }),
  el({ index: 3, labelText: 'Country', role: 'combobox', nameAttr: 'country' }),
  el({ index: 4, labelText: 'Subject', idAttr: 'subject' }),
  el({ index: 5, name: 'Submit', role: 'button' }),
];

function resolveFirst(goal: string, elements = CONTACT_FORM) {
  const intent = parseGoal(goal).intents[0];
  if (!intent) throw new Error(`nothing parsed from "${goal}"`);
  return resolveTarget(intent, elements);
}

describe('the bug, as a test', () => {
  it('fills First Name and nothing else', () => {
    const result = resolveFirst('fill first name with leo');
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.index).toBe(1);
    // Well clear of Last Name, which shares the word "name".
    expect(result.gap).toBeGreaterThanOrEqual(CLEAR_MARGIN);
  });

  it('does not confuse the two name fields in either direction', () => {
    const last = resolveFirst('fill last name with menon');
    expect(last.kind === 'resolved' && last.index).toBe(2);
  });

  it('finds a button by its accessible name', () => {
    const result = resolveFirst('click submit');
    expect(result.kind === 'resolved' && result.index).toBe(5);
  });

  it('will not fill a button or click a textbox', () => {
    // "fill submit" has no fillable target on this page, so there is nothing to do and
    // Tier 0 says so rather than typing into the nearest thing.
    const result = resolveFirst('fill submit with x');
    expect(result.kind).toBe('ambiguous');
  });

  it('matches a select for a select verb', () => {
    const result = resolveFirst('choose India in country');
    expect(result.kind === 'resolved' && result.index).toBe(3);
  });
});

describe('escalation', () => {
  /**
   * Two email-ish fields is a real page, and picking the first is a coin toss dressed up
   * as a decision. The gap is what says which of the two this is.
   */
  it('escalates on a tie', () => {
    // Two fields that match the word equally well. Neither label is the target exactly,
    // so neither can be preferred without knowing what the user meant.
    const twoEmails = [
      el({ index: 1, labelText: 'Alternate email', idAttr: 'alt_email' }),
      el({ index: 2, labelText: 'Work email', idAttr: 'work_email' }),
    ];
    const result = resolveFirst('fill my email with x@y.in', twoEmails);
    expect(result).toMatchObject({ kind: 'ambiguous', reason: 'tie' });
  });

  /**
   * The other side of the same rule, and the reason the margin is not simply "always
   * escalate on two matches": a field labelled exactly `Email` beside one labelled
   * `Confirm email` is not a coin toss, and spending a model call on it would be paying
   * for an answer the device already has.
   */
  it('does not escalate when one candidate is an exact match and the other is not', () => {
    const emails = [
      el({ index: 1, labelText: 'Email', idAttr: 'email' }),
      el({ index: 2, labelText: 'Confirm email', idAttr: 'email2' }),
    ];
    const result = resolveFirst('fill my email with x@y.in', emails);
    expect(result.kind === 'resolved' && result.index).toBe(1);
  });

  it('escalates when nothing is above the floor', () => {
    const result = resolveFirst('fill invoice reference with INV-9');
    expect(result).toMatchObject({ kind: 'ambiguous', reason: 'below-floor' });
  });

  it('hands the shortlist up, so Tier 1 has something to choose between', () => {
    const twoEmails = [
      el({ index: 1, labelText: 'Email' }),
      el({ index: 2, labelText: 'Confirm email' }),
    ];
    const result = resolveFirst('fill my email with x@y.in', twoEmails);
    expect(result.candidates.map((c) => c.index)).toEqual([1, 2]);
    expect(result.candidates[0]?.label).toBe('Email');
  });
});

describe('signal strength', () => {
  it('lets autocomplete outweigh a label that only half matches', () => {
    const elements = [
      el({ index: 1, labelText: 'Name of applicant' }),
      el({ index: 2, autocomplete: 'given-name', labelText: 'Applicant' }),
    ];
    const result = resolveFirst('fill given name with leo', elements);
    expect(result.kind === 'resolved' && result.index).toBe(2);
  });

  it('scores an exact label above a containing one', () => {
    const elements = [
      el({ index: 1, labelText: 'Subject of your enquiry' }),
      el({ index: 2, labelText: 'Subject' }),
    ];
    const result = resolveFirst('fill subject with refund', elements);
    expect(result.kind === 'resolved' && result.index).toBe(2);
  });

  /**
   * An internal attribute alone is not enough, and that is deliberate. `name` and `id`
   * are abbreviated and collide across forms; a field whose only evidence is
   * `name="subject"` scores 4, the floor is 6, and it escalates rather than being typed
   * into on the strength of one abbreviation.
   */
  it('needs more than one internal attribute to clear the floor', () => {
    const weak = [el({ index: 7, nameAttr: 'subject' })];
    expect(resolveFirst('fill subject with refund', weak)).toMatchObject({
      kind: 'ambiguous',
      reason: 'below-floor',
    });

    const both = [el({ index: 7, nameAttr: 'subject', idAttr: 'subject' })];
    expect(resolveFirst('fill subject with refund', both)).toMatchObject({
      kind: 'resolved',
      index: 7,
    });
  });
});

describe('the thresholds mean something', () => {
  it('keeps the floor below the weakest signal worth acting on', () => {
    // A `name`/`id` match alone (4) must not clear the floor: internal attribute names
    // are abbreviated and collide, and acting on one alone is how "subject" finds "subj".
    expect(SCORE_FLOOR).toBeGreaterThan(4);
  });

  it('keeps the margin wide enough that a label alone is not a tiebreak', () => {
    expect(CLEAR_MARGIN).toBeGreaterThanOrEqual(4);
  });
});

/**
 * The ladder itself: which tier answers, and why not a lower one.
 *
 * Escalation is not failure. What Tier 0 buys is that a single-field instruction never
 * leaves the laptop; what the tiers below Tier 2 cost is nothing when they decline.
 */
describe('choosing a tier', () => {
  it('answers a clear single-field instruction on the device', () => {
    const choice = chooseTier(parseGoal('fill first name with leo'), CONTACT_FORM);
    expect(choice.tier).toBe(0);
    if (choice.tier !== 0) return;
    expect(choice.plan.actions).toEqual([
      { type: 'type', index: 1, text: 'leo', submit: false },
    ]);
    // The margin is the number that says this was a decision and not a guess.
    expect(choice.plan.decisions[0]?.gap).toBeGreaterThanOrEqual(CLEAR_MARGIN);
  });

  it('types the token, not the value, once the value has been tokenised', () => {
    const intents = parseGoal('fill first name with leo').intents.map((i) => ({
      ...i,
      valueRef: '«PERSON_1»',
    }));
    const choice = chooseTier({ intents }, CONTACT_FORM);
    expect(choice.tier === 0 && choice.plan.actions[0]).toMatchObject({
      text: '«PERSON_1»',
    });
  });

  it('sends an open-ended task straight to the planner', () => {
    const parsed = parseGoal('book the next available appointment');
    expect(parsed.openEnded).toBe(true);
    expect(chooseTier(parsed, CONTACT_FORM)).toEqual({
      tier: 2,
      reason: 'open-ended',
    });
  });

  it('asks the local model when two fields are equally plausible', () => {
    const twoEmails = [
      el({ index: 1, labelText: 'Alternate email', idAttr: 'alt_email' }),
      el({ index: 2, labelText: 'Work email', idAttr: 'work_email' }),
    ];
    const choice = chooseTier(parseGoal('fill my email with x@y.in'), twoEmails);
    expect(choice.tier).toBe(1);
    if (choice.tier !== 1) return;
    expect(choice.escalation.reason).toBe('tie');
    expect(choice.escalation.candidates).toHaveLength(2);
  });

  /**
   * All-or-nothing across a multi-field goal. Acting on the resolved half and escalating
   * the rest would send a screenshot of a page the agent had already changed, and the
   * planner would be reasoning about a state one action out of date.
   */
  it('escalates the whole step when any one intent is unclear', () => {
    const { intents } = parseGoal('fill first name with leo and fill nickname with x');
    expect(intents).toHaveLength(2);
    expect(chooseTier({ intents }, CONTACT_FORM).tier).toBe(1);
  });

  it('handles every intent when they all resolve', () => {
    const { intents } = parseGoal('fill first name with leo and click submit');
    const choice = chooseTier({ intents }, CONTACT_FORM);
    expect(choice.tier === 0 && choice.plan.actions.map((a) => a.type)).toEqual([
      'type',
      'click',
    ]);
  });
});

describe('a page that labels nothing', () => {
  /**
   * The parivahan Mobile Number Update form. Every field is captioned by adjacent text and
   * carries no `for`, no aria-label and no accessible name -- which is a great many
   * government forms, and was two separate failures here.
   */
  const SARATHI: ObservedElement[] = [
    el({ index: 8, nearbyText: 'DL Number', placeholder: 'ENTER DL NUMBER' }),
    el({ index: 11, nearbyText: 'Date of Birth', placeholder: 'DD-MM-YYYY' }),
    el({
      index: 14,
      role: 'combobox',
      tag: 'select',
      nearbyText: "DL Holder's Last Transaction State",
      idAttr: 'ddlState',
    }),
    el({ index: 17, nearbyText: 'Captcha', placeholder: 'Enter the Captcha' }),
    el({ index: 19, name: 'Submit', role: 'button' }),
  ];

  it('finds the one dropdown by the caption above it', () => {
    const result = resolveFirst('select state as telangana', SARATHI);
    expect(result.kind).toBe('resolved');
    expect(result.kind === 'resolved' && result.index).toBe(14);
  });

  /**
   * `??` on `name` is wrong: the walker sets it to `''` for an element with no accessible
   * name, and an empty string is not nullish, so every fallback after it was unreachable.
   * Every candidate on this page reached the operator, the log and the local model with a
   * blank label.
   */
  it('names a candidate by its caption rather than by nothing', () => {
    const result = resolveFirst('select state as telangana', SARATHI);
    expect(result.candidates[0]?.label).toBe("DL Holder's Last Transaction State");
  });

  /**
   * The reading the alias table cannot settle, settled by the page.
   *
   * "DL Number" is a field name on precisely one government website, so neither half of
   * "enter DL Number as 10001000193" is in any table. The page has a box captioned
   * "DL Number" and nothing called 10001000193, which is the same evidence a person uses
   * and needs no vocabulary at all.
   */
  it('takes the other reading of `as` when only that one is on the page', () => {
    const choice = chooseTier(parseGoal('enter DL Number as 10001000193'), SARATHI);
    expect(choice.tier).toBe(0);
    if (choice.tier !== 0) return;
    expect(choice.plan.actions).toEqual([
      { type: 'type', index: 8, text: '10001000193', submit: false },
    ]);
  });

  it('does not reach for the other reading when the first one resolved', () => {
    const choice = chooseTier(parseGoal('select state as telangana'), SARATHI);
    expect(choice.tier).toBe(0);
    if (choice.tier !== 0) return;
    expect(choice.plan.actions).toEqual([{ type: 'select', index: 14, option: 'telangana' }]);
  });

  it('still finds the text fields it always found', () => {
    expect(resolveFirst('fill dl number with 10001000193', SARATHI)).toMatchObject({
      kind: 'resolved',
      index: 8,
    });
  });

  it('checks all checkboxes when requested', () => {
    const formWithCheckboxes: ObservedElement[] = [
      el({ index: 18, role: 'checkbox', labelText: 'Option 1', state: { visible: true, enabled: true, focused: false, filled: false, checked: false } }),
      el({ index: 19, role: 'checkbox', labelText: 'Option 2', state: { visible: true, enabled: true, focused: false, filled: false, checked: false } }),
      el({ index: 20, role: 'checkbox', labelText: 'Option 3', state: { visible: true, enabled: true, focused: false, filled: false, checked: false } }),
    ];
    const choice = chooseTier(parseGoal('check all the checkbox'), formWithCheckboxes);
    expect(choice.tier).toBe(0);
    if (choice.tier !== 0) return;
    expect(choice.plan.actions).toEqual([
      { type: 'click', index: 18 },
      { type: 'click', index: 19 },
      { type: 'click', index: 20 },
    ]);
  });
});
