/**
 * Firefox adapter: the background event page, which has a real DOM and therefore needs
 * no chrome.offscreen at all. Same runtime, same weights, same code above it -- the
 * only difference in the whole project is which page the host is imported into.
 *
 * The one messaging consequence is that this endpoint answers for two contexts at once;
 * see platform/chrome-bus.ts, `accepts`.
 */

import { createOrtRuntime } from '../runtime-ort';
import type { OrtRuntime } from '../host';
import type { HostAdapter } from './chrome';

export function firefoxAdapter(): HostAdapter {
  const resourceUrl = (path: string): string => chrome.runtime.getURL(path);
  return {
    resourceUrl,
    runtime: () => createOrtRuntime({ resourceUrl }),
  };
}

export type { HostAdapter, OrtRuntime };
