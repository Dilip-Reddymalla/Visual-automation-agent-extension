/**
 * The instruction regression corpus, as a unit suite.
 *
 * `eval/corpus/instructions.json` holds the sentences and, for each, what the tier ladder
 * must do with it and *why*. Both halves are asserted. A sentence that escalates for the
 * wrong reason is a passing test hiding a broken rule: "Dont fill last name with Leo" would
 * have escalated on `below-floor` in a version of this code where `Dont` confused the
 * resolver instead of being refused, and that version would still fill the field the moment
 * the resolver got better at its job.
 *
 * No browser and no model. `parseGoal` and `chooseTier` are both node-pure, so the whole
 * corpus runs in single-digit milliseconds and can be run on every commit.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { ObservedElement } from '../shared/observed';
import type { IntentVerb } from './intent';
import { parseGoal } from './intent';
import { chooseTier, type EscalationReason } from './tiers';

interface Case {
  goal: string;
  expect: 'tier0' | 'escalate' | 'refuse';
  reason: EscalationReason | null;
  why?: string;
  residue?: string[];
  intents?: Array<{ verb: IntentVerb; target: string; value?: string }>;
}

const CASES: Case[] = JSON.parse(
  readFileSync(new URL('../../../eval/corpus/instructions.json', import.meta.url), 'utf8'),
).cases;

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

/**
 * The w3schools contact form, which is where both of the real failures happened.
 *
 * The corpus is scored against a real element list rather than an empty one, because two of
 * the expected reasons -- `below-floor` and `tie` -- are facts about a page. A misspelling
 * that escalates has to escalate because no field matched it, and with no elements every
 * sentence would escalate for that reason and the suite would prove nothing.
 *
 * One field is here that the real form does not have. "Enter Asha Menon as full name" is in
 * the corpus to pin how `as` is read, and on a page with no full-name box it would escalate
 * on resolution before the reading was ever exercised -- a green test asserting nothing.
 */
const CONTACT_FORM: ObservedElement[] = [
  el({ index: 1, labelText: 'First Name', autocomplete: 'given-name', idAttr: 'fname' }),
  el({ index: 2, labelText: 'Last Name', autocomplete: 'family-name', idAttr: 'lname' }),
  el({ index: 3, labelText: 'Country', role: 'combobox', nameAttr: 'country' }),
  el({ index: 4, labelText: 'Subject', idAttr: 'subject' }),
  el({ index: 5, labelText: 'Message', tag: 'textarea' }),
  el({ index: 6, name: 'Submit', role: 'button' }),
  el({ index: 7, labelText: 'Full Name', autocomplete: 'name', idAttr: 'fullname' }),
];

describe('the instruction corpus', () => {
  it('is not empty, and every entry says what it expects', () => {
    expect(CASES.length).toBeGreaterThan(25);
    for (const entry of CASES) {
      expect(['tier0', 'escalate', 'refuse']).toContain(entry.expect);
      // A `tier0` case has no reason; everything else must name one. An entry that escalates
      // without saying why is the exact thing this suite exists to prevent in the code.
      if (entry.expect === 'tier0') expect(entry.reason).toBeNull();
      else expect(typeof entry.reason).toBe('string');
    }
  });

  it('holds both of the sentences that broke the agent on a real page', () => {
    const goals = CASES.map((entry) => entry.goal);
    expect(goals).toContain('Dont fill last name with Leo');
    expect(goals).toContain('Fill last name with leo and subject as Write Something');
  });

  for (const entry of CASES) {
    it(`${entry.expect}: ${entry.goal}`, () => {
      const parsed = parseGoal(entry.goal);
      const choice = chooseTier(parsed, CONTACT_FORM);

      if (entry.expect === 'tier0') {
        expect(choice.tier).toBe(0);
        // Zero residue is not a consequence of reaching Tier 0, it is the precondition.
        // Asserted separately so that a bug which lets residue through still fails here.
        expect(parsed.residue).toEqual([]);
        expect(parsed.coverage).toBe(1);
      } else {
        expect(choice.tier).not.toBe(0);
        if (choice.tier === 0) return;
        const reason = choice.tier === 1 ? choice.escalation.reason : choice.reason;
        expect(reason).toBe(entry.reason);
      }

      if (entry.residue) expect(parsed.residue).toEqual(entry.residue);

      if (entry.intents) {
        expect(
          parsed.intents.map((intent) => ({
            verb: intent.verb,
            target: intent.target,
            ...(intent.value === undefined ? {} : { value: intent.value }),
          })),
        ).toEqual(entry.intents);
      }
    });
  }
});

describe('refusal is not the same as escalation', () => {
  /**
   * Every `refuse` case must be blocked by the *sentence*, not by the page.
   *
   * This is the assertion that stops a negation from being fixed by accident. If `Dont` were
   * merely confusing the resolver, these would still escalate -- and would silently start
   * filling fields again the day the resolver improved.
   */
  for (const entry of CASES.filter((c) => c.expect === 'refuse')) {
    it(`refuses "${entry.goal}" before looking at the page`, () => {
      const parsed = parseGoal(entry.goal);
      expect(parsed.block?.kind).toBe('negation');
      // Same verdict against a page with no elements at all: nothing about the document
      // was consulted.
      expect(chooseTier(parsed, []).tier).toBe(2);
      expect(chooseTier(parsed, CONTACT_FORM)).toEqual(chooseTier(parsed, []));
    });
  }
});
