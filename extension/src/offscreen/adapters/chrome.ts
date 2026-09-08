/**
 * Chrome adapter: the offscreen document.
 *
 * The document itself is created by the worker (platform/offscreen.ts) -- only the
 * worker can call chrome.offscreen. What this file owns is the other half: where the
 * weights come from once the document is up. `chrome.runtime.getURL`, always, because
 * nothing in this extension is fetched from a CDN (CLAUDE.md invariant 4).
 */

import { createOrtRuntime } from '../runtime-ort';
import type { OrtRuntime } from '../host';

export interface HostAdapter {
  /** Absolute URL for a bundled resource, e.g. "models/ner.onnx". */
  resourceUrl(path: string): string;
  /** The ONNX runtime, configured for this browser. */
  runtime(): OrtRuntime;
}

export function chromeAdapter(): HostAdapter {
  const resourceUrl = (path: string): string => chrome.runtime.getURL(path);
  return {
    resourceUrl,
    runtime: () => createOrtRuntime({ resourceUrl }),
  };
}
