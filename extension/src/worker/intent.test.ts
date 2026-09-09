/**
 * The parser, against the sentences people actually type.
 *
 * The bug this module exists for: "fill first name with leo" filled Last Name and Subject
 * with a canned email address and never touched First Name, because nothing in the
 * project read the goal at all.
 */

import { describe, it, expect } from 'vitest';
import { aliasesOf, normalise, parseGoal } from './intent';

describe('the phrasings people use', () => {
  const cases: Array<[string, { verb: string; target: string; value?: string }]> = [
    ['fill first name with leo', { verb: 'fill', target: 'first name', value: 'leo' }],
    ['set my email to x@y.in', { verb: 'fill', target: 'email', value: 'x@y.in' }],
    ['type leo in the first name box', { verb: 'fill', target: 'first name', value: 'leo' }],
    ['put leo as first name', { verb: 'fill', target: 'first name', value: 'leo' }],
    ['click submit', { verb: 'click', target: 'submit' }],
    ['choose India in country', { verb: 'select', target: 'country', value: 'India' }],
    ['press the apply button', { verb: 'click', target: 'apply' }],
    [
      'enter Asha Menon as full name',
      { verb: 'fill', target: 'full name', value: 'Asha Menon' },
    ],
    ['open spotify', { verb: 'navigate', target: 'spotify' }],
    ['go to amazon.in', { verb: 'navigate', target: 'amazon.in' }],
    ['navigate to https://google.com', { verb: 'navigate', target: 'https://google.com' }],
    ['search for best mobile phone under 30k', { verb: 'fill', target: 'search', value: 'best mobile phone under 30k' }],
    ['add to cart', { verb: 'click', target: 'cart' }],
    ['check the flexible with date checkbox', { verb: 'click', target: 'flexible with date' }],
    ['tick terms and conditions', { verb: 'click', target: 'terms and conditions' }],
    ['uncheck remember me', { verb: 'click', target: 'remember me' }],
    ['select flexible with date checkbox', { verb: 'click', target: 'flexible with date' }],
    ['check all the checkbox', { verb: 'click', target: 'all checkboxes' }],
    ['check all checkboxes', { verb: 'click', target: 'all checkboxes' }],
  ];

  for (const [sentence, want] of cases) {
    it(`reads "${sentence}"`, () => {
      const { intents, openEnded } = parseGoal(sentence);
      expect(openEnded).toBe(false);
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject(want);
    });
  }
});

describe('values keep their shape', () => {
  it('does not lower-case a value that is about to be typed', () => {
    // "Leo" is not "leo" in a name field, and this string is typed verbatim.
    expect(parseGoal('fill first name with Leo').intents[0]?.value).toBe('Leo');
  });

  it('strips quotes the user put round a value', () => {
    expect(parseGoal('set subject to "Refund request"').intents[0]?.value).toBe(
      'Refund request',
    );
  });
});

describe('open-ended goals', () => {
  /**
   * Not a parse failure. A task with no named field and no value is what the remote
   * planner is for, and saying so is the whole point of the flag.
   */
  const openEnded = [
    'book the next available appointment',
    'finish this application using my enrolment document',
    'find the cheapest flight and tell me the price',
  ];

  for (const goal of openEnded) {
    it(`leaves "${goal.slice(0, 32)}..." to the planner`, () => {
      const parsed = parseGoal(goal);
      expect(parsed.openEnded).toBe(true);
      expect(parsed.intents).toEqual([]);
    });
  }
});

describe('more than one instruction', () => {
  it('splits on and', () => {
    const { intents } = parseGoal('fill first name with leo and click submit');
    expect(intents.map((i) => i.verb)).toEqual(['fill', 'click']);
    expect(intents[0]?.value).toBe('leo');
    expect(intents[1]?.target).toBe('submit');
  });

  it('splits on a comma', () => {
    const { intents } = parseGoal('set email to a@b.in, click send');
    expect(intents).toHaveLength(2);
  });

  it('parses compound flight and checkbox goals without explicit conjunctions', () => {
    const { intents, residue, openEnded } = parseGoal(
      'from HYD to Del DD/MM/YYYY 10/09/2026 tick all the checkboxes',
    );
    expect(openEnded).toBe(false);
    expect(residue).toEqual([]);
    expect(intents).toHaveLength(4);
    expect(intents[0]).toMatchObject({ verb: 'fill', target: 'from', value: 'HYD' });
    expect(intents[1]).toMatchObject({ verb: 'fill', target: 'to', value: 'Del' });
    expect(intents[2]).toMatchObject({ verb: 'fill', target: 'date', value: '10/09/2026' });
    expect(intents[3]).toMatchObject({ verb: 'click', target: 'all checkboxes' });
  });
});

describe('target cleaning', () => {
  it('peels filler off the front and the back', () => {
    expect(parseGoal('type leo into the first name field').intents[0]?.target).toBe(
      'first name',
    );
  });

  it('keeps a target the alias table has never heard of', () => {
    expect(parseGoal('fill invoice reference with INV-9').intents[0]?.target).toBe(
      'invoice reference',
    );
  });
});

describe('aliases', () => {
  it('treats the ways of saying one field as one field', () => {
    for (const name of ['first name', 'firstname', 'given name', 'FNAME']) {
      expect(aliasesOf(name)).toContain('given name');
    }
  });

  it('gives an unknown target itself and nothing else', () => {
    expect(aliasesOf('invoice reference')).toEqual(['invoice reference']);
  });
});

describe('normalise', () => {
  it('collapses the punctuation forms of one name', () => {
    expect(normalise('First_Name')).toBe('first name');
    expect(normalise('  given-name ')).toBe('given name');
    expect(normalise('E-Mail:')).toBe('e mail');
  });

  it('keeps @ so an address stays one token', () => {
    expect(normalise('x@y.in')).toBe('x@y in');
  });
});
