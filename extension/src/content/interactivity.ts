/**
 * Is this element something an agent can act on, and what should we call it?
 *
 * The DOM is authoritative (CLAUDE.md invariant 9): role comes from ARIA, then the tag,
 * then behaviour -- never from pixels. The heuristics are the ones browser-use arrived
 * at, ported as ideas rather than code; it drives Chrome over CDP from outside, and a
 * content script has better access to computed style than that approach ever gets.
 *
 * Computed style arrives as an argument. That is not only for testing: reading
 * getComputedStyle inside the walk forces a layout flush per element, and on a large
 * page that is the difference between a 40 ms walk and a 400 ms one.
 */

import type { ElementRole, ElementState } from '../shared/contract';
import { SKIP_TAGS, type DomEl, type RawNode } from './walker';

/** The subset of computed style this module needs. */
export interface StyleLike {
  display: string;
  visibility: string;
  opacity: string;
  cursor: string;
  /** -webkit-text-security; a field styled as dots is a password field in disguise. */
  textSecurity?: string;
}

export interface Verdict {
  interactive: boolean;
  /** Which rule fired. Kept for the overlay and for debugging a missed element. */
  reason: string;
}

const INTERACTIVE_TAGS = new Set([
  'A',
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'SUMMARY',
  'OPTION',
  'LABEL',
  'VIDEO',
  'AUDIO',
]);

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'combobox',
  'textbox',
  'menuitem',
  'tab',
  'switch',
  'slider',
]);

/** Framework click bindings that never show up as an onclick attribute. */
const BINDING_ATTRS = ['onclick', '@click', 'v-on:click', 'ng-click', 'data-action'];

const SEARCH_HINTS = ['search', 'magnify', 'lookup', 'query'];

/** Below this, an element is decoration. Above it, the user can see it. */
export const MIN_OPACITY = 0.05;

/** An iframe smaller than this is a tracking pixel, not a document. */
export const MIN_IFRAME_SIDE = 100;

/** ARIA attributes worth keeping even on a hidden element: an error about to appear. */
const VALIDATION_ATTRS = ['aria-invalid', 'aria-errormessage', 'aria-live', 'role'];

/**
 * Painted at all? Whether it is *on screen* is a separate question, answered by the
 * viewport test in perceive.ts -- an element scrolled out of view is still visible in
 * this sense, and treating the two as one thing loses the distinction between "hidden"
 * and "further down the page".
 */
export function isVisible(node: RawNode, style: StyleLike): boolean {
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (Number.parseFloat(style.opacity || '1') < MIN_OPACITY) return false;
  return node.box.w > 0 && node.box.h > 0;
}

/**
 * An element with validation semantics is kept even when it is currently hidden. The
 * error message that is about to appear is exactly what the planner needs to see next
 * step, and a snapshot that drops it makes the agent retry a form it has already filled.
 */
export function isValidationRelevant(el: DomEl): boolean {
  if (el.getAttribute('role') === 'alert' || el.getAttribute('role') === 'status') return true;
  return VALIDATION_ATTRS.some((attr) => {
    const value = el.getAttribute(attr);
    return attr === 'role' ? false : value !== null && value !== 'false';
  });
}

/** React puts its props on the node under a hashed key. Nothing else does. */
function hasReactHandler(el: DomEl): boolean {
  for (const key of Object.keys(el)) {
    if (key.startsWith('__reactProps$')) {
      const props = (el as unknown as Record<string, unknown>)[key];
      if (props && typeof props === 'object' && 'onClick' in props) return true;
    }
  }
  return false;
}

/**
 * Component libraries wrap a real control in a styled label or span. The wrapper is
 * what the user clicks, so the wrapper is what we index -- but only when the control is
 * close enough that the two are really one widget.
 */
function wrapsFormControl(el: DomEl): boolean {
  // LABEL and SPAN only. DIV is where this rule goes wrong: a form's ordinary
  // `<div class="field">` wrapper contains an input within two levels, so every one of
  // them scores as interactive -- and then swallows the real input during the
  // containment collapse, because the wrapper's accessible name is the label text and
  // therefore identical to the input's. The measured result was a snapshot of div
  // wrappers with the fields themselves missing.
  if (el.tagName !== 'LABEL' && el.tagName !== 'SPAN') return false;
  const control = el.querySelector('input, select, textarea');
  if (!control) return false;

  let depth = 0;
  let node: DomEl | null = control.parentElement;
  while (node && node !== el && depth <= 2) {
    depth += 1;
    node = node.parentElement;
  }
  return node === el && depth <= 2;
}

/**
 * A <label for="x"> forwards its activation to x. Indexing both means the agent can
 * click the label, which fires the input as well -- a double toggle that leaves a
 * checkbox exactly where it started.
 */
