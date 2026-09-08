/**
 * What a local model is allowed to have decided.
 *
 * The tests that matter here are the refusals. A plan that works is easy to check; the
 * question this module exists to answer is what happens when a 0.6B model, asked what to
 * type into a box labelled Email, answers with the most likely email address in its
 * training data rather than the one the user typed.
 */

import { describe, it, expect } from 'vitest';
import type { ObservedElement } from '../shared/observed';
import { describeRejection, fromSentence, isNotAValue, verifyPlan } from './verify-plan';

const el = (o: Partial<ObservedElement> & { index: number }): ObservedElement => ({
  role: 'textbox',
  box: { x: 0, y: 0, w: 200, h: 30 },
  state: { visible: true, enabled: true, focused: false, filled: false },
  occluded: 0,
  isNew: false,
  tag: 'input',
  key: `k${o.index}`,
  name: '',
  textRuns: [],
  ...o,
});

const FORM: ObservedElement[] = [
  el({ index: 1, labelText: 'First Name' }),
  el({ index: 2, labelText: 'Email' }),
  el({ index: 3, labelText: 'Country', role: 'combobox' }),
  el({ index: 4, name: 'Send', role: 'button' }),
];

describe('verifyPlan accepts a plan built from what it was handed', () => {
  it('turns a fill into a type action', () => {
    const verdict = verifyPlan(
      [{ index: 1, action: 'type' as const, text: 'leo' }],
      FORM,
      'put my name down as leo',
    );
    expect(verdict).toEqual({
      ok: true,
      actions: [{ type: 'type', index: 1, text: 'leo', submit: false }],
      dropped: [],
    });
  });

  it('turns an empty text into a click', () => {
    const verdict = verifyPlan(
      [{ index: 4, action: 'click' as const, text: '' }],
      FORM,
      'send it off',
    );
    expect(verdict).toEqual({ ok: true, actions: [{ type: 'click', index: 4 }], dropped: [] });
  });

  it('accepts several actions in order', () => {
    const verdict = verifyPlan(
      [
        { index: 1, action: 'type' as const, text: 'leo' },
        { index: 4, action: 'click' as const, text: '' },
      ],
      FORM,
      'put my name down as leo and send it off',
    );
    expect(verdict.ok && verdict.actions.map((a) => a.type)).toEqual(['type', 'click']);
  });

  it('does not mind case or punctuation the model normalised away', () => {
    const verdict = verifyPlan(
      [{ index: 1, action: 'type' as const, text: 'Asha Menon' }],
      FORM,
      'my name is asha menon',
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('verifyPlan refuses', () => {
  /**
   * The one that matters.
   *
   * A model that has seen a million contact forms has a very likely answer for "what goes
   * in the email box", and it is not the user's. An invented value looks exactly like
   * success from every other vantage point in this system: the field fills, the step says
   * `ok`, and the completion check re-reads the field and finds precisely what the plan
   * asked for.
   */
  it('a value the user never typed', () => {
    const verdict = verifyPlan(
      [{ index: 2, action: 'type' as const, text: 'john.doe@example.com' }],
      FORM,
      'fill in the form for me',
    );
    expect(verdict).toEqual({
      ok: false,
      reason: { kind: 'invented-value', index: 2 },
    });
  });

  it('an index that is not on the page', () => {
    const verdict = verifyPlan(
      [{ index: 99, action: 'type' as const, text: 'leo' }],
      FORM,
      'leo',
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason.kind).toBe('unknown-index');
  });

  it('typing into something that is not a text field', () => {
    const verdict = verifyPlan(
      [{ index: 4, action: 'type' as const, text: 'leo' }],
      FORM,
      'leo',
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason.kind).toBe('wrong-role');
  });

  it('clicking something that cannot be clicked', () => {
    const verdict = verifyPlan([{ index: 1, action: 'click' as const, text: '' }], FORM, 'go');
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason.kind).toBe('wrong-role');
  });

  /**
   * The bad action, and not the good ones with it.
   *
   * This used to refuse the whole plan, on the argument that half an instruction leaves the
   * page in a state nobody planned. Measured against a real model, that argument cost more
   * than it bought: three correct actions were thrown away because a fourth typed a field's
   * own label into it. A dropped action types nothing, and `complete.ts` re-reads the fields
   * and ends the session `incomplete` naming what was missed -- so the partial case is
   * reported rather than hidden, which is the property that mattered all along.
   */
  it('only the offending action, keeping the rest', () => {
    const verdict = verifyPlan(
      [
        { index: 1, action: 'type' as const, text: 'leo' },
        { index: 2, action: 'type' as const, text: 'invented@example.com' },
      ],
      FORM,
      'my name is leo',
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.actions).toEqual([{ type: 'type', index: 1, text: 'leo', submit: false }]);
    expect(verdict.dropped).toEqual([{ kind: 'invented-value', index: 2 }]);
  });

  it('the whole plan when nothing survives', () => {
    const verdict = verifyPlan(
      [{ index: 2, action: 'type' as const, text: 'invented@example.com' }],
      FORM,
      'my name is leo',
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason.kind).toBe('invented-value');
  });
});

describe('the three shapes of a model giving up', () => {
  /**
   * Measured, all three, against a real Ollama. Every model tried proposed at least one of
   * these, and every one of them passes the value check -- the text really is in the
   * sentence -- which is why the value check alone was not enough.
   */
  it('refuses the same string in every box', () => {
    // A value that is not itself a word of the asking, so the smear is what is being
    // tested rather than `not-a-value` -- which is checked per action and would otherwise
    // fire first on the sentence the models actually produce.
    const goal = 'asha goes everywhere on this page';
    const verdict = verifyPlan(
      [1, 2, 3].map((index) => ({ index, action: 'type' as const, text: 'asha' })),
      [el({ index: 1 }), el({ index: 2 }), el({ index: 3 })],
      goal,
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason.kind).toBe('smeared');
  });

  it('allows one repeat, which a real instruction can ask for', () => {
    const goal = 'put leo in both name boxes';
    const verdict = verifyPlan(
      [
        { index: 1, action: 'type' as const, text: 'leo' },
        { index: 2, action: 'type' as const, text: 'leo' },
      ],
      FORM,
      goal,
    );
    expect(verdict.ok).toBe(true);
  });

  /**
   * The 4B's answer, verbatim. Four different values, all genuinely in the sentence, 58% of
   * it in total -- under the coverage threshold and past the smear check. What gives it
   * away is that they are words of the asking.
   */
  it('refuses words of the instruction as values', () => {
    const goal = 'fill in this form for me';
    const verdict = verifyPlan(
      [
        { index: 1, action: 'type' as const, text: 'fill' },
        { index: 2, action: 'type' as const, text: 'in' },
      ],
      FORM,
      goal,
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason.kind).toBe('not-a-value');
  });

  it('refuses a plan that redistributes most of the sentence', () => {
    const goal = 'asha menon bengaluru';
    const verdict = verifyPlan(
      [
        { index: 1, action: 'type' as const, text: 'asha menon' },
        { index: 2, action: 'type' as const, text: 'bengaluru' },
      ],
      FORM,
      goal,
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason.kind).toBe('shredded');
  });

  it('leaves an ordinary extraction alone', () => {
    const verdict = verifyPlan(
      [{ index: 1, action: 'type' as const, text: 'asha' }],
      FORM,
      'could you put my name down as asha please',
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('the model running out of sentence', () => {
  /**
   * Verbatim from a real run. Four lines to place on four fields: it put "Leo" in First
   * Name, "A" in Last Name, chose Australia in the dropdown, and typed the word "Subject"
   * into the Subject box.
   *
   * `fromSentence` happens to catch that one, because "subject" is not in the user's text.
   * It would not on a page whose field names the user had mentioned -- which is most pages
   * where somebody says "put my name in the name box". So the echo is named directly.
   */
  it('refuses a field’s own label typed into it', () => {
    const verdict = verifyPlan(
      [{ index: 2, action: 'type' as const, text: 'Email' }],
      FORM,
      'put Email in the second box',
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason.kind).toBe('echoed-label');
  });

  it('keeps the good actions and drops the echo', () => {
    const verdict = verifyPlan(
      [
        { index: 1, action: 'type' as const, text: 'Leo' },
        { index: 3, action: 'select' as const, text: 'Australia' },
        { index: 2, action: 'type' as const, text: 'Email' },
      ],
      FORM,
      'Leo, Australia, Email',
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.actions.map((a) => a.type)).toEqual(['type', 'select']);
    expect(verdict.dropped).toEqual([{ kind: 'echoed-label', index: 2 }]);
  });
});

describe('a dropdown is neither typing nor clicking', () => {
  it('becomes a select action', () => {
    const verdict = verifyPlan(
      [{ index: 3, action: 'select' as const, text: 'Australia' }],
      FORM,
      'set the country to Australia',
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.actions).toEqual([{ type: 'select', index: 3, option: 'Australia' }]);
  });

  it('still refuses an option the user never named', () => {
    const verdict = verifyPlan(
      [{ index: 3, action: 'select' as const, text: 'Canada' }],
      FORM,
      'pick my country',
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason.kind).toBe('invented-value');
  });
});

describe('a click does not survive a plan that lost actions', () => {
  /**
   * Measured on a real page. "Fill in this form for me" had all three of its invented values
   * dropped, and the one surviving action was a click on Submit -- so the agent submitted an
   * empty form on an instruction that had named nothing at all.
   *
   * Dropping is safe for a value: a dropped value types nothing. It is not safe for the
   * button that commits whatever is in the form, and a model that misread the fields misread
   * what it was completing.
   */
  it('drops the click and refuses, when nothing else survived', () => {
    const verdict = verifyPlan(
      [
        { index: 2, action: 'type' as const, text: 'invented@example.com' },
        { index: 4, action: 'click' as const, text: '' },
      ],
      FORM,
      'fill in this form for me',
    );
    expect(verdict.ok).toBe(false);
  });

  /**
   * The case this rule was found on, and the reason it drops rather than refuses. Four lines
   * down a form ending "Then click submit": three fields placed correctly, the fourth an
   * echoed label. Throwing away three good fills to avoid one bad submit helps nobody.
   */
  it('keeps the fills and holds back the submit', () => {
    const verdict = verifyPlan(
      [
        { index: 1, action: 'type' as const, text: 'leo' },
        { index: 3, action: 'select' as const, text: 'Australia' },
        { index: 2, action: 'type' as const, text: 'Email' },
        { index: 4, action: 'click' as const, text: '' },
      ],
      FORM,
      'leo, Australia, Email, then click send',
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.actions.map((a) => a.type)).toEqual(['type', 'select']);
    expect(verdict.dropped.map((d) => d.kind)).toEqual(['echoed-label', 'unsafe-commit']);
  });

  it('keeps a click in a plan that lost nothing', () => {
    const verdict = verifyPlan(
      [
        { index: 1, action: 'type' as const, text: 'leo' },
        { index: 4, action: 'click' as const, text: '' },
      ],
      FORM,
      'put leo in the first box and send it',
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.actions.map((a) => a.type)).toEqual(['type', 'click']);
  });

  it('still allows a partial plan that only lost a value', () => {
    const verdict = verifyPlan(
      [
        { index: 1, action: 'type' as const, text: 'leo' },
        { index: 2, action: 'type' as const, text: 'invented@example.com' },
      ],
      FORM,
      'my name is leo',
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('isNotAValue', () => {
  it('knows the asking from the answer', () => {
    for (const word of ['in', 'this', 'the form', 'fill', 'submit', 'my']) {
      expect(isNotAValue(word), word).toBe(true);
    }
    for (const word of ['leo', 'asha menon', 'hello there', 'refund', 'my order']) {
      expect(isNotAValue(word), word).toBe(false);
    }
  });
});

describe('fromSentence', () => {
  it('accepts what the user actually said', () => {
    expect(fromSentence('leo', 'put my name down as leo')).toBe(true);
    expect(fromSentence('Leo', 'put my name down as leo')).toBe(true);
    expect(fromSentence('asha menon', 'I am Asha Menon, fill it in')).toBe(true);
  });

  it('rejects what it did not', () => {
    expect(fromSentence('john@example.com', 'fill in the form')).toBe(false);
    expect(fromSentence('1234 5678 9012', 'fill in my aadhaar')).toBe(false);
  });

  it('lets a click through, having nothing to check', () => {
    expect(fromSentence('', 'anything at all')).toBe(true);
  });

  /**
   * Substring, not token-set. A model that reassembles the user's words into an order they
   * never used has composed something, and composing is what this guard is for.
   */
  it('does not accept the user’s words in a different order', () => {
    expect(fromSentence('menon asha', 'my name is asha menon')).toBe(false);
  });
});

describe('describeRejection', () => {
  it('names the component to distrust, without repeating the value', () => {
    const text = describeRejection({ kind: 'invented-value', index: 2 });
    expect(text).toContain('local model');
    expect(text).toContain('made up');
    expect(text).not.toContain('@');
  });

  it('says something for every kind', () => {
    for (const reason of [
      { kind: 'unknown-index', index: 9 },
      { kind: 'wrong-role', index: 1, role: 'button' },
      { kind: 'invented-value', index: 2 },
      { kind: 'smeared', fields: 4 },
      { kind: 'shredded', covered: 0.9 },
      { kind: 'not-a-value', index: 1 },
      { kind: 'echoed-label', index: 3 },
      { kind: 'unsafe-commit', index: 4 },
    ] as const) {
      expect(describeRejection(reason).length).toBeGreaterThan(20);
    }
  });
});
