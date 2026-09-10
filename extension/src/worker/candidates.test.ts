/**
 * Choosing between things on a page.
 *
 * The fixtures are three different shapes of page -- a grid of priced cards, a list of
 * flights, a table of appointment slots -- because a chooser that works on one layout and
 * not the others is a chooser for one website.
 */

import { describe, expect, it } from 'vitest';
import type { ObservedElement } from '../shared/observed';
import {
  CARD_BAND,
  MAX_CANDIDATES,
  constraintsConflict,
  containerOf,
  describeEvaluation,
  evaluate,
  findCandidates,
  pathOf,
  preferenceIn,
  readAmounts,
  type Candidate,
} from './candidates';
import { extractConstraints, type Constraint } from './decompose';

function link(over: Partial<ObservedElement> & { name: string }): ObservedElement {
  return {
    index: 1,
    role: 'link',
    box: { x: 0, y: 0, w: 200, h: 24 },
    state: { visible: true, enabled: true, focused: false, filled: false },
    occluded: 0,
    isNew: false,
    tag: 'a',
    textRuns: [],
    // The real shape: `frame|tag|role|name|path`. Candidates are scoped by the path's
    // container, so a fixture with a made-up key would not exercise the rule.
    key: `|a|link|${over.name}|html/body/ul/li[${over.index ?? 1}]/a`,
    ...over,
  };
}

function text(
  name: string,
  box: ObservedElement['box'],
  cardPath = 'html/body/ul/li[1]',
): ObservedElement {
  return {
    role: 'text',
    box,
    state: { visible: true, enabled: true, focused: false, filled: false },
    occluded: 0,
    isNew: false,
    tag: 'span',
    textRuns: [{ text: name, box, nodeIndex: 0 }],
    key: `|span|text|${name}|${cardPath}/div`,
    name: '',
  };
}

/** A grid of product cards: a title link with the price printed under it. */
function cards(prices: number[]): ObservedElement[] {
  const out: ObservedElement[] = [];
  prices.forEach((price, i) => {
    const y = i * 300;
    out.push(link({ index: i + 1, name: `Item ${i + 1}`, box: { x: 0, y, w: 200, h: 24 } }));
    out.push(
      text(`₹${price.toLocaleString('en-IN')}`, { x: 0, y: y + 40, w: 200, h: 20 },
        `html/body/ul/li[${i + 1}]`),
    );
  });
  return out;
}

const constraint = (over: Partial<Constraint> = {}): Constraint => ({
  kind: 'max',
  value: 30000,
  unit: '₹',
  text: 'under ₹30,000',
  ...over,
});

describe('readAmounts', () => {
  it('reads a currency amount with its mark', () => {
    expect(readAmounts('Now ₹28,999')).toEqual([
      { value: 28999, unit: '₹', text: '₹28,999' },
    ]);
  });

  it('expands a written multiplier', () => {
    expect(readAmounts('1.2 lakh')[0]?.value).toBe(120000);
  });

  it('reads several amounts in the order they were written', () => {
    expect(readAmounts('was ₹40,000 now ₹28,999').map((f) => f.value)).toEqual([40000, 28999]);
  });

  it('finds nothing in a string with no numbers', () => {
    expect(readAmounts('Out of stock')).toEqual([]);
  });
});

describe('findCandidates', () => {
  it('claims the numbers printed under each anchor', () => {
    const found = findCandidates(cards([28999, 41500]));
    expect(found.map((c) => c.name)).toEqual(['Item 1', 'Item 2']);
    expect(found[0]?.facts.map((f) => f.value)).toEqual([28999]);
    expect(found[1]?.facts.map((f) => f.value)).toEqual([41500]);
  });

  it('does not let one card claim the next card"s price', () => {
    // Too generous a band and every candidate takes its neighbour's number, which is
    // worse than taking none: a wrong number is acted on, a missing one escalates.
    const found = findCandidates(cards([28999, 41500]), CARD_BAND);
    expect(found[0]?.facts).toHaveLength(1);
  });

  it('reads a row of a table as well as a card in a grid', () => {
    // A flight row: the link and the fare on the same line rather than stacked.
    const elements = [
      link({ index: 1, name: 'AI 501 06:10', box: { x: 0, y: 100, w: 300, h: 30 } }),
      text('₹4,250', { x: 40, y: 108, w: 80, h: 20 }, 'html/body/ul/li[1]'),
      link({ index: 2, name: 'AI 812 09:35', box: { x: 0, y: 160, w: 300, h: 30 } }),
      text('₹6,900', { x: 40, y: 168, w: 80, h: 20 }, 'html/body/ul/li[2]'),
    ];
    const found = findCandidates(elements, 40);
    expect(found[0]?.facts[0]?.value).toBe(4250);
    expect(found[1]?.facts[0]?.value).toBe(6900);
  });

  it('ignores anything the user cannot act on', () => {
    const elements = [
      link({ index: 1, name: 'Visible', box: { x: 0, y: 0, w: 100, h: 20 } }),
      link({
        index: 2,
        name: 'Hidden',
        box: { x: 0, y: 400, w: 100, h: 20 },
        state: { visible: false, enabled: true, focused: false, filled: false },
      }),
      link({ name: 'Unindexed', index: undefined, box: { x: 0, y: 800, w: 100, h: 20 } }),
    ];
    expect(findCandidates(elements).map((c) => c.name)).toEqual(['Visible']);
  });

  it('is bounded however long the page', () => {
    const found = findCandidates(cards(Array.from({ length: 200 }, (_, i) => 1000 + i)));
    expect(found).toHaveLength(MAX_CANDIDATES);
  });

  it('returns candidates in reading order', () => {
    const elements = [
      link({ index: 2, name: 'Second', box: { x: 0, y: 300, w: 100, h: 20 } }),
      link({ index: 1, name: 'First', box: { x: 0, y: 0, w: 100, h: 20 } }),
    ];
    expect(findCandidates(elements).map((c) => c.name)).toEqual(['First', 'Second']);
  });
});