export function isLabelProxy(el: DomEl): boolean {
  if (el.tagName !== 'LABEL') return false;
  return el.hasAttribute('for');
}

function hasSearchHint(el: DomEl): boolean {
  const haystack = `${el.className} ${el.id}`.toLowerCase();
  return SEARCH_HINTS.some((hint) => haystack.includes(hint));
}

/**
 * `cursor` inherits. A card styled `cursor: pointer` gives every heading, paragraph and
 * span inside it a computed cursor of `pointer` too, and scoring on that alone turns
 * one clickable card into six entries -- which is exactly what it did on the demo page
 * before this argument existed. So the cursor counts as a signal only where it starts:
 * an element whose parent already has it is inheriting, not declaring.
 */
export function scoreInteractivity(
  el: DomEl,
  style: StyleLike,
  box = { w: 0, h: 0 },
  parentCursor?: string,
): Verdict {
  if (isLabelProxy(el)) return { interactive: false, reason: 'label-proxy' };
  if (el.hasAttribute('disabled')) return { interactive: false, reason: 'disabled' };
  if (el.getAttribute('aria-hidden') === 'true')
    return { interactive: false, reason: 'aria-hidden' };

  if (INTERACTIVE_TAGS.has(el.tagName))
    return { interactive: true, reason: `tag:${el.tagName.toLowerCase()}` };

  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) return { interactive: true, reason: `role:${role}` };

  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number.parseInt(tabindex, 10) >= 0) {
    return { interactive: true, reason: 'tabindex' };
  }

  const editable = el.getAttribute('contenteditable');
  if (editable !== null && editable !== 'false')
    return { interactive: true, reason: 'contenteditable' };

  for (const attr of BINDING_ATTRS) {
    if (el.hasAttribute(attr)) return { interactive: true, reason: `binding:${attr}` };
  }
  if (hasReactHandler(el)) return { interactive: true, reason: 'react-props' };

  if (style.cursor === 'pointer' && parentCursor !== 'pointer') {
    return { interactive: true, reason: 'cursor-pointer' };
  }

  if (wrapsFormControl(el)) return { interactive: true, reason: 'wraps-control' };

  if (el.tagName === 'IFRAME' && box.w >= MIN_IFRAME_SIDE && box.h >= MIN_IFRAME_SIDE) {
    return { interactive: true, reason: 'iframe' };
  }

  if (hasSearchHint(el)) return { interactive: true, reason: 'search-affordance' };

  return { interactive: false, reason: 'none' };
}

export function roleOf(el: DomEl): ElementRole {
  const aria = el.getAttribute('role');
  if (aria) {
    const mapped = ariaToRole(aria);
    if (mapped) return mapped;
  }

  // A label wrapping a single checkbox or radio is that control as far as the user is
  // concerned -- it is what they click -- so it should say so rather than 'other'.
  if (el.tagName === 'LABEL' || el.tagName === 'SPAN') {
    const only = el.querySelectorAll('input');
    const control = only.length === 1 ? (only[0] as HTMLInputElement) : null;
    const type = control?.getAttribute('type')?.toLowerCase();
    if (type === 'checkbox' || type === 'radio') return type;
  }

  switch (el.tagName) {
    case 'A':
      return el.hasAttribute('href') ? 'link' : 'other';
    case 'BUTTON':
    case 'SUMMARY':
      return 'button';
    case 'SELECT':
      return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
    case 'OPTION':
      return 'option';
    case 'TEXTAREA':
      return 'textbox';
    case 'IMG':
      return 'image';
    case 'CANVAS':
      return 'canvas';
    case 'VIDEO':
      return 'video';
    case 'IFRAME':
      return 'iframe';
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return 'heading';
    case 'INPUT':
      return inputRole(el as HTMLInputElement);
    default:
      return 'other';
  }
}

function ariaToRole(aria: string): ElementRole | null {
  const table: Record<string, ElementRole> = {
    button: 'button',
    link: 'link',
    textbox: 'textbox',
    searchbox: 'searchbox',
    combobox: 'combobox',
    listbox: 'listbox',
    option: 'option',
    checkbox: 'checkbox',
    radio: 'radio',
    slider: 'slider',
    spinbutton: 'spinbutton',
    switch: 'switch',
    tab: 'tab',
    menuitem: 'menuitem',
    heading: 'heading',
    img: 'image',
    alert: 'text',
    status: 'text',
  };
  return table[aria] ?? null;
}

function inputRole(el: HTMLInputElement): ElementRole {
  switch (el.getAttribute('type')?.toLowerCase()) {
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'range':
      return 'slider';
    case 'number':
      return 'spinbutton';
    case 'search':
      return 'searchbox';
    case 'file':
      return 'file';
    case 'button':
    case 'submit':
    case 'reset':
    case 'image':
      return 'button';
    default:
      return 'textbox';
  }
}

