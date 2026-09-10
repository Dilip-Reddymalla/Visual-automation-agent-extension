/**
 * Turning a sentence into legs.
 *
 * The tests are deliberately spread across domains -- a shop, a council portal, a travel
 * site, a library, a hospital -- because the one thing this module must not do is work on
 * the example it was written against and nowhere else. If a change makes the shopping
 * sentence better and the licence-renewal sentence worse, that is not an improvement.
 */

import { describe, expect, it } from 'vitest';
import { MAX_SUBGOALS, type SubgoalKind } from '../shared/contract';
import { decompose, describeDecomposition, extractConstraints } from './decompose';
import { parseGoal } from './intent';

function plan(goal: string): Array<{ id: string; kind: SubgoalKind; after: string[] }> {
  return decompose(parseGoal(goal)).subgoals.map((s) => ({
    id: s.id,
    kind: s.kind,
    after: s.after,
  }));
}

function kinds(goal: string): SubgoalKind[] {
  return plan(goal).map((s) => s.kind);
}

describe('extractConstraints', () => {
  it('reads an upper limit with a currency mark', () => {
    expect(extractConstraints('under ₹30,000')).toEqual([
      { kind: 'max', value: 30000, unit: '₹', text: 'under ₹30,000' },
    ]);
  });

  it.each([
    ['below 500', 500],
    ['less than 500', 500],
    ['cheaper than 500', 500],
    ['at most 500', 500],
    ['no more than 500', 500],
    ['up to 500', 500],
    ['within 500', 500],
    ['maximum of 500', 500],
  ])('reads "%s" as an upper limit', (text, value) => {
    const [constraint] = extractConstraints(text);
    expect(constraint?.kind).toBe('max');
    expect(constraint?.value).toBe(value);
  });

  it.each([
    ['over 4', 4],
    ['more than 4', 4],
    ['at least 4', 4],
    ['minimum of 4', 4],
  ])('reads "%s" as a lower limit', (text, value) => {
    const [constraint] = extractConstraints(text);
    expect(constraint?.kind).toBe('min');
    expect(constraint?.value).toBe(value);
  });

  it.each([
    ['under 30k', 30_000],
    ['under 1.5 lakh', 150_000],
    ['under 2 crore', 20_000_000],
    ['under 3m', 3_000_000],
  ])('expands the multiplier in "%s"', (text, value) => {
    expect(extractConstraints(text)[0]?.value).toBe(value);
  });

  it('reads a range as one constraint, not as a min and a max', () => {
    // "between 10000 and 30000" contains the word `and`, and its lower bound would
    // otherwise also match the `from`-style lower-limit pattern.
    expect(extractConstraints('between 10,000 and 30,000')).toEqual([
      { kind: 'range', value: 10000, upper: 30000, unit: '', text: 'between 10,000 and 30,000' },
    ]);
  });

  it('normalises a range written the wrong way round', () => {
    const [constraint] = extractConstraints('between 30000 and 10000');
    expect(constraint?.value).toBe(10000);
    expect(constraint?.upper).toBe(30000);
  });

  it('does not treat a bare quantity as a constraint', () => {
    // "add 2 to the basket" is a quantity. Reading it as a limit would filter a list
    // nobody asked to filter.
    expect(extractConstraints('add 2 tickets to the basket')).toEqual([]);
    expect(extractConstraints('fill pin with 4321')).toEqual([]);
  });

  it('keeps several constraints in the order they were written', () => {
    const found = extractConstraints('over 4 stars and under 30000');
    expect(found.map((c) => c.kind)).toEqual(['min', 'max']);
  });
});

