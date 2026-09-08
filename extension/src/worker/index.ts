/**
 * Service-worker entry point, Chrome.
 *
 * The host is a separate offscreen document here, so this bundle contains no model
 * code at all -- it creates the document, closes it, and otherwise routes. Keeping
 * onnxruntime-web out of the service worker is the difference between a wake that
 * parses a few kilobytes and one that parses half a megabyte, and MV3 wakes this
 * bundle constantly.
 */

import { closeOffscreenDocument, ensureOffscreenDocument } from '../platform/offscreen';
import { startWorker } from './main';

startWorker({
  accepts: ['worker'],
  install: () => undefined,
  ensure: ensureOffscreenDocument,
  // Closing the document takes the GPU context and the WASM heap with it.
  release: closeOffscreenDocument,
});
