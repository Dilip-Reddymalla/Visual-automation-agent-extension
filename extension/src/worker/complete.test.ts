/**
 * The completion check.
 *
 * Every test here is a shape of "reported done while something was outstanding", because
 * that is the only failure this module exists to catch.
 */

import { describe, it, expect } from 'vitest';
import { assessCompletion, describeCompletion } from './complete';
import type { Intent } from './intent';

const fill = (target: string): Intent => ({ verb: 'fill', target, value: 'x' });

describe('assessCompletion', () => {
  it('is complete when every field was re-read and held what it was given', () => {
    const result = assessCompletion({
      intents: [fill('first name'), fill('last name')],
      residue: [],
      fulfilments: [
        { target: 'first name', verb: 'fill', reason: 'match' },
        { target: 'last name', verb: 'fill', reason: 'match' },
      ],
      sent: false,
    });
    expect(result).toEqual({ complete: true, outstanding: [] });
    expect(describeCompletion(result)).toBe('');
  });

  it('is not complete when a field is still empty', () => {
    const result = assessCompletion({
      intents: [fill('subject')],
      residue: [],
      fulfilments: [{ target: 'subject', verb: 'fill', reason: 'empty' }],
      sent: true,
    });
    expect(result.complete).toBe(false);
    expect(result.outstanding).toEqual(['"subject" is still empty']);
  });

  it('is not complete when the field holds something else', () => {
    const result = assessCompletion({
      intents: [fill('last name')],
      residue: [],
      fulfilments: [{ target: 'last name', verb: 'fill', reason: 'differs' }],
      sent: true,
    });
    expect(result.complete).toBe(false);
    expect(result.outstanding[0]).toContain('holds something else');
  });

  /**
   * The exact bug. Two fields asked for, one acted on, and the second producing no verdict
   * because no action was ever built for it. Everything the agent could see said `ok`.
   */
  it('catches the intent that was never acted on at all', () => {
    const result = assessCompletion({
      intents: [fill('last name'), fill('subject')],
      residue: [],
      fulfilments: [{ target: 'last name', verb: 'fill', reason: 'match' }],
      sent: false,
    });
    expect(result.complete).toBe(false);
    expect(result.outstanding).toEqual(['"subject" was never acted on']);
  });

  /**
   * An `as` sentence carries two readings, and `chooseTier` acts on whichever one the page
   * recognises. "Enter DL Number as 10001000193" is resolved as target "dl number" while the
   * intent on the state record still names "10001000193" -- so comparing only the primary
   * reported that the agent had never acted on a field it had just filled.
   */
  it('accepts the reading the page settled on', () => {
    const result = assessCompletion({
      intents: [
        {
          verb: 'fill',
          target: '10001000193',
          value: 'DL Number',
          alt: { target: 'dl number', value: '10001000193' },
        },
      ],
      residue: [],
      fulfilments: [{ target: 'dl number', verb: 'fill', reason: 'match' }],
      sent: false,
    });
    expect(result).toEqual({ complete: true, outstanding: [] });
  });

  it('treats "could not check" as not done, in both its forms', () => {
    for (const reason of ['missing', 'unresolved'] as const) {
      const result = assessCompletion({
        intents: [fill('email')],
        residue: [],
        fulfilments: [{ target: 'email', verb: 'fill', reason }],
        sent: false,
      });
      expect(result.complete).toBe(false);
    }
  });

  it('does not hold a click against the check', () => {
    const result = assessCompletion({
      intents: [{ verb: 'click', target: 'submit' }],
      residue: [],
      fulfilments: [{ target: 'submit', verb: 'click', reason: 'not-applicable' }],
      sent: false,
    });
    expect(result.complete).toBe(true);
  });

  describe('residue', () => {
    it('is outstanding when nothing that reads free text ever saw it', () => {
      const result = assessCompletion({
        intents: [fill('last name')],
        residue: ['subject as Write Something'],
        fulfilments: [{ target: 'last name', verb: 'fill', reason: 'match' }],
        sent: false,
      });
      expect(result.complete).toBe(false);
      expect(result.outstanding[0]).toContain('subject as Write Something');
    });

    it('is accounted for once the local reader has read the goal', () => {
      const result = assessCompletion({
        intents: [fill('last name')],
        residue: ['Leo A', 'Australia'],
        fulfilments: [{ target: 'last name', verb: 'fill', reason: 'match' }],
        sent: false,
        readLocally: true,
      });
      expect(result.complete).toBe(true);
    });

    it('is accounted for once the goal has been sent to a planner', () => {
      const result = assessCompletion({
        intents: [fill('last name')],
        residue: ['subject as Write Something'],
        fulfilments: [{ target: 'last name', verb: 'fill', reason: 'match' }],
        sent: true,
      });
      expect(result.complete).toBe(true);
    });
  });

  it('reports every outstanding item, not the first one', () => {
    const result = assessCompletion({
      intents: [fill('first name'), fill('last name'), fill('subject')],
      residue: ['and something else'],
      fulfilments: [
        { target: 'first name', verb: 'fill', reason: 'empty' },
        { target: 'last name', verb: 'fill', reason: 'differs' },
      ],
      sent: false,
    });
    expect(result.outstanding).toHaveLength(4);
    expect(describeCompletion(result)).toMatch(/^not done: /);
  });

  it('never puts a value in the summary', () => {
    const result = assessCompletion({
      intents: [{ verb: 'fill', target: 'last name', value: 'Leo' }],
      residue: [],
      fulfilments: [{ target: 'last name', verb: 'fill', reason: 'empty' }],
      sent: false,
    });
    expect(describeCompletion(result)).not.toContain('Leo');
  });
});
