import { describe, expect, it } from 'vitest';
import { geometryMatches, tokensMatch, type GeometryToken } from './frames';


/**
 * The two questions a capture asks of the page, and why they are different questions.
 *
 * Measured on live government portals: indianrail.gov.in drifted `mutationSeq 8 -> 48`
 * and incometax.gov.in `7 -> 35` between measuring the geometry and photographing it,
 * with every geometric field identical. A rotating banner bumps that counter thirty times
 * a second and moves nothing. `tokensMatch` discarded every frame on both, for ever, and
 * the agent could not see either site at all.
 */
describe('geometryMatches', () => {
  const still: GeometryToken = {
    scrollX: 0,
    scrollY: 240,
    vvOffsetX: 0,
    vvOffsetY: 0,
    vvScale: 1,
    dpr: 2,
    mutationSeq: 8,
    docHeight: 4200,
  };

  it('ignores a DOM that changed without moving anything', () => {
    const mutated = { ...still, mutationSeq: 48 };
    expect(tokensMatch(still, mutated)).toBe(false);
    expect(geometryMatches(still, mutated)).toBe(true);
  });

  it.each([
    ['scrollY', { scrollY: 260 }],
    ['scrollX', { scrollX: 12 }],
    ['docHeight', { docHeight: 4600 }],
    ['vvScale', { vvScale: 1.5 }],
    ['vvOffsetX', { vvOffsetX: 30 }],
    ['vvOffsetY', { vvOffsetY: 30 }],
    ['dpr', { dpr: 1 }],
  ])('still refuses when %s moved', (_name, change) => {
    // Everything that positions a box is still a hard failure. This is the invariant the
    // guard exists for: a redaction landing next to the value instead of on it.
    const moved = { ...still, ...change };
    expect(geometryMatches(still, moved)).toBe(false);
    expect(tokensMatch(still, moved)).toBe(false);
  });

  it('refuses when the page both mutated and moved', () => {
    expect(geometryMatches(still, { ...still, mutationSeq: 48, scrollY: 260 })).toBe(false);
  });

  it('agrees with the strict check on a page that held completely still', () => {
    expect(geometryMatches(still, { ...still })).toBe(true);
    expect(tokensMatch(still, { ...still })).toBe(true);
  });
});
