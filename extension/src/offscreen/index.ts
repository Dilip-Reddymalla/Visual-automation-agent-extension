/**
 * Offscreen-document entry point (Chrome). This is where inference lives -- never the
 * service worker, which has neither WebGPU nor the ORT WASM backend (CLAUDE.md
 * invariant 8).
 *
 * Firefox never loads this file. Its background event page has a real DOM, so it
 * installs the same handlers in-process; see worker/index.ts and platform/target.ts.
 *
 * Nothing is loaded here. The host is built on the first message that needs it, the
 * backend is probed then, and the sessions unload themselves 60 seconds later. An open
 * offscreen document with no work to do holds no model, no GPU context and no timer.
 */

import { createChromeTransport } from '../platform/chrome-bus';
import { setBusTransport } from '../shared/messages';
import { chromeAdapter } from './adapters/chrome';
import { installInferenceHandlers } from './handlers';
import { setPanelNotifier } from './panel';
import { send } from '../shared/messages';

export function main(): void {
  setBusTransport(createChromeTransport('offscreen'), 'offscreen');
  installInferenceHandlers(chromeAdapter().runtime());

  // A panel may or may not be open, and a run without one is the normal case. So the
  // failure is swallowed: this is a push to a listener that is usually absent, not a
  // step of the pipeline.
  setPanelNotifier(async (step) => {
    try {
      await send('PANEL_STEP_ADDED', step, { to: 'panel' });
    } catch {
      return;
    }
  });
  console.debug('[sih] offscreen inference host ready (nothing loaded)');
}

main();
