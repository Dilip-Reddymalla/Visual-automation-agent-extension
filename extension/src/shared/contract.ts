/**
 * The wire format, and the only source of truth for it.
 *
 * `server/schema.json` (the planner response, used for guided decoding) and
 * `server/schema.request.json` are generated from these schemas by
 * `scripts/gen-schema.mjs`. `npm run schema:check` fails the build when the committed
 * files drift from this file, so the two cannot disagree silently.
 *
 * Everything here describes what crosses the network -- which means every field has
 * already been through the redaction gate. There is no raw PII type in this file and
 * there must never be one: a Finding on the wire carries a class, a box and a
 * placeholder, never the value it replaced.
 */

import { z } from 'zod';
import { PLACEHOLDER_CLASSES } from './placeholders';

/** Bumped whenever the shape below changes in a way an old peer would misread. */
export const PROTOCOL_VERSION = 1;

// ── Geometry ──────────────────────────────────────────────────────────────────

/** CSS px of the visual viewport, origin top-left (CLAUDE.md invariant 2). */
export const BoxSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
});

export const ViewportSchema = z.strictObject({
  w: z.number().positive(),
  h: z.number().positive(),
});

// ── Elements ──────────────────────────────────────────────────────────────────

export const ELEMENT_ROLES = [
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'menuitem',
  'file',
  'heading',
  'text',
  'image',
  'canvas',
  'video',
  'iframe',
  'other',
] as const;

export const ElementRoleSchema = z.enum(ELEMENT_ROLES);

export const ElementStateSchema = z.strictObject({
  visible: z.boolean(),
  enabled: z.boolean(),
  focused: z.boolean(),
  /**
   * The field has something in it.
   *
   * Separate from `value` on purpose, because three situations have to be
   * distinguishable and two booleans cannot do it:
   *
   *   filled=false, no value          empty; fill it
   *   filled=true, value="«EMAIL_1»"  filled, and the token can be reused elsewhere
   *   filled=true, no value           filled, but no token was issued -- leave it alone
   *
   * The third is the one that matters. A sentinel string in `value` would have been a
   * value that is not a value, and the planner would eventually type it into a field.
   */
  filled: z.boolean().default(false),
  checked: z.boolean().optional(),
  expanded: z.boolean().optional(),
  required: z.boolean().optional(),
  invalid: z.boolean().optional(),
  readonly: z.boolean().optional(),
});

/**
 * One interactive or informative element. `index` is the handle the planner uses to
 * refer back to it; it is stable only within a step. `name` and `value` are already
 * placeholdered where they contained anything sensitive.
 */
export const ElementSchema = z.strictObject({
  /**
   * Absent for visual-only elements -- text baked into an image, a region of a canvas.
   * Those are reachable by coordinate only; the planner may point at them but cannot
   * say "click 7".
   */
  index: z.number().int().nonnegative().optional(),
  role: ElementRoleSchema,
  name: z.string(),
  value: z.string().optional(),
  box: BoxSchema,
  state: ElementStateSchema,
  /** Fraction of the element hidden behind other content, 0 to 1. */
  occluded: z.number().min(0).max(1).default(0),
  /** Frame path for cross-origin content, e.g. "0/2". Absent for the top document. */
  frame: z.string().optional(),
  /** True when this element's text came from a vision model, not the DOM. */
  fromPixels: z.boolean().default(false),
  /** Appeared since the previous step. Serialised as the `*` marker. */
  isNew: z.boolean().default(false),
});

// ── Redaction manifest ────────────────────────────────────────────────────────

export const PlaceholderClassSchema = z.enum(PLACEHOLDER_CLASSES);

/** Which detection layer produced a finding. See CLAUDE.md, the perception stack. */
export const DetectionLayerSchema = z.enum(['L0', 'L1', 'L2', 'L3']);

/** What the gate did to the pixels under a finding. */
export const RedactionModeSchema = z.enum(['mask', 'blur', 'pixelate', 'keep']);