/**
 * The text a human actually reads inside an element.
 *
 * `textContent` is the obvious thing to call and it is wrong: it concatenates every text
 * node in the subtree, including the ones the browser never renders. Measured on
 * www.amazon.in, the container holding the search bar named itself
 * `window.navmet.tmp=+new Date(); All Select the department...` -- an inline analytics
 * `<script>` two levels down, handed to the planner as an accessible name and, worse,
 * carried into the redaction detectors as page text.
 *
 * The walk already refuses to descend into those tags. This is the same list applied to
 * text, which is the only other place a subtree's contents are read.
 */
export function visibleText(el: DomEl): string {
  let text = '';
  // Node.TEXT_NODE / Node.ELEMENT_NODE, written out: this module is deliberately usable
  // against a document from another realm, where the `Node` global is not this one.
  for (const child of el.childNodes) {
    if (child.nodeType === 3) text += child.nodeValue ?? '';
    else if (child.nodeType === 1) {
      const element = child as DomEl;
      if (SKIP_TAGS.has(element.tagName)) continue;
      text += visibleText(element);
    }
  }
  return text;
}

/**
 * Accessible name, in the order the ARIA spec resolves it: aria-labelledby, aria-label,
 * the associated label, placeholder, title, then text content. The alt text of an image
 * button counts; the value of a text field does not.
 */
export function accessibleName(el: DomEl): string {
  const labelledBy = resolveIdRefs(el, 'aria-labelledby');
  if (labelledBy) return labelledBy;

  const ariaLabel = el.getAttribute('aria-label')?.trim();
  if (ariaLabel) return ariaLabel;

  const label = associatedLabelText(el);
  if (label) return label;

  const placeholder = el.getAttribute('placeholder')?.trim();
  if (placeholder) return placeholder;

  const alt = el.getAttribute('alt')?.trim();
  if (alt) return alt;

  const title = el.getAttribute('title')?.trim();
  if (title) return title;

  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).getAttribute('type')?.toLowerCase();
    // A submit button's name is its value; a text field's value is not its name.
    if (type === 'submit' || type === 'button' || type === 'reset') {
      const value = (el as HTMLInputElement).getAttribute('value')?.trim();
      if (value) return value;
    }
    return '';
  }

  if (el.tagName === 'VIDEO') {
    const text = normaliseSpace(visibleText(el)).slice(0, 120);
    return text || 'video player';
  }

  if (el.tagName === 'AUDIO') {
    const text = normaliseSpace(visibleText(el)).slice(0, 120);
    return text || 'audio player';
  }

  return normaliseSpace(visibleText(el)).slice(0, 120);
}

export function associatedLabelText(el: DomEl): string {
  const doc = el.ownerDocument;
  if (!doc) return '';

  if (el.id) {
    const explicit = doc.querySelector(`label[for="${cssEscape(el.id)}"]`);
    if (explicit) return normaliseSpace(visibleText(explicit));
  }

  const wrapping = el.closest?.('label');
  if (wrapping) return normaliseSpace(visibleText(wrapping));

  // Definition lists and table rows carry the same label -> value association a
  // <label>/<input> pair does, and on a read-only page they are the only one available.
  // "Aadhaar number" beside twelve digits is the highest-precision signal L0 can get
  // there, and without this it never sees it.
  // The association belongs to the cell, but the value is often wrapped one level
  // deeper -- <dd><span>26/09/1968</span></dd> is the ordinary shape of a read-only
  // portal. Looking only at the element itself found the <dd> and missed every <span>
  // inside one, which was 61 of the corpus's misses.
  const cell = el.closest?.('dd, td');
  const target = cell ?? el;
  const tag = target.tagName;

  if (tag === 'DD') {
    const el = target;
    // The nearest preceding <dt>. Several <dd>s may share one <dt>, which is why this
    // walks back rather than looking only at the immediate sibling.
    let sibling = el.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === 'DT') return normaliseSpace(visibleText(sibling));
      if (sibling.tagName !== 'DD') break;
      sibling = sibling.previousElementSibling;
    }
  }

  if (tag === 'TD') {
    const el = target;
    // A row header first -- <th scope="row"> is the label in a two-column layout. Then
    // the column header at the same index, which is the label in a tabular one.
    const row = el.parentElement;
    if (row) {
      const rowHeader = row.querySelector(':scope > th');
      if (rowHeader) return normaliseSpace(visibleText(rowHeader));

      const cells = [...row.children];
      const column = cells.indexOf(el);

      // The two-column key/value table, which is how most read-only portals lay out a
      // record: <td class="k">Account number</td><td class="v">50100…</td>. There is no
      // <th> anywhere in it -- the markup is a table because the layout is tabular, not
      // because the first column is a header -- so the association is positional and the
      // first cell is the label for the second.
      if (cells.length === 2 && column === 1) {
        return normaliseSpace(cells[0] ? visibleText(cells[0]) : '');
      }
      const table = el.closest?.('table');
      const headerRow = table?.querySelector('thead tr, tr:has(> th)');
      const header = headerRow?.children[column];
      if (header && header.tagName === 'TH') {
        return normaliseSpace(visibleText(header));
      }
    }
  }

  return '';
}

