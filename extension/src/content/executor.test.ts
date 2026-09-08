import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  execute,
  namesASecret,
  rehydrate,
  setNativeValue,
  StepEndingRejection,
  type ExecutorEnv,
  type ResolveOutcome,
} from './executor';
import type { Action } from '../shared/contract';
import type { DomEl } from './walker';
import { JSDOM } from 'jsdom';

/**
 * The executor is the only part of the system that writes to the page, so the tests
 * that matter here are the ones about what it refuses to write.
 */

const SNAPSHOT = 'doc7.3';

/**
 * A real document, from the same jsdom the perception tests use. The executor takes its
 * realm as an argument precisely so this works without a browser environment.
 */
function makeDoc(): Document {
  return new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true }).window
    .document as unknown as Document;
}

let doc = makeDoc();

function env(over: Partial<ExecutorEnv> = {}): ExecutorEnv {
  return {
    doc,
    handleFor: () => undefined,
    snapshotId: () => SNAPSHOT,
    resolve: async () => ({ ok: false, reason: 'unknown-placeholder' }) as ResolveOutcome,
    window: { scrollBy: vi.fn(), location: { href: '' } as Location },
    sleep: async () => undefined,
    ...over,
  };
}

function field(type = 'text'): HTMLInputElement {
  const el = doc.createElement('input');
  el.type = type;
  doc.body.append(el);
  return el;
}

function typeAction(over: Partial<Extract<Action, { type: 'type' }>> = {}): Action {
  return { type: 'type', index: 4, text: 'hello', submit: false, ...over };
}

beforeEach(() => {
  doc = makeDoc();
});

describe('the snapshot guard', () => {
  it('refuses an action planned against a walk that has been replaced', async () => {
    // The failure this prevents is silent: after a navigation, index [3] was a button
    // and became a text field (demo/NAVIGATION.md). Nothing throws; the wrong element
    // is simply operated.
    const el = field();
    await expect(
      execute(typeAction(), env({ handleFor: () => el }), 'doc7.2'),
    ).rejects.toBeInstanceOf(StepEndingRejection);
  });

  it('names staleness as its reason, so the loop can tell it from a bad plan', async () => {
    await expect(execute({ type: 'click', index: 1 }, env(), 'stale')).rejects.toMatchObject({
      reason: 'stale-snapshot',
    });
  });

  it('checks before touching the page at all', async () => {
    const handleFor = vi.fn(() => undefined);
    await execute({ type: 'click', index: 1 }, env({ handleFor }), 'stale').catch(
      () => undefined,
    );
    expect(handleFor).not.toHaveBeenCalled();
  });
});

