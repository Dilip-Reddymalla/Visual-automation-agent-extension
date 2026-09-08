/**
 * How much of an element is actually visible: hit-testing against overlays, sticky
 * headers, cookie banners and modals. An element the user cannot see is one the agent
 * must not click.
 *
 * Five probes -- centre and the four quarter points. At each one, ask the document what
 * is on top; if the answer is the element itself or something inside it, that probe is
 * clear. The fraction of blocked probes is the occlusion score.
 *
 * It is a fraction and not a boolean because partial occlusion is the common case and
 * it is usually fine: a sticky header covering the top of a long card does not stop the
 * card being clickable. Only a candidate above OCCLUSION_DROP_ABOVE is dropped; the
 * rest are kept and reported, and the planner decides.
 *
 * `elementFromPoint` is injected, so this runs under jsdom -- which has no layout and
 * no hit-testing of its own.
 */

import type { Box, Viewport } from '../shared/coords';
import type { DomEl } from './walker';

/**
 * Drop a candidate only when every probe is blocked. Five probes means the score is one
 * of 0, 0.2, 0.4, 0.6, 0.8 or 1.0, so this threshold means "completely covered" -- the
 * button behind the modal -- while a card under a sticky header at 0.2 or 0.4 survives.
 */
export const OCCLUSION_DROP_ABOVE = 0.9;

export type HitTest = (x: number, y: number) => DomEl | null;

/** Centre, then the four quarter points. */
export function probePoints(box: Box): Array<[number, number]> {
  const { x, y, w, h } = box;
  return [
    [x + w / 2, y + h / 2],
    [x + w / 4, y + h / 4],
    [x + (w * 3) / 4, y + h / 4],
    [x + w / 4, y + (h * 3) / 4],
    [x + (w * 3) / 4, y + (h * 3) / 4],
  ];
}

/** The hit is ours if it is the element, inside it, or its shadow host. */
export function hitBelongsTo(hit: DomEl | null, el: DomEl): boolean {
  if (!hit) return false;
  if (hit === el) return true;
  if (el.contains(hit)) return true;

  // A shadow root reports its host, not the inner node the user actually clicked.
  let node: DomEl | null = hit;
  let hops = 0;
  while (node && hops < 8) {
    if (node === el) return true;
    const root = node.getRootNode?.() as ShadowRoot | Document | undefined;
    const host = root && 'host' in root ? (root.host as DomEl) : null;
    if (!host) break;
    node = host;
    hops += 1;
  }
  return false;
}

export interface OcclusionOptions {
  hitTest: HitTest;
  viewport: Viewport;
}

export function occlusionFraction(el: DomEl, box: Box, options: OcclusionOptions): number {
  const { hitTest, viewport } = options;
  const points = probePoints(box);

  let offscreen = 0;
  let blocked = 0;

  for (const [x, y] of points) {
    // A point outside the viewport cannot be hit-tested; it counts as not visible.
    if (x < 0 || y < 0 || x >= viewport.w || y >= viewport.h) {
      offscreen += 1;
      continue;
    }
    if (!hitBelongsTo(hitTest(x, y), el)) blocked += 1;
  }

  return (blocked + offscreen) / points.length;
}

export function isOccluded(fraction: number): boolean {
  return fraction > OCCLUSION_DROP_ABOVE;
}

/** The real hit test, for the content script. */
export function documentHitTest(doc: Document): HitTest {
  return (x, y) => {
    const hit = doc.elementFromPoint(x, y);
    if (!hit) return null;
    // Pierce open shadow roots: elementFromPoint stops at the host.
    let node: DomEl = hit;
    let guard = 0;
    while (node.shadowRoot && guard < 8) {
      const inner = node.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === node) break;
      node = inner;
      guard += 1;
    }
    return node;
  };
}
