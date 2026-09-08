/**
 * The side panel: one docked surface instead of a popup and two browser tabs.
 *
 * The three views this project has -- drive the agent, see what was sent, watch the
 * resources -- used to be three places. The popup closed the moment focus moved, which is
 * the wrong container for anything a judge is asked to read; the other two opened as
 * browser tabs, which meant looking away from the page the agent was driving in order to
 * see what the agent had done to it. A docked panel fixes both: it sits beside the page,
 * it survives clicks into the page, and the evidence is a tab away rather than a window
 * away.
 *
 * ## Why frames rather than one merged document
 *
 * Each view is an existing page that already works, holds its own state, and can still be
 * opened full-screen for a projector. Merging them into one document would mean three
 * modules sharing one id namespace -- and they collide immediately: the popup's `#host`
 * is the inference-host readout, the HUD's `#host` is a table of adapter limits. Silently
 * wiring one module's query to another module's element is a class of bug that would be
 * found on stage.
 *
 * The bus does not mind. `chrome.runtime.sendMessage` fans out to every extension page,
 * each drops what is not addressed to it, and the side-by-side page and the HUD already
 * both answer for 'panel' -- that is how they worked as two open tabs, and it is unchanged
 * by their being framed here.
 *
 * ## What is loaded when
 *
 * Only the agent view up front. The other two cost a document, a bus listener and, in the
 * HUD's case, a poll every 500 ms; none of that is worth paying for a tab nobody has
 * opened. Once opened they stay mounted, because the side-by-side view holds object URLs
 * for the pre-gate frames -- which exist nowhere else in the session -- and tearing its
 * document down to switch tabs would revoke them.
 */

/** Which page backs each tab, and where it is loaded from. */
const VIEWS = {
  agent: { tab: 'tab-agent', frame: 'view-agent', src: 'agent.html' },
  sent: { tab: 'tab-sent', frame: 'view-sent', src: 'sidebyside.html' },
  resources: { tab: 'tab-resources', frame: 'view-resources', src: 'hud.html' },
} as const;

export type ViewName = keyof typeof VIEWS;

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function show(name: ViewName): void {
  for (const [key, view] of Object.entries(VIEWS) as Array<
    [ViewName, (typeof VIEWS)[ViewName]]
  >) {
    const selected = key === name;
    const tab = el<HTMLButtonElement>(view.tab);
    const frame = el<HTMLIFrameElement>(view.frame);
    if (tab) tab.setAttribute('aria-selected', String(selected));
    if (!frame) continue;

    // Load on first reveal, then leave it alone.
    if (selected && !frame.getAttribute('src')) frame.setAttribute('src', view.src);
    frame.hidden = !selected;
  }
}

/**
 * The framed views ask to be shown by name.
 *
 * The popup's two evidence buttons open a browser tab when the popup is standing on its
 * own and switch tabs when it is inside this panel; it cannot tell which without asking,
 * so it posts and this answers. Origin is checked because a framed page is a message
 * source like any other -- these frames are all extension pages, and nothing outside the
 * extension origin gets to drive the panel.
 */
function onMessage(event: MessageEvent): void {
  if (event.origin !== location.origin) return;
  const data = event.data as { sih?: string; view?: string } | null;
  if (data?.sih !== 'show-view') return;
  if (data.view && data.view in VIEWS) show(data.view as ViewName);
}

export function main(): void {
  for (const [key, view] of Object.entries(VIEWS) as Array<
    [ViewName, (typeof VIEWS)[ViewName]]
  >) {
    el<HTMLButtonElement>(view.tab)?.addEventListener('click', () => show(key));
  }
  window.addEventListener('message', onMessage);
  show('agent');
}

main();