describe('secrets', () => {
  it('refuses to type one, however the token is spelled', async () => {
    for (const text of ['«SECRET»', '«SECRET_1»', 'pin is «SECRET» ok']) {
      expect(namesASecret(text)).toBe(true);
    }
  });

  it('does not mistake an ordinary token for one', () => {
    expect(namesASecret('«EMAIL_1»')).toBe(false);
    expect(namesASecret('my secret plan')).toBe(false);
  });

  it('refuses before it looks the element up', async () => {
    // Whether the field exists has no bearing on whether a secret may go into it, and
    // checking the element first would leak that a field is there at all.
    const handleFor = vi.fn(() => undefined);
    const result = await execute(
      typeAction({ text: '«SECRET»' }),
      env({ handleFor }),
      SNAPSHOT,
    );

    expect(result.outcome).toBe('failed');
    expect(result.note).toContain('secret-declined');
    expect(handleFor).not.toHaveBeenCalled();
  });

  it('never asks the allocator to resolve one', async () => {
    const resolve = vi.fn(async () => ({ ok: true, value: 'hunter2' }) as ResolveOutcome);
    await execute(typeAction({ text: '«SECRET»' }), env({ resolve }), SNAPSHOT);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('rehydration', () => {
  it('substitutes every token, once each', async () => {
    const resolve = vi.fn(
      async (t: string) =>
        ({ ok: true, value: t === '«PERSON_1»' ? 'Asha' : 'a@b.in' }) as ResolveOutcome,
    );
    const result = await rehydrate('«PERSON_1» at «EMAIL_1» and «PERSON_1» again', { resolve });

    expect(result).toEqual({ ok: true, text: 'Asha at a@b.in and Asha again' });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('ends the step when the map is gone, and only rejects the action when it is not', async () => {
    // The distinction the whole rehydration path exists to preserve. One is our state
    // loss; the other is the planner inventing a token.
    await expect(
      rehydrate('«PERSON_1»', { resolve: async () => ({ ok: false, reason: 'session-lost' }) }),
    ).rejects.toMatchObject({ reason: 'session-lost' });

    await expect(
      rehydrate('«PERSON_9»', {
        resolve: async () => ({ ok: false, reason: 'unknown-placeholder' }),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'unknown-placeholder' });
  });

  it('leaves text with no tokens alone without asking anyone', async () => {
    const resolve = vi.fn();
    const result = await rehydrate('just words', { resolve });
    expect(result).toEqual({ ok: true, text: 'just words' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('never types a token it could not resolve', async () => {
    const el = field();
    const result = await execute(
      typeAction({ text: '«PERSON_9»' }),
      env({
        handleFor: () => el,
        resolve: async () => ({ ok: false, reason: 'unknown-placeholder' }),
      }),
      SNAPSHOT,
    );

    expect(result.outcome).toBe('failed');
    expect(el.value).toBe('');
  });
});

describe('typing', () => {
  it('sets the value the way a framework notices', async () => {
    const el = field();
    const seen: string[] = [];
    el.addEventListener('input', () => seen.push('input'));
    el.addEventListener('change', () => seen.push('change'));

    setNativeValue(el, 'typed');

    expect(el.value).toBe('typed');
    expect(seen).toEqual(['input', 'change']);
  });

  it('goes through the prototype setter, not the instance property', () => {
    // The React trap: a component shadows `value` on the instance, so writing the
    // property is swallowed and the app never hears about the change.
    const el = field();
    const shadow = vi.fn();
    Object.defineProperty(el, 'value', { set: shadow, get: () => '', configurable: true });

    setNativeValue(el, 'typed');
    expect(shadow).not.toHaveBeenCalled();
  });

  it('logs the token it used and never what the token stood for', async () => {
    const el = field();
    const result = await execute(
      typeAction({ text: '«EMAIL_1»' }),
      env({
        handleFor: () => el,
        resolve: async () => ({ ok: true, value: 'asha@example.in' }),
      }),
      SNAPSHOT,
    );

    expect(el.value).toBe('asha@example.in');
    expect(result.note).toContain('«EMAIL_1»');
    expect(result.note).not.toContain('asha@example.in');
  });

  it('refuses a target that is not a text field', async () => {
    const div = doc.createElement('div');
    const result = await execute(
      typeAction(),
      env({ handleFor: () => div as DomEl }),
      SNAPSHOT,
    );
    expect(result.outcome).toBe('failed');
  });
});

describe('select', () => {
  it('drives a real one', async () => {
    const el = doc.createElement('select');
    for (const text of ['One', 'Two']) {
      const option = doc.createElement('option');
      option.value = text.toLowerCase();
      option.text = text;
      el.append(option);
    }

    const result = await execute(
      { type: 'select', index: 2, option: 'Two' },
      env({ handleFor: () => el }),
      SNAPSHOT,
    );

    expect(result.outcome).toBe('ok');
    expect(el.value).toBe('two');
  });

  it('will not shortcut a custom listbox', async () => {
    // Demo page B's dropdown: a div with role="combobox" whose options do not exist
    // until it is opened. Matching its text from here would be a way around the
    // perception layer rather than a use of it, so `select` declines and the planner
    // has to click, settle, look again, click.
    const div = doc.createElement('div');
    div.setAttribute('role', 'combobox');

    const result = await execute(
      { type: 'select', index: 6, option: 'Post-Matric Scholarship' },
      env({ handleFor: () => div as DomEl }),
      SNAPSHOT,
    );

    expect(result.outcome).toBe('failed');
    expect(result.note).toContain('not a native <select>');
  });
});

describe('the actions the page does not own', () => {
  it('reports ask and finish as no-ops rather than failures', async () => {
    // They are the worker's to answer. Calling them failures would put them in the
    // history as something the page refused, which is not what happened.
    for (const action of [
      { type: 'ask', question: 'what is the PIN?' },
      { type: 'finish', status: 'success', summary: 'done' },
    ] as Action[]) {
      const result = await execute(action, env(), SNAPSHOT);
      expect(result.outcome).toBe('no-op');
    }
  });
});

describe('choosing from a dropdown', () => {
  /**
   * Exact-and-case-sensitive was the whole matcher, and it failed the first real dropdown it
   * met. The user typed "telangana"; the option reads "Telangana" and its value is "tg", so
   * nothing matched and the step reported `not done` on a field it had resolved perfectly.
   * A person choosing from a list does not match its capitalisation.
   */
  function states(): HTMLSelectElement {
    const select = doc.createElement('select');
    select.innerHTML =
      '<option value="">SELECT STATE</option>' +
      '<option value="ka">Karnataka</option>' +
      '<option value="tg">Telangana</option>';
    doc.body.append(select);
    return select;
  }

  async function choose(option: string): Promise<[string, HTMLSelectElement]> {
    const select = states();
    const result = await execute(
      { type: 'select', index: 1, option },
      env({ handleFor: () => select as unknown as DomEl }),
      SNAPSHOT,
    );
    return [result.outcome, select];
  }

  it('matches the option however the user capitalised it', async () => {
    for (const asked of ['Telangana', 'telangana', ' TELANGANA ']) {
      const [outcome, select] = await choose(asked);
      expect(outcome, asked).toBe('ok');
      expect(select.value, asked).toBe('tg');
    }
  });

  it('matches on the option value too, which is what a planner emits', async () => {
    const [outcome, select] = await choose('ka');
    expect(outcome).toBe('ok');
    expect(select.value).toBe('ka');
  });

  /**
   * The real list from parivahan, five of whose options end in "Pradesh". "Select state as
   * andra pradesh" resolved to the right dropdown on the right page and then matched
   * nothing, because the option reads "Andhra Pradesh" and the user left out the h.
   */
  function indianStates(): HTMLSelectElement {
    const select = doc.createElement('select');
    select.innerHTML = [
      ['-1', 'Select State'],
      ['AN', 'Andaman and Nicobar'],
      ['AP', 'Andhra Pradesh'],
      ['AR', 'Arunachal Pradesh'],
      ['AS', 'Assam'],
      ['HP', 'Himachal Pradesh'],
      ['MP', 'Madhya Pradesh'],
      ['TG', 'Telangana'],
      ['UP', 'Uttar Pradesh'],
    ]
      .map(([v, t]) => `<option value="${v}">${t}</option>`)
      .join('');
    doc.body.append(select);
    return select;
  }

  async function chooseState(option: string): Promise<[string, HTMLSelectElement]> {
    const select = indianStates();
    const result = await execute(
      { type: 'select', index: 1, option },
      env({ handleFor: () => select as unknown as DomEl }),
      SNAPSHOT,
    );
    return [result.outcome, select];
  }

  it('gets past a typo the page does not have', async () => {
    const [outcome, select] = await chooseState('andra pradesh');
    expect(outcome).toBe('ok');
    expect(select.value).toBe('AP');
  });

  it('picks the right Pradesh out of five', async () => {
    for (const [asked, expected] of [
      ['andhra pradesh', 'AP'],
      ['arunachal pradesh', 'AR'],
      ['himachal pradesh', 'HP'],
      ['madhya pradesh', 'MP'],
      ['uttar pradesh', 'UP'],
    ] as const) {
      const [outcome, select] = await chooseState(asked);
      expect(outcome, asked).toBe('ok');
      expect(select.value, asked).toBe(expected);
    }
  });

  /**
   * The margin, which is the same idea as the resolver's `CLEAR_MARGIN`. "pradesh" alone is
   * equally close to five options, and picking one of five would be a coin toss with a
   * confident tone of voice.
   */
  it('refuses when the answer is a coin toss', async () => {
    const [outcome, select] = await chooseState('pradesh');
    expect(outcome).toBe('failed');
    expect(select.value).toBe('-1');
  });

  it('refuses a state that is not on the list at all', async () => {
    const [outcome, select] = await chooseState('California');
    expect(outcome).toBe('failed');
    expect(select.value).toBe('-1');
  });

  it('does not settle for the empty placeholder option', async () => {
    const [outcome, select] = await choose('Gujarat');
    expect(outcome).toBe('failed');
    expect(select.value).toBe('');
  });
});
