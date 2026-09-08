/**
 * The side panel shell: which view is showing, and what it costs to have the others.
 *
 * Two properties are worth holding still, and both were decisions rather than defaults.
 *
 * A view is loaded on first reveal and never torn down. The side-by-side view holds object
 * URLs for the pre-gate frames -- the only copy of an unredacted screenshot anywhere in
 * the session -- and revoking those on a tab switch would take the evidence away the
 * moment someone looked at something else. But it is not loaded *up front*: an unopened
 * view costs a document, a bus listener and, in the HUD's case, a poll twice a second, and
 * a panel that samples resources while reporting idle CPU is a bug to explain on stage.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

/** The shell's markup, minus the styling that has no behaviour. */
const SHELL = `<!doctype html><body>
  <nav>
    <button id="tab-agent" role="tab" aria-selected="true"></button>
    <button id="tab-sent" role="tab" aria-selected="false"></button>
    <button id="tab-resources" role="tab" aria-selected="false"></button>
  </nav>
  <div class="views">
    <iframe id="view-agent" src="popup.html"></iframe>
    <iframe id="view-sent" hidden></iframe>
    <iframe id="view-resources" hidden></iframe>
  </div>
</body>`;

async function shell() {
  const dom = new JSDOM(SHELL, { url: 'chrome-extension://abc/panel.html' });
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.location = dom.window.location;
  globals.MessageEvent = dom.window.MessageEvent;

  vi.resetModules();
  const panel = await import('./index');
  return { dom, panel };
}

function frame(dom: JSDOM, id: string): HTMLIFrameElement {
  return dom.window.document.getElementById(id) as HTMLIFrameElement;
}

function tab(dom: JSDOM, id: string): HTMLButtonElement {
  return dom.window.document.getElementById(id) as HTMLButtonElement;
}

let dom: JSDOM;
let panel: typeof import('./index');

beforeEach(async () => {
  ({ dom, panel } = await shell());
});

describe('which view is showing', () => {
  it('opens on the agent, with nothing else loaded', () => {
    expect(tab(dom, 'tab-agent').getAttribute('aria-selected')).toBe('true');
    expect(frame(dom, 'view-agent').hidden).toBe(false);

    // An unopened view has no src at all, so it has no document, no bus listener and no
    // poll. This is the whole reason the shell lazy-loads rather than mounting three.
    expect(frame(dom, 'view-sent').getAttribute('src')).toBeNull();
    expect(frame(dom, 'view-resources').getAttribute('src')).toBeNull();
  });

  it('loads a view the first time it is shown', () => {
    panel.show('sent');

    expect(frame(dom, 'view-sent').getAttribute('src')).toBe('sidebyside.html');
    expect(frame(dom, 'view-sent').hidden).toBe(false);
    expect(frame(dom, 'view-agent').hidden).toBe(true);
    expect(tab(dom, 'tab-sent').getAttribute('aria-selected')).toBe('true');
    expect(tab(dom, 'tab-agent').getAttribute('aria-selected')).toBe('false');
  });

  /**
   * The one that matters. `sidebyside.html` adopts the pre-gate frame into an object URL
   * of its own and revokes it on `pagehide`; reloading the frame to switch back to it
   * would drop every step it was holding.
   */
  it('does not reload a view that has already been opened', () => {
    panel.show('sent');
    const first = frame(dom, 'view-sent');
    first.setAttribute('data-touched', 'yes');

    panel.show('agent');
    panel.show('sent');

    expect(frame(dom, 'view-sent').getAttribute('data-touched')).toBe('yes');
    expect(frame(dom, 'view-sent').getAttribute('src')).toBe('sidebyside.html');
  });

  it('switches on a click of the tab', () => {
    tab(dom, 'tab-resources').dispatchEvent(new dom.window.Event('click'));

    expect(frame(dom, 'view-resources').getAttribute('src')).toBe('hud.html');
    expect(frame(dom, 'view-resources').hidden).toBe(false);
  });
});

describe('a framed view asking to be shown', () => {
  function post(data: unknown, origin = dom.window.location.origin): void {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, origin }));
  }

  it('honours the popup asking for the evidence view', () => {
    post({ sih: 'show-view', view: 'sent' });
    expect(frame(dom, 'view-sent').hidden).toBe(false);
  });

  /**
   * A framed page is a message source like any other. These frames are all extension
   * pages, and nothing from another origin gets to drive the panel -- a page the agent is
   * driving must not be able to move the operator's view of what it did.
   */
  it('ignores a message from another origin', () => {
    post({ sih: 'show-view', view: 'sent' }, 'https://example.test');
    expect(frame(dom, 'view-sent').hidden).toBe(true);
  });

  it('ignores a message that is not ours, and an unknown view name', () => {
    post({ type: 'something-else' });
    post({ sih: 'show-view', view: 'nope' });
    expect(frame(dom, 'view-sent').hidden).toBe(true);
    expect(frame(dom, 'view-resources').hidden).toBe(true);
  });
});
