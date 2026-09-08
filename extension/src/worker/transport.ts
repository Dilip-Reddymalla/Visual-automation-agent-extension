/**
 * The single network call in the project.
 *
 * Everything before this point is about making the payload safe to send; this file is
 * about not sending anything else. Three gates, in order, and none of them optional:
 *
 *   1. The receipt is re-verified against the bytes as they actually are, here, in a
 *      different process from the gate that produced them (worker/receipt.ts). A
 *      mismatch is not a warning and not a retry -- nothing leaves.
 *   2. The body is validated against the Zod schema before it goes out, and the reply
 *      after it comes back. A schema failure is a retryable error rather than an
 *      exception that kills the run: a planner that returns malformed JSON once is
 *      common and is not a reason to abandon the task.
 *   3. One retry on a network failure, then the error surfaces to the popup.
 *
 * `fetch` is injected so this is testable in Node -- and so the one place that can
 * reach the network is a parameter rather than an ambient global.
 */

import { StepRequestSchema, StepResponseSchema } from '../shared/contract';
import type { StepRequest, StepResponse } from '../shared/contract';
import { verifyReceipt } from './receipt';

export const DEFAULT_ENDPOINT = 'http://localhost:8000/v1/step';

/** One retry, one second apart. Enough for a restarting server, short enough to feel. */
export const RETRY_DELAY_MS = 1_000;
export const MAX_ATTEMPTS = 2;

/**
 * How long the plan phase gets, in total, across both attempts.
 *
 * `fetch` has no timeout of its own. A planner that refuses the connection fails in
 * milliseconds and is easy to diagnose; a planner that *accepts* it and then never
 * answers -- a model still loading, a vLLM worker wedged, a laptop that went to sleep
 * mid-generation -- hangs the phase for as long as the browser will hold the socket.
 * From the popup that is indistinguishable from a step working: the status reads `plan`
 * and simply never changes. It was the first thing this project's own end-to-end run
 * did, and no amount of reading the log said which of the two had happened.
 *
 * Sixty seconds is chosen against the slowest planner the README offers rather than the
 * fastest: qwen3-vl:4b on a laptop CPU takes tens of seconds for a step and must not be
 * cut off mid-answer. `stub` and a GPU vLLM are an order of magnitude inside it.
 *
 * It is a budget for the whole call, not per attempt, so the worst case a step can cost
 * stays a number you can state -- which is what STALE_STEP_MS has to be larger than.
 */
export const PLAN_TIMEOUT_MS = 60_000;

export type TransportFailure =
  /** The bytes do not match the manifest. Never retried; nothing was sent. */
  | 'receipt-mismatch'
  /** Our own request did not satisfy the schema. A bug here, not out there. */
  | 'invalid-request'
  /** The planner's reply did not. Retryable: models produce bad JSON occasionally. */
  | 'invalid-response'
  | 'network'
  | 'http-error'
  | 'aborted';

