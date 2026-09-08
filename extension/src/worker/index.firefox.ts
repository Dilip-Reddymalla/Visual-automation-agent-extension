/**
 * Background event-page entry point, Firefox.
 *
 * Firefox has no chrome.offscreen and does not need one: this page has a real DOM, so
 * it is both the router and the inference host. That is the only structural difference
 * between the two builds, and it lives here rather than in a branch -- see
 * worker/main.ts for why.
 */

import { firefoxAdapter } from '../offscreen/adapters/firefox';
import { disposeHost, installInferenceHandlers } from '../offscreen/handlers';
import { startWorker } from './main';

startWorker({
  // This page answers for the host as well as itself; see platform/chrome-bus.ts.
  accepts: ['worker', 'offscreen'],
  install: () => installInferenceHandlers(firefoxAdapter().runtime()),
  ensure: async () => undefined, // already here
  release: disposeHost,
});
