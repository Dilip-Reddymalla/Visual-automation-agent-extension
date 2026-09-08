import { describe, it, expect } from 'vitest';
import { assessCompletion, describeCompletion } from './complete';
import type { Intent } from './intent';
import type { Fulfilment } from './complete';

describe('Agent Action Verification & State Transitions', () => {
  const intentName: Intent = { target: 'first name', verb: 'fill' };
  const intentState: Intent = { target: 'state', verb: 'select' };
  const intentSubmit: Intent = { target: 'submit', verb: 'click' };

  it('1. successful action with verified state change', () => {
    const fulfilments: Fulfilment[] = [
      { target: 'first name', verb: 'fill', reason: 'match' },
      { target: 'state', verb: 'select', reason: 'match' },
    ];
    const result = assessCompletion({
      intents: [intentName, intentState],
      residue: [],
      fulfilments,
      sent: false,
    });
    expect(result.complete).toBe(true);
    expect(result.outstanding).toHaveLength(0);
  });

  it('2. executor succeeds but intended state change does not occur', () => {
    // Executor returned outcome: 'ok', but verification read element and found empty or differs
    const fulfilments: Fulfilment[] = [
      { target: 'first name', verb: 'fill', reason: 'empty' },
      { target: 'state', verb: 'select', reason: 'differs' },
    ];
    const result = assessCompletion({
      intents: [intentName, intentState],
      residue: [],
      fulfilments,
      sent: false,
    });
    expect(result.complete).toBe(false);
    expect(result.outstanding).toContain('"first name" is still empty');
    expect(result.outstanding).toContain('"state" holds something else');
  });

  it('3. navigation/state transition after click', () => {
    // Verified click (state changed or navigation occurred -> not-applicable)
    const validClick: Fulfilment = {
      target: 'submit',
      verb: 'click',
      reason: 'not-applicable',
    };
    const validResult = assessCompletion({
      intents: [intentSubmit],
      residue: [],
      fulfilments: [validClick],
      sent: false,
    });
    expect(validResult.complete).toBe(true);

    // Unverified / no-state-change click -> not-done
    const failedClick: Fulfilment = { target: 'submit', verb: 'click', reason: 'not-done' };
    const failedResult = assessCompletion({
      intents: [intentSubmit],
      residue: [],
      fulfilments: [failedClick],
      sent: false,
    });
    expect(failedResult.complete).toBe(false);
    expect(failedResult.outstanding).toContain('"submit" was not carried out');
  });

  it('4. typing verification without leaking sensitive values', () => {
    const sensitiveFulfilment: Fulfilment = {
      target: 'Aadhaar Number',
      verb: 'fill',
      reason: 'differs',
    };
    const result = assessCompletion({
      intents: [{ target: 'Aadhaar Number', verb: 'fill' }],
      residue: [],
      fulfilments: [sensitiveFulfilment],
      sent: false,
    });
    const summary = describeCompletion(result);
    // Verified summary contains target name & reason, never raw values
    expect(summary).toBe('not done: "Aadhaar Number" holds something else');
    expect(summary).not.toMatch(/\d{12}/); // No 12-digit numbers
  });

  it('5. no-visible-change action handled explicitly', () => {
    // Actions like wait, scroll, key carry no field target in fulfilments
    const result = assessCompletion({
      intents: [],
      residue: [],
      fulfilments: [],
      sent: true,
    });
    expect(result.complete).toBe(true);
    expect(describeCompletion(result)).toBe('');
  });

  it('6. failed verification produces a structured loop outcome', () => {
    const unfulfilled: Fulfilment = {
      target: 'email',
      verb: 'fill',
      reason: 'missing',
    };
    const result = assessCompletion({
      intents: [{ target: 'email', verb: 'fill' }],
      residue: [],
      fulfilments: [unfulfilled],
      sent: false,
    });
    expect(result.complete).toBe(false);
    expect(result.outstanding).toContain('"email" is no longer on the page');
    expect(describeCompletion(result)).toBe('not done: "email" is no longer on the page');
  });

  it('7. existing successful behavior remains unchanged', () => {
    const result = assessCompletion({
      intents: [intentName],
      residue: [],
      fulfilments: [{ target: 'first name', verb: 'fill', reason: 'match' }],
      sent: false,
    });
    expect(result.complete).toBe(true);
    expect(describeCompletion(result)).toBe('');
  });
});
