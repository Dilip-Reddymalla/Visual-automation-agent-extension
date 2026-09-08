/**
 * The operator overlay: outlines and index badges over what the walker found.
 *
 * Built early on purpose. Reading a serialised element list tells you what the agent
 * thinks it sees; the overlay tells you whether that matches the page, and it finds a
 * wrong interactivity rule in seconds rather than in a debugging session.
 *
 * It lives in a closed shadow root attached to a fixed-position host. That is not
 * decoration: styles from the page must not reach the overlay, and -- far more
 * important -- the overlay must not reach the page. The next walk must find exactly
 * what the last one found, and an overlay that injected styled nodes into the document
 * would change the very thing it is drawing.
 *
 * Positioning: boxes are already in CSS px of the visual viewport (invariant 2), and
 * the host is `position: fixed`, whose coordinate system is the same. So the numbers go
 * straight through with no conversion, and they stay correct under browser zoom -- at
 * 150% zoom both the rects and the fixed host scale together.
 *
 * ## This is not Set-of-Mark
 *
 * The numbered badges the planner reads are drawn somewhere else entirely --
 * `redaction/marks.ts`, inside the gate, after the redactions, on every step whether or
 * not anyone is watching. This overlay is for a human, on the live page, behind a toggle,
 * and the capture pipeline knows nothing about it.
 *
 * They were the same thing by accident once, and that was a bug: the planner's input
 * changed depending on whether somebody had ticked a debug checkbox. Keep them separate.
 * Different consumer, different lifetime.
 */

import type { Box } from '../shared/coords';
import type { ObservedElement } from '../shared/observed';

const HOST_ID = 'sih-redaction-gate-overlay';

/** Per role, so a mis-scored element is obvious at a glance. */
const ROLE_COLOURS: Record<string, string> = {
  button: '#1b6feb',
  link: '#7d3cc7',
  textbox: '#17794a',
  searchbox: '#17794a',
  combobox: '#b06000',
  listbox: '#b06000',
  checkbox: '#0b7285',
  radio: '#0b7285',
  iframe: '#b3261e',
};

const DEFAULT_COLOUR = '#5b6472';

const STYLE = `
  :host { all: initial; }
  .box {
    position: fixed;
    box-sizing: border-box;
    border: 1.5px solid var(--c);
    border-radius: 2px;
    pointer-events: none;
    z-index: 2147483646;
  }
  .box[data-new='1'] { border-style: dashed; border-width: 2px; }
  .box[data-occluded='1'] { opacity: 0.45; }
  .badge {
    position: fixed;
    transform: translate(-2px, -100%);
    padding: 0 3px;
    font: 600 10px/1.4 ui-monospace, monospace;
    color: #fff;
    background: var(--c);
    border-radius: 2px 2px 0 0;
    white-space: nowrap;
    pointer-events: none;
    z-index: 2147483647;
  }
`;

/** One thing the overlay put on screen. */
export interface DrawnBox {
  index?: number;
  role: string;
  box: Box;
  isNew: boolean;
  occluded: number;
  /** The badge's text, or undefined where no badge was drawn. */
  badge?: string;
}

export interface Overlay {
  draw(elements: ObservedElement[]): void;
  clear(): void;
  destroy(): void;
  readonly visible: boolean;
  /**
   * What the last draw put on screen, as data.
   *
   * The shadow root stays closed -- the page must not be able to reach into the
   * operator's view of it, and neither must anything else -- but "closed" should not
   * mean "unverifiable". This is the seam for the alignment tests and for M10's
   * side-by-side, which needs to line these boxes up against the redacted frame.
   */
  drawn(): DrawnBox[];
}

export function createOverlay(doc: Document): Overlay {
  let host: HTMLElement | null = null;
  let root: ShadowRoot | null = null;
  let layer: HTMLElement | null = null;
  let lastDrawn: DrawnBox[] = [];

  function mount(): ShadowRoot {
    if (root && layer) return root;

    host = doc.createElement('div');
    host.id = HOST_ID;
    // The host itself must occupy no space and intercept nothing.
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    host.setAttribute('aria-hidden', 'true');

    // Closed: the page cannot reach in, and our own next walk will not walk it.
    root = host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = STYLE;
    layer = doc.createElement('div');
    root.append(style, layer);
    doc.documentElement.append(host);
    return root;
  }

  return {
    get visible() {
      return host !== null;
    },

    draw(elements) {
      mount();
      if (!layer) return;
      layer.replaceChildren();
      lastDrawn = [];

      for (const el of elements) {
        const colour = ROLE_COLOURS[el.role] ?? DEFAULT_COLOUR;

        const box = doc.createElement('div');
        box.className = 'box';
        box.style.setProperty('--c', colour);
        box.style.left = `${el.box.x}px`;
        box.style.top = `${el.box.y}px`;
        box.style.width = `${el.box.w}px`;
        box.style.height = `${el.box.h}px`;
        if (el.isNew) box.dataset.new = '1';
        if (el.occluded > 0) box.dataset.occluded = '1';
        layer.append(box);

        if (el.index === undefined) {
          lastDrawn.push({
            role: el.role,
            box: el.box,
            isNew: el.isNew,
            occluded: el.occluded,
          });
          continue;
        }

        const badgeText = `${el.isNew ? '*' : ''}${el.index}`;
        lastDrawn.push({
          index: el.index,
          role: el.role,
          box: el.box,
          isNew: el.isNew,
          occluded: el.occluded,
          badge: badgeText,
        });

        const badge = doc.createElement('div');
        badge.className = 'badge';
        badge.style.setProperty('--c', colour);
        badge.style.left = `${el.box.x}px`;
        badge.style.top = `${el.box.y}px`;
        badge.textContent = badgeText;
        layer.append(badge);
      }
    },

    clear() {
      layer?.replaceChildren();
      lastDrawn = [];
    },

    destroy() {
      host?.remove();
      host = null;
      root = null;
      layer = null;
      lastDrawn = [];
    },

    drawn: () => lastDrawn.map((d) => ({ ...d, box: { ...d.box } })),
  };
}

/** The overlay's own host, so the walker can skip it. */
export function isOverlayHost(el: Element): boolean {
  return el.id === HOST_ID;
}
