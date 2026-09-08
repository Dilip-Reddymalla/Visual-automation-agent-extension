/**
 * Finding construction and bookkeeping, shared by every detection layer.
 *
 * A FindingDraft is what a detector produces: a class, a box, which layer found it, how
 * sure it is, and why. A Finding is what reaches the manifest, after the gate has
 * decided a redaction mode and the allocator has handed out a placeholder.
 *
 * The draft carries `value` -- the actual string that matched -- and the wire Finding
 * does not. That is the whole shape of the privacy boundary in one type: the value goes
 * to the PlaceholderAllocator and stays on the device, and what crosses the network is
 * a class, a box and a token.
 *
 * Node-pure.
 */

import type { Box } from '../shared/coords';
import type { DetectionLayer, Finding, Origin, RedactionMode } from '../shared/contract';
import type { PlaceholderClass } from '../shared/placeholders';
import type { BoxKind } from './policy';

export interface FindingDraft {
  cls: PlaceholderClass;
  box: Box;
  layer: DetectionLayer;
  confidence: number;
  /** Machine-readable: "verhoeff-ok", "autocomplete-cc-number", "ner-person". */
  reason: string;
  mode?: RedactionMode;
  /**
   * Where the value came from. Defaults to 'page' -- a detector that has no reason to
   * think otherwise is looking at the page as it found it.
   */
  origin?: Origin;
  /** Element index this came from, when a layer knows it. */
  elementIndex?: number;
  /** Character range within the string that was scanned. */
  textSpan?: [number, number];
  /**
   * The matched value. Device-only, and the reason FindingDraft is not the wire type.
   * Absent for findings that are not text at all -- a face is a region, not a string.
   */
  value?: string;
  /**
   * Where the box came from, which is what decides its padding (policy.ts).
   *
   * Defaults to 'element'. Only a detector that measured a rect drawn tight around
   * glyphs -- a text run, an OCR line -- should say 'text'.
   */
  boxKind?: BoxKind;
}

/**
 * Draft to wire. The placeholder is supplied by the caller, which means by whoever
 * holds the allocator -- and the value is dropped here, structurally, rather than by
 * remembering not to copy it.
 */
export function makeFinding(draft: FindingDraft, placeholder?: string): Finding {
  const finding: Finding = {
    id: findingId(draft.cls, draft.box, draft.layer),
    cls: draft.cls,
    box: draft.box,
    layer: draft.layer,
    confidence: clamp01(draft.confidence),
    mode: draft.mode ?? 'mask',
    reason: draft.reason,
    origin: draft.origin ?? 'page',
  };
  if (placeholder !== undefined) finding.placeholder = placeholder;
  return finding;
}

/**
 * Stable across steps, so the same value in the same place keeps its id and the
 * side-by-side view does not flicker. Derived from class, layer and a box rounded to
 * whole pixels -- sub-pixel reflow must not produce a new id.
 *
 * Deliberately not derived from the value: an id is written to the manifest, and a hash
 * of an Aadhaar number is still an Aadhaar number to anyone holding a rainbow table.
 */
export function findingId(cls: PlaceholderClass, box: Box, layer: DetectionLayer): string {
  const x = Math.round(box.x);
  const y = Math.round(box.y);
  const w = Math.round(box.w);
  const h = Math.round(box.h);
  return `${layer}-${cls}-${x}x${y}x${w}x${h}`.toLowerCase();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Highest confidence wins for a given class and overlapping box, and a deterministic
 * layer order breaks ties: L0 is a fact about the markup, L1 is a checksum, L2 and L3
 * are models. Used by merge.ts (M6) and by the layers themselves when one element
 * produces two drafts for the same span.
 */
export const LAYER_RANK: Record<DetectionLayer, number> = { L0: 3, L1: 2, L2: 1, L3: 0 };

/** The fields precedence actually depends on. Both FindingDraft and Finding have them. */
export interface Ranked {
  layer: DetectionLayer;
  confidence: number;
}

export function strongerDraft<T extends Ranked>(a: T, b: T): T {
  if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b;
  return LAYER_RANK[a.layer] >= LAYER_RANK[b.layer] ? a : b;
}
