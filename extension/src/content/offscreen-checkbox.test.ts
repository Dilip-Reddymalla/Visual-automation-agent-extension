/**
 * The "css-checkbox" pattern: the real <input> parked off-screen, a styled <label>
 * standing where the box appears. irctc.co.in ships every search option this way, and so
 * do a great many government portals.
 *
 * Boxes measured off irctc.co.in/nget/train-search: the inputs sit at x = -9900.
 */

import { describe, it, expect } from 'vitest';
import { perceive } from './perceive';
import { fixture, page } from './fixture';

const IRCTC = page(`
  <div data-box="60,600,300,90">
    <input type="checkbox" id="concessionBooking" data-box="-9900,623,274,15" />
    <label for="concessionBooking" data-box="60,620,240,18">Person With Disability Concession</label>
    <input type="checkbox" id="dateSpecific" checked data-box="-9900,646,274,15" />
    <label for="dateSpecific" data-box="60,643,240,18">Flexible With Date</label>
  </div>
`);

/** The ordinary case, which must not change: both on screen, only the input indexed. */
const PLAIN = page(`
  <div data-box="60,600,300,40">
    <input type="checkbox" id="terms" data-box="60,610,16,16" />
    <label for="terms" data-box="84,608,200,18">I accept the terms</label>
  </div>
`);

function indexed(html: string) {
  return perceive(fixture(html, { viewport: { w: 1024, h: 768 } }).env).observed.filter(
    (e) => e.index !== undefined,
  );
}

describe('a checkbox whose input is parked off-screen', () => {
  it('is reported through the label that stands in for it', () => {
    const names = indexed(IRCTC).map((e) => `${e.role}:${e.name}`);
    expect(names).toEqual([
      'checkbox:Person With Disability Concession',
      'checkbox:Flexible With Date',
    ]);
  });

  it('reports whether the box is ticked, not whether a label exists', () => {
    const boxes = indexed(IRCTC);
    expect(boxes[0]?.state.checked).toBe(false);
    expect(boxes[1]?.state.checked).toBe(true);
  });

  it('carries the control identity the detectors read', () => {
    expect(indexed(IRCTC)[0]?.idAttr).toBe('concessionBooking');
    expect(indexed(IRCTC)[0]?.inputType).toBe('checkbox');
  });

  it('is clickable where the label is, not where the input is parked', () => {
    expect(indexed(IRCTC)[0]?.box.x).toBe(60);
  });

  /**
   * The rule the proxy pass narrows, not the rule it replaces: clicking a label fires its
   * control too, so indexing both is a double toggle that leaves the box where it started.
   */
  it('leaves an ordinary label out when the control itself can be clicked', () => {
    const entries = indexed(PLAIN);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tag).toBe('input');
  });
});