describe('decompose', () => {
  describe('a shopping-shaped goal', () => {
    const GOAL =
      'Go to a shopping site, search for mobiles, find the best phone under ₹30,000, and add it to the cart';

    it('derives the legs the goal names, in order', () => {
      expect(kinds(GOAL)).toEqual([
        'navigate',
        'search',
        'inspect',
        'filter',
        'select',
        'interact',
        'confirm',
      ]);
    });

    it('chains each leg behind the one before it', () => {
      const legs = plan(GOAL);
      expect(legs[0]?.after).toEqual([]);
      for (let i = 1; i < legs.length; i++) {
        expect(legs[i]?.after).toEqual([legs[i - 1]?.id]);
      }
    });

    it('reads the budget as thirty thousand, not thirty', () => {
      // The comma in "₹30,000" used to split the clause, so the limit was read as 30 and
      // the run then filtered every candidate out and reported, correctly and uselessly,
      // that nothing qualified.
      expect(decompose(parseGoal(GOAL)).constraints[0]?.value).toBe(30_000);
    });

    it('leaves no clause unaccounted for', () => {
      expect(decompose(parseGoal(GOAL)).unclassified).toEqual([]);
    });

    it('knows nothing about shops', () => {
      // The same five legs, on a page that sells nothing.
      expect(
        kinds(
          'open the council portal, search for parking permits, choose the residents permit and apply for it',
        ),
      ).toEqual(['navigate', 'search', 'select', 'submit', 'confirm']);

      expect(
        kinds('go to the library catalogue, search for books on hydrology and reserve the first one'),
      ).toEqual(['navigate', 'search', 'submit', 'confirm']);
    });
  });

  describe('classification', () => {
    it.each([
      ['go to example.test', 'navigate'],
      ['open the portal', 'navigate'],
      ['visit the help page', 'navigate'],
      ['https://example.test/apply', 'navigate'],
      ['example.test/apply', 'navigate'],
      ['search for mobiles', 'search'],
      ['look up train times', 'search'],
      ['filter by price', 'filter'],
      ['only show the ones in stock', 'filter'],
      ['find a nearby clinic', 'inspect'],
      ['compare the two plans', 'inspect'],
      ['select the second option', 'select'],
      ['add it to the basket', 'interact'],
      ['click the next button', 'interact'],
      ['submit the form', 'submit'],
      ['book the appointment', 'submit'],
    ])('classifies "%s" as %s', (clause, kind) => {
      // Wrapped in a second clause so the result is a plan rather than a single leg.
      const legs = kinds(`${clause}, then submit the form`);
      expect(legs[0]).toBe(kind);
    });

    it('tells "check the box" from "check the results"', () => {
      expect(kinds('open the site, check the box')[1]).toBe('interact');
      expect(kinds('open the site, check the results')[1]).toBe('inspect');
    });

    it('tells "confirm the order" from "confirm that it went through"', () => {
      expect(kinds('open the site, confirm the order')[1]).toBe('submit');
      expect(kinds('open the site, confirm that the booking is made')[1]).toBe('confirm');
    });
  });

  describe('what it refuses to invent', () => {
    it('produces no plan for a single-field instruction', () => {
      // Not a multi-step task. A plan here would put a decomposition on the wire, in the
      // state record and in the step note for every ordinary form fill.
      expect(plan('fill first name with Leo')).toEqual([]);
      expect(plan('click the submit button')).toEqual([]);
    });

    it('produces no plan for a sentence with nothing actionable in it', () => {
      expect(plan('')).toEqual([]);
      expect(plan('hello there')).toEqual([]);
    });

    it('reports a clause it could not classify rather than guessing', () => {
      const result = decompose(
        parseGoal('open the portal, search for permits, wibble the frobnicator'),
      );
      expect(result.unclassified).toEqual(['wibble the frobnicator']);
      expect(result.subgoals.map((s) => s.kind)).toEqual(['navigate', 'search']);
    });

    it('produces no plan when only one clause could be classified', () => {
      // One leg plus a clause nobody understood is not a decomposition, it is a
      // single-step task with a sentence fragment attached.
      const result = decompose(parseGoal('open the portal, wibble the frobnicator'));
      expect(result.subgoals).toEqual([]);
      expect(result.unclassified).toContain('wibble the frobnicator');
    });

    it('still records a limit stated inside a clause it could not classify', () => {
      // intent.ts splits "flights from Delhi to Mumbai under 8000" at the from/to
      // boundary, which leaves the limit in a fragment with no verb in it. The limit is
      // still what the user asked for.
      const result = decompose(
        parseGoal('search for flights from Delhi to Mumbai under 8000 and book the earliest one'),
      );
      expect(result.constraints[0]?.value).toBe(8000);
      expect(result.subgoals.map((s) => s.kind)).toContain('filter');
    });

    it('gives criteria only where the verb implies one', () => {
      const legs = decompose(
        parseGoal('go to the portal, search for permits, filter by district, submit the form'),
      ).subgoals;
      const by = (kind: SubgoalKind) => legs.find((s) => s.kind === kind);

      expect(by('navigate')?.criteria).toEqual([{ check: 'url-changed', hint: '' }]);
      expect(by('search')?.criteria[0]?.check).toBe('element-present');
      // A filter has no signature that holds on every site. Inventing one would fail legs
      // that succeeded.
      expect(by('filter')?.criteria).toEqual([]);
    });

    it('keeps a value out of a criterion hint', () => {
      const legs = decompose(
        parseGoal('open the portal, fill first name with Leo, submit the form'),
      ).subgoals;
      const hints = legs.flatMap((s) => s.criteria.map((c) => c.hint)).join(' ');
      expect(hints).not.toContain('Leo');
    });
  });

  describe('bounds', () => {
    it('never exceeds the plan limit however long the sentence', () => {
      const goal = Array.from({ length: 30 }, (_, i) => `click button ${i}`).join(', ');
      const legs = plan(goal);
      expect(legs.length).toBeLessThanOrEqual(MAX_SUBGOALS);
    });

    it('gives each leg a step budget in range', () => {
      const legs = decompose(
        parseGoal('go to the site, search for a thing, find the best one, add it, submit'),
      ).subgoals;
      expect(legs.length).toBeGreaterThan(0);
      for (const leg of legs) {
        expect(leg.budget).toBeGreaterThanOrEqual(1);
        expect(leg.budget).toBeLessThanOrEqual(10);
      }
    });

    it('gives every leg a distinct id', () => {
      const legs = plan(
        'go to the site, search for phones, search for tablets, add one, add another, submit',
      );
      expect(new Set(legs.map((s) => s.id)).size).toBe(legs.length);
    });

    it('derives the same plan from the same sentence twice', () => {
      // Ids have to be stable, or a replan that reuses them loses the run's progress.
      const goal = 'go to the site, search for phones, add the cheapest to the basket';
      expect(plan(goal)).toEqual(plan(goal));
    });
  });

  describe('a choice the sentence implies', () => {
    it('adds a select leg when the goal names a superlative', () => {
      expect(kinds('search for hotels, find the cheapest one')).toEqual([
        'search',
        'inspect',
        'select',
        'confirm',
      ]);
    });

    it('does not add one when a select leg is already there', () => {
      const legs = kinds('search for hotels, choose the cheapest one');
      expect(legs.filter((k) => k === 'select')).toHaveLength(1);
    });
  });

  it('describes itself by leg ids alone', () => {
    const result = decompose(parseGoal('go to the site, search for phones, add one'));
    expect(describeDecomposition(result)).toMatch(/^plan: navigate-1 -> search-1/);
    // Never page content: the note reaches the panel and the step log.
    expect(describeDecomposition(result)).not.toContain('phones');
  });
});