/** Where a redacted value came from. See `Finding.origin`. */
export const OriginSchema = z.enum(['page', 'agent', 'user']);
export type Origin = z.infer<typeof OriginSchema>;

/**
 * A finding as the *server* sees it: what was removed, where, and why. The value that
 * used to be there stays on the device, in the PlaceholderAllocator.
 */
export const FindingSchema = z.strictObject({
  id: z.string().min(1),
  cls: PlaceholderClassSchema,
  box: BoxSchema,
  layer: DetectionLayerSchema,
  confidence: z.number().min(0).max(1),
  mode: RedactionModeSchema,
  /** The token the server will see in text where this value stood. */
  placeholder: z.string().optional(),
  /** Short machine-readable reason, e.g. "verhoeff-ok", "ner-person", "input-type-password". */
  reason: z.string().min(1),
  /**
   * Where the value came from, which decides whether protecting it means anything.
   *
   * All three are redacted. The distinction is about *counting*, and it exists because
   * the counter was reporting our own keystrokes as protected user data: the agent typed
   * an address into two fields, the next step's screenshot contained it, the filter
   * correctly masked it, and the panel said "Values redacted this session: 10" on a page
   * that had never held a single value of the user's.
   *
   *   page    already there when the agent arrived. The only kind that is a claim.
   *   agent   our executor typed it, this step or an earlier one. Redacted, not counted.
   *   user    substituted out of the task box. Reserved, and nothing assigns it yet --
   *           a value from the goal reaches the page only by our typing it, which makes
   *           it `agent`; the standalone case needs the goal's tokens at detection time
   *           and no detector has them.
   */
  origin: OriginSchema.default('page'),
});

/**
 * The gate's receipt. The service worker recomputes this hash over the encoded bytes
 * and refuses the payload when it does not match (CLAUDE.md invariant 1).
 */
export const ReceiptSchema = z.strictObject({
  algo: z.literal('SHA-256'),
  /** Lower-case hex digest of the encoded image bytes. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Digest over the canonicalised manifest, binding findings to those bytes. */
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  sealedAt: z.number().int().nonnegative(),
});

/**
 * What the device understood the user to be asking for.
 *
 * Sent because telling the planner "the user asked to fill the first-name field" makes it
 * far more accurate than handing it a bare element list and hoping. Not sensitive: a verb
 * and a field name are the operator's *instruction*, not their data.
 *
 * The value is not here. It is `valueRef` -- a placeholder -- for the same reason the
 * element list carries tokens: the planner does not need to know what is being typed in
 * order to say where.
 */
export const IntentSchema = z.strictObject({
  verb: z.enum(['fill', 'click', 'select', 'submit', 'navigate']),
  target: z.string(),
  /** The token standing in for a value, when the value was PII. Never the value. */
  valueRef: z.string().optional(),
});

export const ManifestSchema = z.strictObject({
  findings: z.array(FindingSchema),
  /** How many findings of each class. Present classes only -- absent means zero. */
  counts: z.partialRecord(PlaceholderClassSchema, z.number().int().nonnegative()),
  /**
   * Fraction of the viewport the gate obscured, 0 to 1: painted area over viewport
   * area. How much of the page the planner cannot see.
   */
  /**
   * How many element indices are drawn on the frame (Set-of-Mark).
   *
   * Not findings and never listed as findings -- a mark is not a redaction. It is here so
   * the payload is self-describing: the planner is being handed a numbered picture, and
   * the manifest should say how many numbers are on it.
   */
  marks: z.number().int().nonnegative().default(0),
  redactedFraction: z.number().min(0).max(1),
  /**
   * Fraction of the painted area that covered nothing anyone detected, 0 to 1.
   *
   * A different number from redactedFraction and it must not be conflated with it.
   * Obscuring 40% of a dense form can be exactly right; obscuring 40% *more than the
   * findings called for* is padding and merging run wild. This is the one that says
   * whether the gate is being careless, and M11 reports both.
   */
  overRedactedFraction: z.number().min(0).max(1),
  policyVersion: z.string().min(1),
  receipt: ReceiptSchema,
});

