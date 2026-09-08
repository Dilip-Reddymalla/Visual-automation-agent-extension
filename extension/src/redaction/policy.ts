/**
 * Per-class redaction policy: for each class, what the gate does to those pixels and
 * what the server sees in the text.
 *
 * Over-redaction is a first-class failure (CLAUDE.md, what the evaluation rewards).
 * Blacking out a whole card costs the 25% visual-context metric and gains nothing on
 * the 20% redaction metric, which measures IoU *and* over-redaction rate. Mask the
 * value, keep the label.
 *
 * Three things are decided here, per class:
 *
 *   mode      what happens to the pixels. `mask` for anything whose shape leaks
 *             nothing useful, `blur` where the planner still needs to understand what
 *             kind of thing is there. Never `pixelate`: at the block sizes that look
 *             acceptable it is partially reversible, and a redaction that can be undone
 *             is not a redaction.
 *
 *   padding   how far past the detected box to paint -- and this depends on what kind
 *             of box it is, not on the class.
 *
 *             Padding exists for one reason: anti-aliased glyph edges bleed a pixel or
 *             two past a rect drawn tight around them, and a mask flush to such a rect
 *             leaves a legible ghost of the first and last character.
 *
 *             A form field's rect is not drawn tight around its glyphs. The site's own
 *             CSS padding is already there -- 8px and a border on the demo page, and
 *             something similar nearly everywhere -- so the value starts eleven pixels
 *             inside the box the detector reports. Bleed padding on that box corrects a
 *             problem it does not have, and the correction is measurable: proportional
 *             padding of 6% on a 380x32 field paints 11px of empty space either side
 *             and produces 11.0% over-redaction on its own. The first browser load
 *             measured 10.1%, against a target under 5%, and this was all of it.
 *
 *             So: element-derived boxes get nothing, and boxes drawn tight around text
 *             -- a text run, an OCR line -- get a small absolute amount. Absolute,
 *             because glyph bleed is a fixed number of pixels; it does not get larger
 *             because the box is wider.
 *
 *   floor     the confidence below which a finding is reported but *not painted*. See
 *             `keep` below -- this is the interesting one.
 *
 * Node-pure.
 */

import type { RedactionMode } from '../shared/contract';
import type { PlaceholderClass } from '../shared/placeholders';

/**
 * Where a finding's box came from, which is what decides its padding.
 *
 *   element  the rect of a form control or a block. Carries the site's own CSS padding
 *            already, so the glyphs are nowhere near the edge.
 *   text     a rect drawn tight around glyphs: a text run, or a line an OCR model
 *            returned. This is the one that bleeds.
 */
/**
 * Where a box came from, which is what decides both its padding and whether it may be
 * painted at all.
 *
 *   element    a control's own rect. The site's CSS padding already sits inside it.
 *   text       a rect drawn tight around glyphs -- a text run, an OCR line.
 *   container  a wrapper spanning a caption and a value together. Never painted: doing
 *              so blacks out the label as well, and across the corpus that was half of
 *              all over-redaction. Resolved to the value's own rect, or dropped.
 */
export type BoxKind = 'element' | 'text' | 'container';

export interface ClassPolicy {
  mode: RedactionMode;
  /** Below this confidence the finding is reported as `keep`, not painted. */
  minConfidence: number;
  /**
   * Whether the placeholder carries a number.
   *
   * SECRET does not (CLAUDE.md invariant 6). A numbered secret would be a rehydratable
   * one, and the whole point is that a plan mentioning it resolves to nothing: the
   * value comes from the local vault after an explicit confirm, never from a token the
   * planner produced.
   */
  numbered: boolean;
}

export const POLICY_VERSION = 'p1';

/**
 * Painting nothing, on purpose.
 *
 * A detector that is unsure is in a genuinely awkward position: painting produces
 * over-redaction on a guess, and dropping the finding silently means the manifest
 * claims a clean page it never verified. `keep` is the honest third answer -- the
 * finding goes in the manifest with its class, its box, its confidence and a reason
 * saying it was left visible.
 *
 * The server is then told exactly what we saw and exactly what we did about it. A
 * manifest that omitted these would be lying by omission, and the sentence "we detect
 * and redact PII" would be doing work the code does not.
 */
/**
 * Reading order for a human, most consequential first.
 *
 * The first eight are the eval's HIGH_SEVERITY set (eval/metrics.py), named there as the
 * classes where a single leak is an identity document, a bank instrument or a credential.
 * The rest follow in the frozen vocabulary's own order. Kept here rather than in the panel
 * because it is a statement about the classes, not about a table.
 *
 * This orders rows on screen and nothing else. It is not a precedence rule and must never
 * become one -- LAYER_RANK and strongerDraft decide which finding wins, and a second
 * ordering that could disagree with them is a second answer to the same question.
 */
export const SEVERITY_ORDER: readonly PlaceholderClass[] = [
  'SECRET',
  'AADHAAR',
  'PAN',
  'PASSPORT',
  'LICENCE',
  'CARD',
  'ACCOUNT',
  'GSTIN',
  'IFSC',
  'UPI',
  'DOB',
  'PHONE',
  'EMAIL',
  'ADDRESS',
  'PERSON',
  'ORG',
];

