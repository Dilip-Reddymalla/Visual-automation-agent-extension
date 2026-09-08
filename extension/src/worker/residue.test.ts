/**
 * The residue rule, on its own.
 *
 * `instructions.test.ts` runs the corpus and asserts outcomes. This file asserts the
 * mechanism underneath: which characters were counted as read, and why. The two are worth
 * separating because a corpus entry can pass for the wrong reason — a sentence that
 * escalates because the resolver could not place it looks identical, from the outside, to
 * one that escalates because half of it was never read.
 */

import { describe, it, expect } from 'vitest';
import {
  describeBlock,
  fieldWithin,
  findNegation,
  isKnownField,
  NEGATIONS,
  parseGoal,
} from './intent';

describe('coverage counts what was read, not what was walked past', () => {
  it('is 1 for a sentence consumed whole', () => {
    const parsed = parseGoal('fill first name with leo');
    expect(parsed.coverage).toBe(1);
    expect(parsed.residue).toEqual([]);
  });

  /**
   * The specific arithmetic bug this rule is exposed to.
   *
   * A pattern anchored at the end reports where it *started*. Using the match's end offset
   * as "characters consumed" makes any sentence containing a verb read as fully consumed,
   * which is the original failure wearing a coverage number.
   */
  it('does not count the text in front of the verb as read', () => {
    const parsed = parseGoal('Dont fill last name with Leo');
    expect(parsed.residue).toEqual(['Dont']);
    expect(parsed.coverage).toBeLessThan(1);
    // "fill last name with Leo" is 23 of the sentence's 28 characters. The other five are
    // "Dont" and the space after it, and neither was read by anything.
    expect(parsed.coverage).toBeCloseTo(23 / 28, 5);
  });

  it('reports leftovers from every clause, in reading order', () => {
    const parsed = parseGoal('gibberish fill first name with leo, nonsense click submit');
    expect(parsed.residue).toEqual(['gibberish', 'nonsense']);
  });

  it('counts separators and the spaces around them as read', () => {
    const parsed = parseGoal('fill first name with leo, and then click submit');
    expect(parsed.coverage).toBe(1);
    expect(parsed.residue).toEqual([]);
  });

  it('never reports a coverage outside [0, 1]', () => {
    for (const goal of ['', '   ', '...', 'and and and', 'fill fill fill with with']) {
      const parsed = parseGoal(goal);
      expect(parsed.coverage).toBeGreaterThanOrEqual(0);
      expect(parsed.coverage).toBeLessThanOrEqual(1);
    }
  });
});

describe('the ignore list consumes filler visibly', () => {
  it('eats politeness in front of the verb', () => {
    const parsed = parseGoal('can you please fill first name with leo now');
    expect(parsed.residue).toEqual([]);
    expect(parsed.coverage).toBe(1);
    expect(parsed.intents[0]?.value).toBe('leo');
  });

  it('eats a trailing filler word from a value whose field has a class', () => {
    expect(parseGoal('fill first name with leo now').intents[0]?.value).toBe('leo');
  });

  /**
   * The reason trailing filler is guarded rather than stripped everywhere. A message box
   * has no class, so "now" is part of what the user wants typed; taking it off would be a
   * value silently truncated, and the agent would go and type the truncation.
   */
  it('leaves a free-text value exactly as written', () => {
    expect(parseGoal('fill message with call me now').intents[0]?.value).toBe('call me now');
    expect(parseGoal('fill subject with thanks').intents[0]?.value).toBe('thanks');
  });

  it('does not treat filler inside a value as an instruction', () => {
    const parsed = parseGoal('fill subject with please click submit');
    expect(parsed.intents).toHaveLength(1);
    expect(parsed.intents[0]?.value).toBe('please click submit');
  });

  it('treats a clause of pure politeness as understood and empty', () => {
    const parsed = parseGoal('please, fill first name with leo');
    expect(parsed.residue).toEqual([]);
    expect(parsed.intents).toHaveLength(1);
  });
});

