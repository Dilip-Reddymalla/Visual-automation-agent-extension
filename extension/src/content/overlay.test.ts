import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { createOverlay, isOverlayHost } from './overlay';
import { perceive } from './perceive';
import { fixture, page } from './fixture';
import type { ObservedElement } from '../shared/observed';

function el(over: Partial<ObservedElement> = {}): ObservedElement {
  return {
    index: 1,
    role: 'button',
    box: { x: 10, y: 20, w: 100, h: 30 },
    state: { visible: true, enabled: true, focused: false, filled: false },
    occluded: 0,
    isNew: false,
    tag: 'button',
    key: 'k',
    name: 'Save',
    textRuns: [],
    ...over,
  };
}

function overlay() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  return { doc: dom.window.document, overlay: createOverlay(dom.window.document) };
}

describe('what the overlay draws', () => {
  it('reports a box and a badge per indexed element', () => {
    const o = overlay();
    o.overlay.draw([
      el(),
      el({ index: 2, box: { x: 200, y: 40, w: 80, h: 24 }, role: 'link' }),
    ]);

    expect(o.overlay.drawn()).toEqual([
      {
        index: 1,
        role: 'button',
        box: { x: 10, y: 20, w: 100, h: 30 },
        isNew: false,
        occluded: 0,
        badge: '1',
      },
      {
        index: 2,
        role: 'link',
        box: { x: 200, y: 40, w: 80, h: 24 },
        isNew: false,
        occluded: 0,
        badge: '2',
      },
    ]);
  });

  it('draws the boxes exactly where the elements are -- no conversion at all', () => {
    // Boxes are CSS px of the visual viewport and the host is position:fixed, whose
    // coordinate system is the same one. Any arithmetic here would be a bug.
    const o = overlay();
    const box = { x: 317.5, y: 212.25, w: 84.75, h: 31.5 };
    o.overlay.draw([el({ box })]);
    expect(o.overlay.drawn()[0]?.box).toEqual(box);
  });

  it('stars a newcomer in the badge', () => {
    const o = overlay();
    o.overlay.draw([el({ isNew: true, index: 9 })]);
    expect(o.overlay.drawn()[0]?.badge).toBe('*9');
  });

  it('draws a visual-only element without a badge', () => {
    const o = overlay();
    o.overlay.draw([el({ index: undefined })]);
    const drawn = o.overlay.drawn()[0];
    expect(drawn?.badge).toBeUndefined();
    expect(drawn?.index).toBeUndefined();
  });

  it('carries occlusion through, so a dimmed box is explainable', () => {
    const o = overlay();
    o.overlay.draw([el({ occluded: 0.4 })]);
    expect(o.overlay.drawn()[0]?.occluded).toBe(0.4);
  });

  it('hands out copies, not its own state', () => {
    const o = overlay();
    o.overlay.draw([el()]);
    const first = o.overlay.drawn();
    const box = first[0]?.box;
    if (box) box.x = 9999;
    expect(o.overlay.drawn()[0]?.box.x).toBe(10);
  });

  it('replaces the previous draw rather than accumulating', () => {
    const o = overlay();
    o.overlay.draw([el(), el({ index: 2 })]);
    o.overlay.draw([el()]);
    expect(o.overlay.drawn()).toHaveLength(1);
  });

  it('forgets everything when cleared or destroyed', () => {
    const o = overlay();
    o.overlay.draw([el()]);
    o.overlay.clear();
    expect(o.overlay.drawn()).toEqual([]);

    o.overlay.draw([el()]);
    o.overlay.destroy();
    expect(o.overlay.drawn()).toEqual([]);
    expect(o.overlay.visible).toBe(false);
  });
});

describe('staying out of its own way', () => {
  it('mounts one host and keeps the shadow root closed', () => {
    const o = overlay();
    o.overlay.draw([el()]);

    const hosts = [...o.doc.querySelectorAll('div')].filter(isOverlayHost);
    expect(hosts).toHaveLength(1);
    // Closed: the page cannot reach in, and neither can a test. `drawn()` exists so
    // that does not mean unverifiable.
    expect(hosts[0]?.shadowRoot).toBeNull();
  });

  it('is invisible to the walker, so it never perceives itself', () => {
    const f = fixture(page(`<button data-box="10,10,80,30">Real</button>`));
    const o = createOverlay(f.doc);
    o.draw([el()]);

    const names = perceive(f.env).observed.map((e) => e.name);
    expect(names).toEqual(['Real']);
  });
});