describe('preferenceIn', () => {
  it.each([
    ['find the cheapest phone', 'lowest'],
    ['book the earliest flight', 'lowest'],
    ['pick the top-rated hotel', 'highest'],
    ['take the first available slot', 'first'],
    ['find a phone under 30000', 'none'],
  ])('reads "%s" as %s', (goal, expected) => {
    expect(preferenceIn(goal)).toBe(expected);
  });
});

describe('constraintsConflict', () => {
  it('sees a floor above a ceiling', () => {
    expect(
      constraintsConflict([constraint({ kind: 'min', value: 40000 }), constraint({ value: 30000 })]),
    ).toBe(true);
  });

  it('accepts limits that can both hold', () => {
    expect(
      constraintsConflict([constraint({ kind: 'min', value: 10000 }), constraint({ value: 30000 })]),
    ).toBe(false);
  });
});

describe('evaluate', () => {
  const run = (
    elements: ObservedElement[],
    goal: string,
    constraints = extractConstraints(goal),
  ) =>
    evaluate({
      candidates: findCandidates(elements),
      constraints,
      preference: preferenceIn(goal),
    });

  it('rules out everything over the budget the user stated', () => {
    const result = run(cards([28999, 41500, 25000]), 'find a phone under ₹30,000');
    expect(result.eligible.map((c) => c.name)).toEqual(['Item 1', 'Item 3']);
    expect(result.rejected.map((r) => r.why)).toEqual(['over-maximum']);
  });

  it('chooses the cheapest when the goal asked for the cheapest', () => {
    const result = run(cards([28999, 41500, 25000]), 'find the cheapest phone under ₹30,000');
    expect(result.verdict).toBe('choose');
    expect(result.best?.name).toBe('Item 3');
  });

  it('chooses the dearest when the goal asked for the dearest', () => {
    const result = run(cards([28999, 41500, 25000]), 'find the most expensive phone');
    expect(result.best?.name).toBe('Item 2');
  });

  it('chooses the only eligible candidate without needing an ordering', () => {
    const result = run(cards([28999, 41500, 55000]), 'find a phone under ₹30,000');
    expect(result.verdict).toBe('choose');
    expect(result.best?.name).toBe('Item 1');
  });

  it('refuses to pick between several when the goal named no ordering', () => {
    // "Find a phone under 30,000" asks for an eligible one; picking one of four is a
    // choice this module is not entitled to make.
    const result = run(cards([28999, 25000, 21000]), 'find a phone under ₹30,000');
    expect(result.verdict).toBe('insufficient-evidence');
    expect(result.best).toBeUndefined();
    expect(result.eligible).toHaveLength(3);
  });

  it('refuses to break a tie at the top', () => {
    const result = run(cards([25000, 25000, 41000]), 'find the cheapest phone under ₹30,000');
    expect(result.verdict).toBe('insufficient-evidence');
  });

  it('says nothing qualified when everything was ruled out', () => {
    const result = run(cards([41500, 55000]), 'find a phone under ₹30,000');
    expect(result.verdict).toBe('none-eligible');
    expect(result.reason).toContain('outside the stated limits');
  });

  it('says the page did not print what the sentence asked about', () => {
    // Cards with no prices on them. Counting these as eligible is how an unpriced item
    // ends up in a basket.
    const elements = [
      link({ index: 1, name: 'Item 1', box: { x: 0, y: 0, w: 200, h: 24 } }),
      link({ index: 2, name: 'Item 2', box: { x: 0, y: 300, w: 200, h: 24 } }),
    ];
    const result = run(elements, 'find the cheapest phone under ₹30,000');
    expect(result.verdict).toBe('insufficient-evidence');
    expect(result.unjudged).toHaveLength(2);
    expect(result.reason).toContain('none printing a number');
  });

  it('reports constraints that cannot all hold', () => {
    const result = run(cards([28999]), 'find a phone under ₹30,000 and over ₹40,000');
    expect(result.verdict).toBe('conflicting-constraints');
    expect(result.best).toBeUndefined();
  });

  it('says there is nothing to choose between on an empty page', () => {
    expect(run([], 'find the cheapest phone').verdict).toBe('no-candidates');
  });

  it('does not compare a price to a star rating', () => {
    // The constraint named a currency, so only currency amounts may answer it.
    const elements = [
      link({ index: 1, name: 'Item 1', box: { x: 0, y: 0, w: 200, h: 24 } }),
      text('4.5 stars', { x: 0, y: 40, w: 200, h: 20 }, 'html/body/ul/li[1]'),
    ];
    const result = run(elements, 'find a phone under ₹30,000');
    expect(result.verdict).toBe('insufficient-evidence');
    expect(result.eligible).toHaveLength(0);
  });

  it('works on a page that sells nothing', () => {
    // An appointment list: the same five verdicts, no prices anywhere.
    const elements = [
      link({ index: 1, name: 'Slot A', box: { x: 0, y: 0, w: 200, h: 24 } }),
      text('waiting 12 days', { x: 0, y: 30, w: 200, h: 20 }, 'html/body/ul/li[1]'),
      link({ index: 2, name: 'Slot B', box: { x: 0, y: 300, w: 200, h: 24 } }),
      text('waiting 3 days', { x: 0, y: 330, w: 200, h: 20 }, 'html/body/ul/li[2]'),
    ];
    const result = run(elements, 'book the earliest slot within 7 days');
    expect(result.verdict).toBe('choose');
    expect(result.best?.name).toBe('Slot B');
  });

  it('describes itself in counts and enum names', () => {
    const result = run(cards([28999, 41500]), 'find the cheapest phone under ₹30,000');
    const line = describeEvaluation(result);
    expect(line).toContain('choose');
    // The candidates' own text does not go into a note.
    expect(line).not.toContain('Item');
  });

  it('carries no page text into anything a caller would persist', () => {
    const result = run(cards([28999]), 'find a phone under ₹30,000');
    const best: Candidate | undefined = result.best;
    // The candidate itself holds text -- it has to, to be read -- and what a caller takes
    // from it is the index. The note and the rejections carry no text at all.
    expect(JSON.stringify(result.rejected)).not.toContain('Item');
    expect(best?.index).toBe(1);
  });
});

