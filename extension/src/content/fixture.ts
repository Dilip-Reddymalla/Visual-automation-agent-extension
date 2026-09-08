/**
 * Test scaffolding for the DOM pipeline.
 *
 * jsdom has no layout engine: every getBoundingClientRect is zero and there is no
 * elementFromPoint at all. So the tests supply geometry themselves, through the same
 * `PerceiveEnv` seam the browser fills in for real. What that leaves untested here is
 * layout itself; what it makes testable is the ordering, the collapsing, the diff and
 * the occlusion arithmetic, which is where the bugs live.
 *
 * Boxes are declared in the fixture HTML as `data-box="x,y,w,h"`.
 *
 * Not a *.test.ts file, so several suites can import it.
 */

import { JSDOM } from 'jsdom';
import type { Box, Viewport } from '../shared/coords';
import type { StyleLike } from './interactivity';
import type { PerceiveEnv } from './perceive';
import type { DomEl } from './walker';

export const DEFAULT_VIEWPORT: Viewport = { w: 1280, h: 720 };

export interface FixtureOptions {
  viewport?: Viewport;
  /** Elements matching these selectors are "on top" at every point they cover. */
  overlays?: string[];
  styles?: Record<string, Partial<StyleLike>>;
  previousKeys?: ReadonlySet<string>;
}

export interface Fixture {
  dom: JSDOM;
  doc: Document;
  env: PerceiveEnv;
  box(selector: string): Box;
}

const ZERO: Box = { x: 0, y: 0, w: 0, h: 0 };

export function boxOf(el: DomEl): Box {
  const attr = el.getAttribute('data-box');
  if (!attr) return ZERO;
  const [x, y, w, h] = attr.split(',').map((n) => Number.parseFloat(n));
  return { x: x ?? 0, y: y ?? 0, w: w ?? 0, h: h ?? 0 };
}

function contains(box: Box, x: number, y: number): boolean {
  return x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
}

/**
 * Every node with a declared box, shadow roots included. querySelectorAll stops at a
 * shadow boundary, so a fixture that did not do this would report everything inside an
 * open shadow root as fully occluded -- and the pipeline would correctly drop it.
 */
/**
 * How deeply nested a node is, counting a shadow boundary as one level. Without the
 * boundary hop, everything inside a shadow root looks shallower than its own host and
 * the host wins every hit test -- which reads as "the whole component is occluded".
 */
function nestingDepth(node: DomEl): number {
  let depth = 0;
  let current: DomEl | null = node;
  while (current) {
    const parent: DomEl | null = current.parentElement;
    if (parent) {
      current = parent;
      depth += 1;
      continue;
    }
    const root = current.getRootNode?.() as ShadowRoot | Document | undefined;
    const host = root && 'host' in root ? (root.host as DomEl) : null;
    if (!host) break;
    current = host;
    depth += 1;
  }
  return depth;
}

function boxedNodes(root: Document | ShadowRoot): DomEl[] {
  const out: DomEl[] = [];
  for (const node of root.querySelectorAll('*')) {
    if (node.hasAttribute('data-box')) out.push(node);
    if (node.shadowRoot) out.push(...boxedNodes(node.shadowRoot));
  }
  return out;
}

export function fixture(html: string, options: FixtureOptions = {}): Fixture {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const doc = dom.window.document;
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;

  const overlayNodes = (options.overlays ?? []).flatMap((selector) => [
    ...doc.querySelectorAll(selector),
  ]);

  /**
   * A hit test built from the declared boxes: the topmost overlay wins, otherwise the
   * deepest element whose box covers the point. Close enough to a real one for the
   * cases that matter -- a modal over a button, a sticky header over a card.
   */
  const hitTest = (x: number, y: number): DomEl | null => {
    for (const node of overlayNodes) {
      if (contains(boxOf(node), x, y)) return node;
    }
    let best: DomEl | null = null;
    let bestDepth = -1;
    for (const node of boxedNodes(doc)) {
      if (!contains(boxOf(node), x, y)) continue;
      const depth = nestingDepth(node);
      // >= so that, among equally nested elements, the later one in document order
      // wins -- which is what paint order does in a real browser.
      if (depth >= bestDepth) {
        best = node;
        bestDepth = depth;
      }
    }
    return best;
  };

  const style = (el: DomEl): StyleLike => {
    const base: StyleLike = {
      display: el.getAttribute('data-display') ?? 'block',
      visibility: el.getAttribute('data-visibility') ?? 'visible',
      opacity: el.getAttribute('data-opacity') ?? '1',
      cursor: el.getAttribute('data-cursor') ?? 'auto',
      textSecurity: el.getAttribute('data-text-security') ?? 'none',
    };
    for (const [selector, override] of Object.entries(options.styles ?? {})) {
      if (el.matches(selector)) Object.assign(base, override);
    }
    return base;
  };

  return {
    dom,
    doc,
    box: (selector) => {
      const el = doc.querySelector(selector);
      if (!el) throw new Error(`fixture: no element matches ${selector}`);
      return boxOf(el);
    },
    env: {
      doc,
      viewport,
      measure: boxOf,
      style,
      hitTest,
      previousKeys: options.previousKeys,
    },
  };
}

/** Shorthand: a full page around a body fragment. */
export function page(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}