/**
 * The caption a human reads as this field's name, when the page never said so.
 *
 * ## Why this exists
 *
 * The w3schools contact form -- the page this project keeps being tested on -- labels its
 * Subject box like this:
 *
 *     <label>Subject</label>
 *     <textarea name="subject" placeholder="Write something.."></textarea>
 *
 * except that the real markup has no `name` either. The `<label>` has no `for`, does not
 * wrap the control, and carries no `id` to point at. So `associatedLabelText` correctly
 * returns nothing, the control's only text is its placeholder, and "enter the subject with
 * random" scored below the floor against a page that visibly has a box labelled Subject.
 * That is not a bug in the resolver; it is a page that never told anyone which box the
 * caption belongs to. A person reads the association off the layout, and so does this.
 *
 * ## Why it is kept apart from `labelText`
 *
 * Because it is a guess and the other is not. A declared label is a statement by the site
 * author; this is an inference from document order, and L0's high-confidence rules --
 * "a field labelled Aadhaar holds an Aadhaar number" -- must not be founded on a guess.
 * So it lands in its own field, `nearbyText`, which the *resolver* reads when the user
 * names a field and the detection layers do not.
 *
 * ## The guards, which are the whole design
 *
 * Walking backwards through siblings will happily find a paragraph of prose and call it a
 * label. Three rules stop that:
 *
 *   - stop at another form control. Text before it belongs to that control, not this one;
 *   - stop after a few siblings. A caption is adjacent, not eventually preceding;
 *   - take only short text. A label is a few words; anything longer is prose that happens
 *     to be above a field.
 */
const NEARBY_SIBLINGS = 3;
const NEARBY_MAX_CHARS = 60;
const CONTROL_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']);

export function nearbyLabelText(el: DomEl): string {
  // The control is often wrapped -- <div class="field"><label>..</label><input></div> --
  // so the search starts at the control and, failing that, at its wrapper.
  for (const start of [el, el.parentElement]) {
    if (!start) continue;
    const found = precedingCaption(start);
    if (found) return found;
  }
  return '';
}

function precedingCaption(from: DomEl): string {
  let sibling = from.previousElementSibling;

  for (let seen = 0; sibling && seen < NEARBY_SIBLINGS; seen += 1) {
    // Another control's caption is not this one's. Stop rather than skip: skipping is how
    // every field on a form ends up sharing the first label above the lot of them.
    if (CONTROL_TAGS.has(sibling.tagName)) return '';
    if (sibling.querySelector?.('input, textarea, select, button')) return '';

    const text = normaliseSpace(visibleText(sibling));
    if (text && text.length <= NEARBY_MAX_CHARS) return text;
    // Long text is prose, and prose above a field is not its label. Keep looking past an
    // empty spacer, but not past a paragraph.
    if (text) return '';

    sibling = sibling.previousElementSibling;
  }
  return '';
}

export function resolveIdRefs(el: DomEl, attr: string): string {
  const refs = el.getAttribute(attr);
  if (!refs) return '';
  const doc = el.ownerDocument;
  if (!doc) return '';

  return normaliseSpace(
    refs
      .split(/\s+/)
      .map((id) => {
      const target = doc.getElementById(id);
      return target ? visibleText(target) : '';
    })
      .join(' '),
  );
}

export function stateOf(el: DomEl, style?: StyleLike): ElementState {
  const input = el as HTMLInputElement;
  const state: ElementState = {
    visible: style ? style.display !== 'none' && style.visibility !== 'hidden' : true,
    enabled: !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true',
    focused: el.ownerDocument?.activeElement === el,
    // perceive.ts sets this once it has read the value; false until then.
    filled: false,
  };

  const ariaChecked = el.getAttribute('aria-checked');
  if (ariaChecked !== null) state.checked = ariaChecked === 'true';
  else if (el.tagName === 'INPUT' && (input.type === 'checkbox' || input.type === 'radio')) {
    state.checked = input.checked;
  }

  const expanded = el.getAttribute('aria-expanded');
  if (expanded !== null) state.expanded = expanded === 'true';

  if (el.hasAttribute('required') || el.getAttribute('aria-required') === 'true') {
    state.required = true;
  }
  if (el.getAttribute('aria-invalid') === 'true') state.invalid = true;
  if (el.hasAttribute('readonly')) state.readonly = true;

  return state;
}

export function normaliseSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