export class TransportError extends Error {
  constructor(
    readonly kind: TransportFailure,
    message: string,
    readonly retryable: boolean,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface TransportDeps {
  fetch: typeof fetch;
  endpoint?: string;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Total budget across attempts. Tests pass a small one; nothing else sets it. */
  timeoutMs?: number;
}

export interface PostResult {
  response: StepResponse;
  requestBytes: number;
  responseBytes: number;
  attempts: number;
}

/**
 * Send one step and return the plan.
 *
 * The image bytes go as a multipart part rather than base64 in the JSON. A 120 KB frame
 * becomes 160 KB of base64 and has to be decoded twice for no benefit -- and the wire
 * format already carries the digest that binds the two parts together.
 */
export async function postStep(
  request: StepRequest,
  imageBytes: Uint8Array,
  deps: TransportDeps,
): Promise<PostResult> {
  // 1. Nothing is sent until the bytes match the manifest that describes them.
  const verdict = await verifyReceipt(imageBytes, request.manifest);
  if (!verdict.ok) {
    throw new TransportError(
      'receipt-mismatch',
      `refusing to transmit: ${verdict.reason ?? 'receipt did not verify'}`,
      false,
      verdict.detail,
    );
  }

  // 2. Our own body, validated before it becomes someone else's problem.
  const parsedRequest = StepRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new TransportError('invalid-request', 'outbound body failed validation', false, {
      issues: parsedRequest.error.issues.slice(0, 5),
    });
  }

  const body = new FormData();
  const json = JSON.stringify(parsedRequest.data);
  body.append('step', json);
  body.append(
    'capture',
    new Blob([new Uint8Array(imageBytes)], { type: request.capture.mime }),
    'capture',
  );

  const endpoint = deps.endpoint ?? DEFAULT_ENDPOINT;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  // One deadline for the whole call, and its own controller so a timeout can be told
  // apart from the operator pressing Stop. Both abort the same fetch; only one of them
  // means the run is over.
  const deadline = new AbortController();
  const expiry = setTimeout(() => deadline.abort(), deps.timeoutMs ?? PLAN_TIMEOUT_MS);
  const onStop = (): void => deadline.abort();
  deps.signal?.addEventListener('abort', onStop, { once: true });

  let lastError: TransportError | null = null;

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const reply = await deps.fetch(endpoint, {
          method: 'POST',
          body,
          signal: deadline.signal,
        });

        const text = await reply.text();
        if (!reply.ok) {
          lastError = new TransportError(
            'http-error',
            `planner returned ${reply.status}`,
            reply.status >= 500,
            { status: reply.status },
          );
          if (!lastError.retryable) throw lastError;
        } else {
          const parsed = parseResponse(text);
          return {
            response: parsed,
            requestBytes: json.length + imageBytes.byteLength,
            responseBytes: text.length,
            attempts: attempt,
          };
        }
      } catch (err) {
        if (err instanceof TransportError) {
          if (!err.retryable) throw err;
          lastError = err;
        } else if (err instanceof Error && err.name === 'AbortError') {
          // Both aborts land here and they are different events. The operator's Stop ends
          // the run; the deadline expiring is a planner that accepted the connection and
          // then said nothing, which is a network failure like any other and reads as one.
          if (deps.signal?.aborted) {
            throw new TransportError('aborted', 'the step was stopped', false);
          }
          throw new TransportError(
            'network',
            `the planner at ${endpoint} accepted the request and did not answer within ` +
              `${Math.round((deps.timeoutMs ?? PLAN_TIMEOUT_MS) / 1000)}s`,
            true,
            { endpoint, timedOut: true },
          );
        } else {
          // `fetch` reports a refused connection, a DNS failure and a dropped handshake as
          // the same opaque "Failed to fetch", which is the least useful string in the
          // project: the first real end-to-end run died on it, and the cause -- the planner
          // was simply not running -- took a port scan to establish. The endpoint is the one
          // piece of context that makes the message diagnosable, and it is configuration
          // rather than user data, so it is safe to put in front of the operator.
          const detail = err instanceof Error ? err.message : String(err);
          lastError = new TransportError(
            'network',
            `no answer from the planner at ${endpoint} (${detail}) -- is the server running? server/README.md has the command`,
            true,
            { endpoint },
          );
        }
      }

      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }

    throw lastError ?? new TransportError('network', 'the request failed', true);
  } finally {
    clearTimeout(expiry);
    deps.signal?.removeEventListener('abort', onStop);
  }
}

/**
 * Parse and validate a reply.
 *
 * A malformed plan is a retryable error, not a crash: an open-weights model returning
 * something that is nearly JSON is an ordinary Tuesday, and the correct response is to
 * ask again rather than to end the run.
 */
export function parseResponse(text: string): StepResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new TransportError(
      'invalid-response',
      `planner returned something that is not JSON: ${err instanceof Error ? err.message : ''}`,
      true,
    );
  }

  const parsed = StepResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TransportError('invalid-response', 'planner reply failed validation', true, {
      issues: parsed.error.issues.slice(0, 5),
    });
  }
  return parsed.data;
}