// ── Capture ───────────────────────────────────────────────────────────────────

/**
 * The sealed screenshot. `bytes` is base64 only on the JSON path; the multipart
 * transport sends the bytes as their own part and leaves this field out. Either way
 * `sha256` must equal the receipt hash.
 */
export const CaptureSchema = z.strictObject({
  mime: z.enum(['image/webp', 'image/png', 'image/jpeg']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Image pixels per CSS pixel. The one scale factor (CLAUDE.md invariant 2). */
  scale: z.number().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.string().optional(),
});

// ── Step request: device -> server ────────────────────────────────────────────

export const HistoryEntrySchema = z.strictObject({
  stepIndex: z.number().int().nonnegative(),
  action: z.string().min(1),
  outcome: z.enum(['ok', 'failed', 'no-op']),
  note: z.string().optional(),
});

export const StepRequestSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessionId: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
  /** The user's goal, already placeholdered. */
  goal: z.string().min(1),
  /**
   * The goal, parsed, when the device could parse it. Empty for an open-ended task.
   *
   * The device resolves what it can itself and only reaches the planner for what it
   * cannot; sending what it understood turns "here is a page, guess" into "the user asked
   * to fill the first-name field and I could not tell which of these two it is".
   */
  intents: z.array(IntentSchema).default([]),
  /** Origin only -- never the full URL, which routinely carries identifiers. */
  origin: z.string().min(1),
  title: z.string().default(''),
  viewport: ViewportSchema,
  capture: CaptureSchema,
  elements: z.array(ElementSchema),
  manifest: ManifestSchema,
  history: z.array(HistoryEntrySchema).default([]),
});

// ── Step response: server -> device ───────────────────────────────────────────

const withIndex = { index: z.number().int().nonnegative() };

export const ActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('click'), ...withIndex }),
  z.strictObject({
    type: z.literal('type'),
    ...withIndex,
    /** May contain placeholders. They are rehydrated locally, never by the planner. */
    text: z.string(),
    /** Press Enter after typing. */
    submit: z.boolean().default(false),
  }),
  z.strictObject({ type: z.literal('select'), ...withIndex, option: z.string() }),
  z.strictObject({
    type: z.literal('scroll'),
    /** Scroll this element into view, or the page when absent. */
    index: z.number().int().nonnegative().optional(),
    dx: z.number().default(0),
    dy: z.number().default(0),
  }),
  z.strictObject({ type: z.literal('key'), key: z.string().min(1) }),
  z.strictObject({ type: z.literal('wait'), ms: z.number().int().min(0).max(10_000) }),
  z.strictObject({ type: z.literal('navigate'), url: z.string().min(1) }),
  z.strictObject({ type: z.literal('ask'), question: z.string().min(1) }),
  z.strictObject({
    type: z.literal('finish'),
    status: z.enum(['success', 'blocked', 'refused']),
    summary: z.string(),
  }),
]);

export const StepResponseSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  stepIndex: z.number().int().nonnegative(),
  /** One or two sentences. Placeholders only -- the planner has nothing else to say. */
  rationale: z.string().default(''),
  /** Short batches keep the loop honest; anything longer is a plan, not a step. */
  actions: z.array(ActionSchema).min(1).max(4),
  done: z.boolean().default(false),
});

// ── Inferred types ────────────────────────────────────────────────────────────

export type Box = z.infer<typeof BoxSchema>;
export type Viewport = z.infer<typeof ViewportSchema>;
export type ElementRole = z.infer<typeof ElementRoleSchema>;
export type ElementState = z.infer<typeof ElementStateSchema>;
export type Element = z.infer<typeof ElementSchema>;
export type DetectionLayer = z.infer<typeof DetectionLayerSchema>;
export type RedactionMode = z.infer<typeof RedactionModeSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
export type Capture = z.infer<typeof CaptureSchema>;
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type StepRequest = z.infer<typeof StepRequestSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type ActionType = Action['type'];
export type StepResponse = z.infer<typeof StepResponseSchema>;