/** Lower sorts first. Unknown classes sort last rather than first. */
export function severityRank(cls: PlaceholderClass): number {
  const at = SEVERITY_ORDER.indexOf(cls);
  return at === -1 ? SEVERITY_ORDER.length : at;
}

export const KEEP_REASON = 'below-confidence-floor';

/**
 * Floors differ by class because the cost of a mistake does. An Aadhaar number is
 * checksum-backed, so a low-confidence one is nearly always real and the damage of
 * missing it is severe: the floor is low. An organisation name is a model's guess about
 * a common noun, and painting over every company mentioned on the page would wreck the
 * visual-context score: the floor is high.
 */
const IDENTIFIER: ClassPolicy = { mode: 'mask', minConfidence: 0.5, numbered: true };
const CONTACT: ClassPolicy = { mode: 'mask', minConfidence: 0.6, numbered: true };
const SOFT: ClassPolicy = { mode: 'mask', minConfidence: 0.65, numbered: true };

const POLICIES: Readonly<Record<PlaceholderClass, ClassPolicy>> = {
  // No number, and no way back. The box is opaque and the token is bare.
  SECRET: { mode: 'mask', minConfidence: 0.4, numbered: false },

  // Government and financial identifiers: opaque box, tight padding. Their shape says
  // nothing the planner needs, so there is nothing to preserve.
  AADHAAR: IDENTIFIER,
  PAN: IDENTIFIER,
  GSTIN: IDENTIFIER,
  IFSC: IDENTIFIER,
  ACCOUNT: IDENTIFIER,
  CARD: IDENTIFIER,
  PASSPORT: IDENTIFIER,
  LICENCE: IDENTIFIER,

  // Contact details: same treatment, slightly wider, because these are usually inside
  // running text where the glyphs are not aligned to a field rect.
  EMAIL: CONTACT,
  PHONE: CONTACT,
  DOB: CONTACT,
  UPI: CONTACT,

  // Names, addresses and organisations come from the layer most likely to be wrong.
  PERSON: SOFT,
  ADDRESS: SOFT,
  ORG: { ...SOFT, minConfidence: 0.7 },
  // A photograph of a person. Blurred rather than blacked out, because layout is
  // information: a blurred face still reads as a photograph in a form and the planner
  // understands the page, where a black rectangle reads as a missing image and costs
  // visual context for no privacy gain. Written out rather than referencing BLUR_POLICY,
  // which is declared below this table; a test asserts the two stay identical.
  FACE: { mode: 'blur', minConfidence: 0.5, numbered: false },
};

export function policyFor(cls: PlaceholderClass): ClassPolicy {
  return POLICIES[cls];
}

/**
 * The blur policy, for regions where the planner still needs to see *that* something is
 * there: a face, a signature, a photograph of a document.
 *
 * Blur rather than a solid fill because layout is information. A blurred face still
 * reads as a photograph in a form, so the planner understands the page; a black
 * rectangle reads as a missing image and costs visual-context accuracy for no privacy
 * gain at all.
 *
 * FACE maps here, as of M5c-A. Adding it meant editing shared/placeholders.ts, the Zod
 * contract, the regenerated server schema, the server prompt, the eval harness and the
 * label tool in one commit -- invariant 5, and five separate tests refused the change
 * until every one of them had been done, which is the invariant working rather than
 * getting in the way.
 *
 * SIGNATURE is still to come and is the same exercise.
 */
export const BLUR_POLICY: ClassPolicy = {
  mode: 'blur',
  minConfidence: 0.5,
  numbered: false,
};

/**
 * How far past a box to paint, in CSS pixels, by what kind of box it is.
 *
 * Not per class. A class does not have an edge; a box does, and whether that edge sits
 * on a glyph is a property of how the box was measured.
 */
export const PADDING_PX: Readonly<Record<BoxKind, number>> = {
  // Never used: a container is resolved or dropped before it reaches the gate. Present
  // so the record is total and a new box kind cannot be added without a decision here.
  container: 0,
  // The site's own padding is already there. Anything added here is empty space, and
  // empty space painted black is exactly what the over-redaction rate counts.
  element: 0,
  // Tight around glyphs, so the anti-aliased edge really does spill. Two pixels covers
  // it at every font size the demo pages use, and costs a fraction of a percent on a
  // rect that is only sixteen pixels tall.
  text: 2,
};

/**
 * Blur is the exception, and deliberately so. A blurred region has to extend past what
 * it is hiding -- a face blurred exactly to its bounding box leaves a sharp outline of
 * a head, which is recognisable. This padding is in pixels like the others, but it is
 * generous rather than minimal.
 */
export const BLUR_PADDING_PX = 12;

/** How hard to blur, as a fraction of the region's short side. */
export const BLUR_STRENGTH = 0.25;

/** Below this many pixels a blur radius stops obscuring anything. */
export const MIN_BLUR_RADIUS = 6;
