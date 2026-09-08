/**
 * The browser-flavoured bus transport. One implementation, four contexts.
 *
 * Routing, because the two APIs are not interchangeable:
 *   to 'content'                 chrome.tabs.sendMessage(tabId, ...) -- content scripts
 *                                are not reachable by runtime.sendMessage.
 *   to 'worker' | 'offscreen'    chrome.runtime.sendMessage, which fans out to every
 *   | 'popup'                    extension page except the sender. Each listener drops
 *                                envelopes not addressed to it, so exactly one answers.
 *
 * `accepts` is how Firefox works at all. There is no chrome.offscreen there, so the
 * background event page *is* the inference host: its transport accepts both 'worker'
 * and 'offscreen', and a message addressed to 'offscreen' is delivered in-process
 * instead of being broadcast to a document that does not exist.
 *
 * `api` is injectable so the transport can be exercised in Node against a fake hub --
 * see chrome-bus.test.ts. Nothing else in the project fakes chrome.
 */

import {
  isEnvelope,
  type BusTransport,
  type Context,
  type Envelope,
  type Reply,
} from '../shared/messages';

type SendResponse = (reply?: unknown) => void;

type RuntimeListener = (
  message: unknown,
  sender: unknown,
  sendResponse: SendResponse,
) => boolean | undefined;

/** The slice of the extension API this transport needs. */
export interface MessagingApi {
  runtime: {
    sendMessage(message: unknown, callback: SendResponse): void;
    onMessage: {
      addListener(listener: RuntimeListener): void;
      removeListener(listener: RuntimeListener): void;
    };
    readonly lastError?: { message?: string } | undefined;
  };
  tabs?: {
    sendMessage(tabId: number, message: unknown, callback: SendResponse): void;
  };
}

export interface TransportOptions {
  api?: MessagingApi;
  /** Contexts this endpoint answers for. Defaults to just its own. */
  accepts?: Context[];
}

function defaultApi(): MessagingApi {
  return chrome as unknown as MessagingApi;
}

function isReply(value: unknown): value is Reply {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as { id?: unknown; ok?: unknown };
  return typeof r.id === 'string' && typeof r.ok === 'boolean';
}

export function createChromeTransport(
  context: Context,
  options: TransportOptions = {},
): BusTransport {
  const api = options.api ?? defaultApi();
  const accepts = options.accepts ?? [context];
  let local: ((envelope: Envelope) => Promise<Reply>) | null = null;

  return {
    post(envelope: Envelope): Promise<Reply> {
      // Addressed to a role this endpoint also plays: never put it on the wire.
      if (accepts.includes(envelope.to)) {
        if (!local) return Promise.reject(new Error(`bus: ${context} is not listening yet`));
        return local(envelope);
      }

      return new Promise<Reply>((resolve, reject) => {
        const callback: SendResponse = (raw) => {
          // Must be read inside the callback, before anything awaits.
          const lastError = api.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message ?? `bus: ${envelope.type} failed in transit`));
            return;
          }
          if (!isReply(raw)) {
            reject(new Error(`bus: ${envelope.type} got no reply from ${envelope.to}`));
            return;
          }
          resolve(raw);
        };

        if (envelope.to === 'content') {
          if (envelope.tabId === undefined || !api.tabs) {
            reject(new Error(`bus: cannot reach a content script from ${context}`));
            return;
          }
          api.tabs.sendMessage(envelope.tabId, envelope, callback);
          return;
        }
        api.runtime.sendMessage(envelope, callback);
      });
    },

    listen(handler: (envelope: Envelope) => Promise<Reply>): () => void {
      local = handler;

      const listener: RuntimeListener = (message, _sender, sendResponse) => {
        if (!isEnvelope(message)) return undefined;
        // Not ours. Returning undefined leaves the message for whoever it is for.
        if (!accepts.includes(message.to)) return undefined;

        handler(message).then(sendResponse, (err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err));
          sendResponse({
            id: message.id,
            ok: false,
            error: { message: e.message, stack: e.stack },
          } satisfies Reply);
        });
        // Keeps the response channel open for the async reply above.
        return true;
      };

      api.runtime.onMessage.addListener(listener);
      return () => {
        local = null;
        api.runtime.onMessage.removeListener(listener);
      };
    },
  };
}