describe('negation', () => {
  it('finds every token on the list', () => {
    const sentences: Record<string, string> = {
      not: 'do fill it not',
      'do not': 'do not fill it',
      "don't": "don't fill it",
      dont: 'dont fill it',
      never: 'never fill it',
      without: 'fill it without the email',
      except: 'fill all except the email',
      unless: 'fill it unless set',
      avoid: 'avoid the email',
      skip: 'skip the email',
      'instead of': 'fill last instead of first',
      'rather than': 'click save rather than submit',
      'but not': 'fill first but not last',
    };
    for (const sentence of Object.values(sentences)) {
      expect(findNegation(sentence), sentence).toBeTruthy();
    }
    expect(Object.keys(sentences).every((token) => NEGATIONS.includes(token))).toBe(true);
    // Every documented token is reachable from some sentence.
    expect(NEGATIONS).toContain('but not');
  });

  /**
   * The false positive that would have made this rule worse than useless. A suffix pattern
   * for `n't` also matches "account", "want" and "print" -- and refusing to fill an
   * account-number field is its own severity-one bug.
   */
  it('does not fire on ordinary words that merely end in nt', () => {
    for (const goal of [
      'fill account number with 12345',
      'fill the print name with leo',
      'i want the first name filled with leo',
      'fill the current address with 5 mg road',
    ]) {
      expect(findNegation(goal), goal).toBeUndefined();
      expect(parseGoal(goal).block?.kind, goal).not.toBe('negation');
    }
  });

  it('does not fire on a word that merely contains one', () => {
    expect(findNegation('fill notes with hello')).toBeUndefined();
    expect(findNegation('fill the skipper field with x')).toBeUndefined();
  });

  it('refuses rather than stripping the token and carrying on', () => {
    const parsed = parseGoal('Dont fill last name with Leo');
    // The intent is still produced -- the grammar reads what it can -- and the block is what
    // stops it being acted on. Deleting the intent instead would lose the evidence that the
    // sentence named a field at all.
    expect(parsed.intents).toHaveLength(1);
    expect(parsed.block).toEqual({ kind: 'negation', token: 'dont' });
  });

  it('reports the negation ahead of the residue it also causes', () => {
    const parsed = parseGoal('Dont fill last name with Leo');
    expect(parsed.residue).toEqual(['Dont']);
    expect(parsed.block?.kind).toBe('negation');
  });
});

describe('a clause that does not parse blocks the whole goal', () => {
  it('does not act on the half that parsed', () => {
    // A clause the grammar genuinely cannot read. "subject as Write Something" used to be
    // this example and is now read as a labelled pair, which is what it means -- so the
    // rule is shown with a clause that really has nothing in it.
    const parsed = parseGoal('fill last name with leo and qwertyuiop asdfgh');
    expect(parsed.intents).toHaveLength(1);
    expect(parsed.block).toEqual({ kind: 'unparsed', clause: 'qwertyuiop asdfgh' });
  });

  /**
   * The M16 sentence, which now parses whole.
   *
   * Its acceptance criterion was "fills both fields or escalates the whole goal, never one
   * field and done". Filling both is the better half of that, and the second clause is only
   * unreadable if you insist on a verb: it opens with a field name the table knows.
   */
  it('reads a verbless clause that names a field and a value', () => {
    const parsed = parseGoal('Fill last name with leo and subject as Write Something');
    expect(parsed.block).toBeUndefined();
    expect(parsed.intents).toEqual([
      { verb: 'fill', target: 'last name', cls: 'PERSON', value: 'leo' },
      { verb: 'fill', target: 'subject', value: 'Write Something' },
    ]);
  });

  it('takes the value as written, and only after every pattern has declined', () => {
    expect(parseGoal('date of birth 24/06/2000').intents[0]).toMatchObject({
      verb: 'fill',
      target: 'date of birth',
      value: '24/06/2000',
    });
    // An explicit verb still wins: this is pattern 1, not a pair.
    expect(parseGoal('fill subject with hello').intents[0]?.value).toBe('hello');
  });

  it('will not read a button name as a field', () => {
    // "apply" names a button. Reading "apply with x@y.in" as filling a field called Apply
    // put the address into session storage in the clear, which the router sweep caught.
    expect(parseGoal('apply with asha@example.in').intents).toEqual([]);
  });

  it('needs something after the field name', () => {
    expect(parseGoal('date of birth').intents).toEqual([]);
  });

  /**
   * The alias table cannot cover the web. "DL Number" is a field on precisely one
   * government website, and a table grown to hold it would still miss the next site.
   *
   * What generalises is the value: a bare number, date or email ending a verbless clause is
   * the thing being entered, and what precedes it is what it goes in. The page still has
   * the last word -- an opener naming nothing resolves to nothing and the step escalates.
   */
  it('reads a value-shaped tail with an unknown field name in front of it', () => {
    expect(parseGoal('DL Number 10001000193').intents[0]).toMatchObject({
      verb: 'fill',
      target: 'dl number',
      value: '10001000193',
    });
    expect(parseGoal('Policy No 123/456').intents[0]).toMatchObject({
      target: 'policy no',
      value: '123/456',
    });
  });

  it('will not read prose as a field name, however it ends', () => {
    for (const goal of [
      'book me a table for 4',
      'the next available appointment please',
      'apply with asha@example.in',
      '10001000193',
    ]) {
      expect(parseGoal(goal).intents, goal).toEqual([]);
    }
  });

  it('leaves a goal where nothing parsed as open-ended instead', () => {
    const parsed = parseGoal('book the next available appointment');
    expect(parsed.block).toBeUndefined();
    expect(parsed.openEnded).toBe(true);
  });

  it('records one report per clause, in order', () => {
    const parsed = parseGoal('fill first name with leo and gibberish');
    expect(parsed.clauses.map((c) => c.outcome)).toEqual(['parsed', 'unparsed']);
  });
});

