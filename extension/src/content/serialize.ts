/**
 * One line per element, which is what the planner actually reads.
 *
 * ```
 * [4]<input type="text" aria-label="Full name" value="<<PERSON_1>>" />
 * *[9]<button type="submit">Save and continue</button>
 *     <img alt="" ocr="<<PERSON_1>>" redacted="blur" />   // visual-only, no index
 * ```
 *
 * Two rules govern this file:
 *
 *   It renders whatever the value field holds and never looks at `rawValue`. By the
 *   time anything is serialised for the wire, M5 has detected and M6 has substituted;
 *   reaching past that to the raw field would undo both.
 *
 *   An element with no index is rendered indented and unnumbered. The planner can point
 *   at it by coordinate but cannot say "click 7", because there is no 7 to click.
 */

import type { Viewport } from '../shared/contract';
import type { ObservedElement, RedactedText } from '../shared/observed';
import type { DomEl } from './walker';

export interface SerializedSnapshot {
  observed: ObservedElement[];
  /** index -> live DOM element. Stays on the device. */
  handles: Map<number, DomEl>;
  viewport: Viewport;
}

/** What to render for an element's name and value. Substituted text, never raw. */
export type TextFor = (el: ObservedElement) => RedactedText;

/**
 * The default, for the overlay and for tests: render the raw name, and mask any value
 * rather than printing it. Nothing that goes to the server uses this -- M6 passes its
 * own substituted text -- so the safe default is the one that shows no values.
 */
export const maskedText: TextFor = (el) => ({
  name: el.name,
  value: el.rawValue === undefined ? undefined : '***',
});

export function serializeElement(el: ObservedElement, textFor: TextFor = maskedText): string {
  const text = textFor(el);
  const parts: string[] = [];

  if (el.inputType) parts.push(`type="${escapeAttr(el.inputType)}"`);
  if (el.ariaLabel) parts.push(`aria-label="${escapeAttr(text.name)}"`);
  else if (el.placeholder) parts.push(`placeholder="${escapeAttr(el.placeholder)}"`);

  if (el.href) parts.push(`href="${escapeAttr(el.href)}"`);
  if (el.tag === 'img') parts.push(`alt="${escapeAttr(el.alt ?? '')}"`);

  if (el.optionCount !== undefined) parts.push(`options=${el.optionCount}`);
  if (el.selectedText) parts.push(`selected="${escapeAttr(el.selectedText)}"`);

  if (text.value !== undefined) parts.push(`value="${escapeAttr(text.value)}"`);
  if (el.fromPixels) parts.push(`ocr="${escapeAttr(text.name)}"`);

  // State flags the planner acts on, and nothing it does not.
  if (el.state.checked) parts.push('checked');
  if (el.state.expanded) parts.push('expanded');
  if (el.state.required) parts.push('required');
  if (el.state.invalid) parts.push('invalid');
  if (el.state.readonly) parts.push('readonly');
  if (!el.state.enabled) parts.push('disabled');
  if (el.rawValue !== undefined && el.rawValue !== '') parts.push('filled');
  if (el.occluded > 0) parts.push(`occluded=${el.occluded.toFixed(1)}`);
  if (el.frame) parts.push(`frame="${escapeAttr(el.frame)}"`);
  if (el.opaque) parts.push('opaque');

  const attrs = parts.length > 0 ? ` ${parts.join(' ')}` : '';
  const inner = innerText(el, text);
  const body = inner === '' ? ' />' : `>${inner}</${el.tag}>`;
  const marker = el.isNew ? '*' : '';

  if (el.index === undefined) {
    // Visual-only: indented, unnumbered, reachable by coordinate only.
    return `    <${el.tag}${attrs}${body}`;
  }
  return `${marker}[${el.index}]<${el.tag}${attrs}${body}`;
}

export function serializeSnapshot(
  snapshot: Pick<SerializedSnapshot, 'observed'>,
  textFor: TextFor = maskedText,
): string {
  return snapshot.observed.map((el) => serializeElement(el, textFor)).join('\n');
}

/**
 * Text between the tags: only for elements whose name *is* their content. A text
 * field's name comes from its label, and printing it twice would suggest the label is
 * inside the box.
 */
function innerText(el: ObservedElement, text: RedactedText): string {
  if (el.ariaLabel || el.placeholder) return '';
  if (el.tag === 'input' || el.tag === 'img' || el.tag === 'select' || el.tag === 'textarea') {
    return '';
  }
  return escapeText(text.name);
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/\n/g, ' ');
}

function escapeText(value: string): string {
  return value.replace(/\n/g, ' ');
}
