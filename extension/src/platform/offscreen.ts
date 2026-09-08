/**
 * Bringing the inference host up, and taking it back down.
 *
 * Chrome: create the offscreen document, once, and reuse it. The reason is invariant 8
 * -- the service worker has neither WebGPU nor the ORT WASM backend, so every model
 * call has to land somewhere with a real document.
 *
 * Firefox: there is no chrome.offscreen and none is needed. The background event page
 * already has a DOM, and it is already running this code, so both calls are no-ops.
 *
 * Closing matters as much as opening. A session that has stopped should leave nothing
 * resident: the registry unloads its models after 60 idle seconds, and closing the
 * document itself takes the GPU context and the WASM heap with it. Idle GPU memory has
 * to reach zero, not merely get small.
 */

const OFFSCREEN_PATH = 'offscreen.html';

type OffscreenApi = {
  createDocument(options: {
    url: string;
    reasons: string[];
    justification: string;
  }): Promise<void>;
  closeDocument(): Promise<void>;
};

type ContextsApi = {
  getContexts(filter: { contextTypes: string[] }): Promise<unknown[]>;
};

let creating: Promise<void> | null = null;

function offscreenApi(): OffscreenApi | undefined {
  return (chrome as unknown as { offscreen?: OffscreenApi }).offscreen;
}

async function alreadyOpen(): Promise<boolean> {
  const runtime = chrome.runtime as unknown as Partial<ContextsApi>;
  if (typeof runtime.getContexts !== 'function') return false;
  const contexts = await runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

/**
 * Idempotent, and safe to call concurrently: two phases asking at once share one
 * creation. Creating a second offscreen document throws, and that error would surface
 * as a failed step for no reason.
 */
export async function ensureOffscreenDocument(): Promise<void> {
  const api = offscreenApi();
  if (!api) return; // Firefox: the event page is the host.
  if (await alreadyOpen()) return;
  if (creating) return creating;

  creating = api
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS'],
      justification:
        'Runs on-device vision and PII models; WebGPU is unavailable in MV3 service workers.',
    })
    .finally(() => {
      creating = null;
    });

  return creating;
}

/** Tear the host down. Safe to call when there is nothing to close. */
export async function closeOffscreenDocument(): Promise<void> {
  const api = offscreenApi();
  if (!api) return;
  if (!(await alreadyOpen())) return;
  try {
    await api.closeDocument();
  } catch {
    // Racing another close is not a failure worth propagating into a step.
  }
}
