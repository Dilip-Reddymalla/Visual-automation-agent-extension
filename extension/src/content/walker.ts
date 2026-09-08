/**
 * Depth-first walk of the document, descending into open shadow roots and same-origin
 * iframes. Produces raw candidates; deciding which of them matter is interactivity.ts.
 *
 * Naming, because three different things are called "element" in this project:
 *   DomEl            the DOM global. A live node.
 *   ObservedElement  what we record about one. shared/observed.ts.
 *   WireElement      what the planner sees. shared/contract.ts.
 *
 * A closed shadow root cannot be walked -- that is the point of closing it. Rather than
 * silently emitting nothing, the walk marks the host `opaque`, so the planner is told
 * "something is here that we cannot see into" instead of being told nothing at all. A
 * missing element and an unreadable one are different problems and only one of them is
 * ours to fix.
 */

import type { Box } from '../shared/coords';

/** The DOM global, named so no file has to guess which `Element` it is looking at. */
export type DomEl = Element;

export interface RawNode {
  el: DomEl;
  /** CSS px of the visual viewport (CLAUDE.md invariant 2). */
  box: Box;
  /** Frame path for nested documents, e.g. "0/2". Empty for the top document. */
  framePath: string;
  depth: number;
  /** Depth of open shadow roots crossed to reach this node. */
  shadowDepth: number;
  /** A custom element whose shadow root is closed. Its contents are unreachable. */
  opaque?: boolean;
}

export interface WalkOptions {
  /** Stop after this many nodes rather than walking a pathological page forever. */
  limit?: number;
  includeShadowRoots?: boolean;
  includeSameOriginFrames?: boolean;
  /** Measures a node. Injected so the walk runs under jsdom, which has no layout. */
  measure?: (el: DomEl) => Box;
  /** Recursion guard for deeply nested frames. */
  maxFrameDepth?: number;
}

export const DEFAULT_NODE_LIMIT = 4_000;
export const DEFAULT_MAX_FRAME_DEPTH = 4;

/**
 * TreeWalker's constants, written out rather than read off the `NodeFilter` global.
 * That global belongs to a window, and this module is deliberately usable against a
 * document that came from somewhere else -- a jsdom instance in a test, a same-origin
 * iframe with its own realm. The values are fixed by the DOM spec.
 */
const SHOW_ELEMENT = 0x1;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

/** Nothing inside these is ever actionable, and script/style text is not page text. */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD']);

function measureWithLayout(el: DomEl): Box {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}

/**
 * A custom element with a closed shadow root looks, from outside, like an empty tag.
 * There is no API that says so, so this is a heuristic: a hyphenated name (the spec
 * requires one), no light-DOM children, no open shadow root, and some rendered size.
 */
function looksOpaque(el: DomEl): boolean {
  if (!el.tagName.includes('-')) return false;
  if (el.shadowRoot) return false;
  return el.childElementCount === 0 && (el.textContent ?? '').trim().length === 0;
}

export function walk(root: Document | ShadowRoot, options: WalkOptions = {}): RawNode[] {
  const limit = options.limit ?? DEFAULT_NODE_LIMIT;
  const measure = options.measure ?? measureWithLayout;
  const intoShadow = options.includeShadowRoots ?? true;
  const intoFrames = options.includeSameOriginFrames ?? true;
  const maxFrameDepth = options.maxFrameDepth ?? DEFAULT_MAX_FRAME_DEPTH;

  const out: RawNode[] = [];

  function visit(
    scope: Document | ShadowRoot,
    framePath: string,
    baseDepth: number,
    shadowDepth: number,
    frameDepth: number,
  ): void {
    const doc = scope.ownerDocument ?? (scope as Document);
    const walker = doc.createTreeWalker(scope as unknown as Node, SHOW_ELEMENT, {
      acceptNode(node: Node) {
        const el = node as DomEl;
        if (SKIP_TAGS.has(el.tagName)) return FILTER_REJECT;
        return FILTER_ACCEPT;
      },
    });

    let current = walker.nextNode() as DomEl | null;
    while (current && out.length < limit) {
      const el = current;
      const depth = baseDepth + depthWithin(el, scope);
      const opaque = looksOpaque(el);

      out.push({
        el,
        box: measure(el),
        framePath,
        depth,
        shadowDepth,
        ...(opaque ? { opaque: true } : {}),
      });

      // Open shadow root: its contents are part of what the user sees.
      if (intoShadow && el.shadowRoot) {
        visit(el.shadowRoot, framePath, depth + 1, shadowDepth + 1, frameDepth);
      }

      if (intoFrames && el.tagName === 'IFRAME' && frameDepth < maxFrameDepth) {
        const index = frameIndex(el);
        const nested = sameOriginDocument(el);
        if (nested) {
          const childPath = framePath === '' ? String(index) : `${framePath}/${index}`;
          visit(nested, childPath, depth + 1, 0, frameDepth + 1);
        }
      }

      current = walker.nextNode() as DomEl | null;
    }
  }

  visit(root, '', 0, 0, 0);
  return out;
}

/** Cross-origin frames throw on access. That is the browser doing its job, not an error. */
function sameOriginDocument(frame: DomEl): Document | null {
  try {
    const doc = (frame as HTMLIFrameElement).contentDocument;
    return doc && doc.documentElement ? doc : null;
  } catch {
    return null;
  }
}

function frameIndex(frame: DomEl): number {
  const doc = frame.ownerDocument;
  if (!doc) return 0;
  return [...doc.querySelectorAll('iframe')].indexOf(frame as HTMLIFrameElement);
}

function depthWithin(el: DomEl, scope: Document | ShadowRoot): number {
  let depth = 0;
  let node: DomEl | null = el.parentElement;
  while (node && node !== (scope as unknown as DomEl)) {
    depth += 1;
    node = node.parentElement;
  }
  return depth;
}

/**
 * A path that survives re-rendering: tag plus nth-of-type per level, crossing shadow
 * boundaries with a marker. Used for the diff key, so a React re-render that produces
 * the same tree does not read as a page full of new elements.
 */
export function domPath(el: DomEl): string {
  const parts: string[] = [];
  let node: DomEl | null = el;

  while (node) {
    const parent: DomEl | null = node.parentElement;
    if (!parent) {
      const root = node.getRootNode?.();
      const host = root && (root as ShadowRoot).host;
      if (host) {
        parts.unshift(`${node.tagName.toLowerCase()}#shadow`);
        node = host as DomEl;
        continue;
      }
      parts.unshift(node.tagName.toLowerCase());
      break;
    }

    const siblings = [...parent.children].filter((c) => c.tagName === node?.tagName);
    const nth = siblings.indexOf(node) + 1;
    parts.unshift(
      siblings.length > 1
        ? `${node.tagName.toLowerCase()}[${nth}]`
        : node.tagName.toLowerCase(),
    );
    node = parent;
  }

  return parts.join('/');
}