describe('scoping facts to the card they were printed in', () => {
  it('does not let a navigation link claim a product price', () => {
    // The failure this rule was written for, and it only showed in a real browser: on a
    // product page "Back to the market" sits above the title, the price is printed a
    // hundred pixels below it, and a geometry-only rule let the Back link claim the
    // price. The run duly "chose" it, went back, and did the same thing again.
    const back: ObservedElement = {
      index: 1,
      role: 'link',
      box: { x: 0, y: 20, w: 180, h: 20 },
      state: { visible: true, enabled: true, focused: false, filled: false },
      occluded: 0,
      isNew: false,
      tag: 'a',
      textRuns: [],
      key: '|a|link|Back to the market|html/body/p[1]/a',
      name: 'Back to the market',
    };
    const price: ObservedElement = {
      role: 'text',
      box: { x: 0, y: 100, w: 180, h: 24 },
      state: { visible: true, enabled: true, focused: false, filled: false },
      occluded: 0,
      isNew: false,
      tag: 'p',
      textRuns: [{ text: '₹18,499', box: { x: 0, y: 100, w: 180, h: 24 }, nodeIndex: 0 }],
      key: '|p|text|₹18,499|html/body/p[2]',
      name: '',
    };

    const [candidate] = findCandidates([back, price]);
    expect(candidate?.name).toBe('Back to the market');
    expect(candidate?.facts).toEqual([]);
  });

  it('reads the container out of the key stableKey actually produces', () => {
    // If content/perceive.ts changes the key format, this breaks here rather than
    // quietly widening every card back out to the whole page.
    expect(containerOf('|a|link|Aster 5 phone|html/body/ul/li[1]/a')).toBe(
      'html/body/ul/li[1]',
    );
    expect(pathOf('|a|link|name with | in it|html/body/a')).toBe('html/body/a');
  });
});
