/**
 * Finding a field that is not on screen.
 *
 * The failure this covers is the one that made the same instruction on the same page work
 * or not work depending on where the scrollbar was. Two halves, tested separately: the
 * content script's whole-document survey (does it see a control the viewport walk drops?)
 * and the worker's `locate` (does it pick the right one, and does it leave alone the ones
 * the viewport can already reach?).
 */

import { describe, it, expect } from 'vitest';
import { perceive, survey } from '../content/perceive';
import { fixture, page } from '../content/fixture';
import type { ObservedElement } from '../shared/observed';
import { parseGoal } from './intent';
import { locate, describeReveal } from './reveal';

/**
 * A contact form whose First Name sits above the viewport and whose Submit sits below it.
 *
 * The viewport is 1280x720 at the origin, so a box at y=-400 has been scrolled past and one
 * at y=1400 has not been reached. Both are ordinary form controls; neither is reachable by
 * a viewport-bound walk, which is exactly the point.
 */
const SCROLLED_PAST = page(`
  <label for="fname" data-box="10,-400,120,20">First Name</label>
  <input id="fname" data-box="10,-370,300,30" />
  <label for="country" data-box="10,200,120,20">Country</label>
  <select id="country" data-box="10,230,300,30"><option>India</option></select>
  <label for="subject" data-box="10,300,120,20">Subject</label>
  <textarea id="subject" data-box="10,330,300,80"></textarea>
  <button id="send" data-box="10,1400,120,40">Submit</button>
`);

function observedOf(html: string): ObservedElement[] {
  return perceive(fixture(html).env).observed;
}

function surveyedOf(html: string): ObservedElement[] {
  return survey(fixture(html).env).elements;
}

describe('the survey sees the whole document', () => {
  it('finds controls the viewport walk drops', () => {
    const inViewport = observedOf(SCROLLED_PAST).map((e) => e.idAttr);
    const surveyed = surveyedOf(SCROLLED_PAST).map((e) => e.idAttr);

    // The premise. If this ever stops being true the bug is fixed somewhere else and this
    // whole module is dead code.
    expect(inViewport).not.toContain('fname');
    expect(inViewport).not.toContain('send');

    expect(surveyed).toContain('fname');
    expect(surveyed).toContain('send');
    expect(surveyed).toContain('country');
  });

  it('keeps the labels, which is what makes the field findable', () => {
    const fname = surveyedOf(SCROLLED_PAST).find((e) => e.idAttr === 'fname');
    expect(fname?.labelText).toBe('First Name');
  });

  /**
   * Locating is not perceiving. A whole-document sweep of every field's contents is not
   * something finding a label requires, and `rawValue` is the single most sensitive string
   * in the project.
   */
  it('carries no values', () => {
    const filled = page(`
      <label for="pan" data-box="10,-400,120,20">PAN</label>
      <input id="pan" value="ABCDE1234F" data-box="10,-370,300,30" />
    `);
    const found = surveyedOf(filled).find((e) => e.idAttr === 'pan');
    expect(found).toBeDefined();
    expect(found?.rawValue).toBeUndefined();
    expect(found?.state.filled).toBe(false);
    expect(JSON.stringify(surveyedOf(filled))).not.toContain('ABCDE1234F');
  });

  it('carries no text blocks or images — controls only', () => {
    const mixed = page(`
      <p data-box="10,-400,400,40">Some prose that a text block would admit.</p>
      <img src="x.png" alt="a picture" data-box="10,-300,200,200" />
      <input id="only" aria-label="Only" data-box="10,-100,300,30" />
    `);
    expect(surveyedOf(mixed).map((e) => e.idAttr)).toEqual(['only']);
  });

  it('leaves out what the page says is not there', () => {
    const hidden = page(`
      <input id="gone" aria-label="Gone" data-box="10,-400,300,30" />
      <input id="hush" aria-label="Hush" aria-hidden="true" data-box="10,-300,300,30" />
      <input id="off" aria-label="Off" disabled data-box="10,-200,300,30" />
    `);
    const ids = surveyedOf(hidden).map((e) => e.idAttr);
    expect(ids).toContain('gone');
    expect(ids).not.toContain('hush');
    expect(ids).not.toContain('off');
  });

  it('gives every control a stable key to be revealed by', () => {
    const keys = surveyedOf(SCROLLED_PAST).map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => key.length > 0)).toBe(true);
  });
});

describe('locate', () => {
  const inViewport = observedOf(SCROLLED_PAST);
  const surveyed = surveyedOf(SCROLLED_PAST);

  it('finds the field the viewport could not', () => {
    const { intents } = parseGoal('fill first name with leo');
    const targets = locate(intents, inViewport, surveyed);

    expect(targets).toHaveLength(1);
    expect(targets[0]?.intent.target).toBe('first name');
    const fname = surveyed.find((e) => e.idAttr === 'fname');
    expect(targets[0]?.key).toBe(fname?.key);
  });

  /**
   * The rule that stops this becoming a page that scrolls on every step. A field already
   * on screen is already reachable, and scrolling towards it can only move something else
   * out of view.
   */
  it('says nothing about a field the viewport can already reach', () => {
    const { intents } = parseGoal('fill subject with hello');
    expect(locate(intents, inViewport, surveyed)).toEqual([]);
  });

  it('is silent when the page has no such field anywhere', () => {
    const { intents } = parseGoal('fill aadhaar number with 1234 5678 9012');
    expect(locate(intents, inViewport, surveyed)).toEqual([]);
  });

  it('reports one target per unreachable intent', () => {
    const { intents } = parseGoal('fill first name with leo and click submit');
    const targets = locate(intents, inViewport, surveyed);
    expect(targets.map((t) => t.intent.target).sort()).toEqual(['first name', 'submit']);
  });

  it('orders by margin, so the most confident scroll happens first', () => {
    const { intents } = parseGoal('fill first name with leo and click submit');
    const gaps = locate(intents, inViewport, surveyed).map((t) => t.gap);
    expect([...gaps].sort((a, b) => b - a)).toEqual(gaps);
  });

  it('never returns a target with an empty key', () => {
    const { intents } = parseGoal('fill first name with leo and click submit');
    expect(locate(intents, inViewport, surveyed).every((t) => t.key !== '')).toBe(true);
  });
});

describe('describeReveal', () => {
  const inViewport = observedOf(SCROLLED_PAST);
  const surveyed = surveyedOf(SCROLLED_PAST);
  const targets = locate(parseGoal('fill first name with leo').intents, inViewport, surveyed);

  it('says what was scrolled to, by the user’s own name for it', () => {
    expect(describeReveal(targets, ['first name'])).toContain('"first name"');
  });

  it('distinguishes "could not reveal" from "did not need to"', () => {
    expect(describeReveal(targets, [])).toContain('could not be revealed');
    expect(describeReveal([], [])).toBe('');
  });

  it('never carries a value', () => {
    expect(describeReveal(targets, ['first name'])).not.toContain('leo');
  });
});