describe('`as` is ambiguous only when both readings name a real field', () => {
  it('reads the value first when only one reading is a known field', () => {
    const parsed = parseGoal('enter Asha Menon as full name');
    expect(parsed.block).toBeUndefined();
    expect(parsed.intents[0]).toMatchObject({ target: 'full name', value: 'Asha Menon' });
  });

  it('escalates when both halves are field names', () => {
    const parsed = parseGoal('enter subject as message');
    expect(parsed.block).toEqual({
      kind: 'ambiguous',
      clause: 'enter subject as message',
      readings: ['message', 'subject'],
    });
  });

  it('knows which names the alias table recognises', () => {
    expect(isKnownField('full name')).toBe(true);
    expect(isKnownField('surname')).toBe(true);
    expect(isKnownField('Asha Menon')).toBe(false);
  });
});

describe('`as` read backwards', () => {
  /**
   * The parivahan case. "Select state as telangana" gave target "telangana" and value
   * "state", so the agent looked for a field called Telangana on a page whose only dropdown
   * was the state one -- found nothing, escalated, and died at a planner.
   *
   * The pattern has to commit to one reading of `as`, and whichever it commits to is wrong
   * half the time. What settles it is which half could plausibly be a field.
   */
  it('swaps when only the other half names a field', () => {
    const parsed = parseGoal('select state as telangana');
    expect(parsed.block).toBeUndefined();
    expect(parsed.intents[0]).toMatchObject({
      verb: 'select',
      target: 'state',
      value: 'telangana',
    });
  });

  it('reads the same sentence the same way written the other way round', () => {
    const asForm = parseGoal('select state as telangana').intents[0];
    const inForm = parseGoal('select telangana in state').intents[0];
    expect({ verb: asForm?.verb, target: asForm?.target, value: asForm?.value }).toEqual({
      verb: inForm?.verb,
      target: inForm?.target,
      value: inForm?.value,
    });
  });

  /**
   * No vocabulary covers every site. "DL Number" is a field on precisely one government
   * website, so neither half of "enter DL Number as 10001000193" is in any alias table --
   * and the parser hands both readings up rather than guessing between them.
   */
  it('offers the other reading when no table can settle it', () => {
    const parsed = parseGoal('enter DL Number as 10001000193');
    expect(parsed.intents[0]).toMatchObject({ target: '10001000193', value: 'DL Number' });
    expect(parsed.intents[0]?.alt).toEqual({ target: 'dl number', value: '10001000193' });
  });

  /** The field name is trimmed out of the phrase that carried it. */
  it('finds the field inside a longer phrase', () => {
    expect(parseGoal('put my first name down as Asha').intents[0]).toMatchObject({
      verb: 'fill',
      target: 'first name',
      value: 'Asha',
    });
  });

  it('leaves a correct reading alone', () => {
    expect(parseGoal('enter Asha Menon as full name').intents[0]).toMatchObject({
      target: 'full name',
      value: 'Asha Menon',
    });
  });

  it('still escalates when both halves name a field', () => {
    expect(parseGoal('enter subject as message').block?.kind).toBe('ambiguous');
  });

  it('leaves it as read when neither half names a field', () => {
    expect(parseGoal('enter foo as bar').intents[0]).toMatchObject({
      target: 'bar',
      value: 'foo',
    });
  });
});

describe('fieldWithin', () => {
  it('finds a field name inside a phrase, longest first', () => {
    expect(fieldWithin('my first name down')).toBe('first name');
    expect(fieldWithin('DL Holder’s Last Transaction State')).toBe('state');
    expect(fieldWithin('telangana')).toBeUndefined();
    expect(fieldWithin('Asha Menon')).toBeUndefined();
  });

  it('matches whole words only', () => {
    // "estates" contains "state" as a substring and names no field.
    expect(fieldWithin('estates')).toBeUndefined();
  });
});

describe('describeBlock', () => {
  it('says something an operator can act on for every kind', () => {
    const goals = [
      'Dont fill last name with Leo',
      'fill last name with leo and qwertyuiop asdfgh',
      'enter subject as message',
    ];
    for (const goal of goals) {
      const block = parseGoal(goal).block;
      expect(block, goal).toBeTruthy();
      if (!block) continue;
      const described = describeBlock(block);
      expect(described.length).toBeGreaterThan(20);
      expect(described).not.toContain('undefined');
    }
  });
});
