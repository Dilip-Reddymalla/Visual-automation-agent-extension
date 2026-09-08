/**
 * What the walker saw, before anything has been redacted.
 *
 * There are two element types in this project and the difference is the whole privacy
 * argument:
 *
 *   ObservedElement   everything the DOM gave us, raw values included. Never leaves
 *                     the device. Carries the signals L0 needs to decide that a field
 *                     holds an Aadhaar number -- autocomplete, inputmode, name, id,
 *                     pattern, -webkit-text-security -- none of which the wire format
 *                     can or should express.
 *
 *   Element (wire)    what the planner sees, in shared/contract.ts. Names and values
 *                     already substituted for placeholders.
 *
 * `toWire` is the one-way door between them, and it is applied *after* M5 has detected
 * and M6 has allocated placeholders -- never before. It cannot leak a raw value by
 * accident because it never reads one: the substituted text arrives as its own
 * argument.
 *
 * Where this file lives, and why it is not content/observed.ts as specified: the
 * boundary test forbids shared/ and redaction/ from importing content/, and both need
 * this type -- DOM_SNAPSHOT carries it and l0-structural.ts consumes it. "Device-only"
 * means it never crosses the network, not that it never crosses a process boundary, so
 * it belongs with the other cross-context types. Node-pure either way: plain data, no
 * DOM references. The live handles stay in the content script's own map.
 */

import type { Box } from './coords';
import type { Element as WireElement, ElementRole, ElementState } from './contract';

/**
 * One run of text inside an element, with where it sits. L2 needs these to map a NER
 * span back to a box: the model works on a concatenated string and returns character
 * offsets, and without the runs there is no way back to pixels.
 */
export interface TextRun {
  text: string;
  box: Box;
  /** Position of this text node among the element's own text nodes. */
  nodeIndex: number;
}

/** Everything the walker saw. Raw. Device-only. */
export interface ObservedElement {
  // ── Fields that also exist on the wire ──────────────────────────────────────
  /**
   * The handle the planner uses. Absent for visual-only elements -- an image with
   * baked-in text, a canvas region -- which are reachable by coordinate only.
   */
  index?: number;
  /**
   * When this element is a wrapper around a real control, the control's own rect.
   *
   * The wrapper is what the user clicks, so the wrapper is what gets indexed -- but it
   * spans the caption as well as the value, and painting it blacks out both. A finding
   * belongs on the thing that holds the value. Device-side only; never on the wire.
   */
  controlBox?: import('./coords').Box;
  role: ElementRole;
  box: Box;
  state: ElementState;
  /** Fraction hidden behind other content, 0 (clear) to 1 (fully covered). */
  occluded: number;
  /** Frame path for nested documents, e.g. "0/2". Absent for the top document. */
  frame?: string;
  /** Appeared since the previous step. Rendered as the `*` marker. */
  isNew: boolean;

  // ── Device-only: the signals L0 decides on ──────────────────────────────────
  tag: string;
  inputType?: string;
  autocomplete?: string;
  inputMode?: string;
  nameAttr?: string;
  idAttr?: string;
  placeholder?: string;
  /** Text of the associated <label>, however it was associated. */
  labelText?: string;
  /**
   * The caption a human would read as this field's name, inferred from layout.
   *
   * Deliberately not merged into `labelText`. That field is what the page *declared*; this
   * one is what document order suggests, and the difference matters: L0 raises confidence
   * on a declared label ("a field labelled Aadhaar holds an Aadhaar number") and must not
   * do so on an inference. Only `worker/resolve.ts` reads this, and only to answer "which
   * box did the user mean" -- a question a human answers the same way.
   */
  nearbyText?: string;
  ariaLabel?: string;
  /** Resolved text of aria-describedby, which is where validation hints live. */
  ariaDescribedByText?: string;
  /** Computed -webkit-text-security. A field styled as dots is a password field. */
  textSecurity?: string;
  maxLength?: number;
  pattern?: string;
  /**
   * The actual value in the field. The single most sensitive string in the project:
   * it is why this type never goes on the wire.
   */
  rawValue?: string;
  textRuns: TextRun[];

  // ── Identity and rendering ──────────────────────────────────────────────────
  /** Stable across steps: tag, role, accessible name, normalised DOM path. */
  key: string;
  /** Accessible name, raw. */
  name: string;
  /** Number of options on a <select>. */
  optionCount?: number;
  /** Text of the selected option, raw. */
  selectedText?: string;
  href?: string;
  alt?: string;
  /** Text recovered from pixels by L3, rather than read from the DOM. */
  fromPixels?: boolean;
  /** Something is here that we cannot see into -- a closed shadow root. */
  opaque?: boolean;
  /**
   * This extension wrote the value in this field, rather than finding it there.
   *
   * Device-side only and deliberately not on the wire: it decides whether a finding is
   * counted as protection, and the planner has no use for it. See `Finding.origin`.
   */
  agentTyped?: boolean;
}

/** The placeholder-substituted strings M5 and M6 produce. Raw text cannot get in here. */
export interface RedactedText {
  /** Accessible name after substitution. */
  name: string;
  /** Field value after substitution. Absent when the element has no value. */
  value?: string;
}

/**
 * The projection. Applied after detection and allocation, never before.
 *
 * Note what is *not* copied: rawValue, and every attribute L0 sniffed. The planner has
 * no use for an element's `name` attribute, and the less of the page's shape that
 * crosses the network the smaller the fingerprint we hand the server.
 */
export function toWire(observed: ObservedElement, text: RedactedText): WireElement {
  const wire: WireElement = {
    role: observed.role,
    name: text.name,
    box: observed.box,
    state: observed.state,
    occluded: observed.occluded,
    fromPixels: observed.fromPixels ?? false,
    isNew: observed.isNew,
  };

  if (observed.index !== undefined) wire.index = observed.index;
  if (observed.frame !== undefined) wire.frame = observed.frame;
  if (text.value !== undefined) wire.value = text.value;
  return wire;
}
