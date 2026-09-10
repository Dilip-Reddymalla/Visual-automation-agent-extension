/**
 * Tier 1: a model on the user's own machine, asked one question.
 *
 * It runs only when Tier 0 found more than one plausible field, or none above the floor.
 * That is a narrow job and the prompt is built to keep it narrow: the user's sentence, a
 * numbered shortlist, and a demand for one integer. A 0.6B model can pick from four
 * labelled options; the same model asked for a plan produces schema-valid nonsense, which
 * is measured rather than assumed (scripts/bench-planners.py).
 *
 * Being local is the point rather than an implementation detail. This tier sees the
 * sentence as the user typed it, values and all, because it never leaves the machine --
 * which is exactly why it may be shown things Tier 2 may not.
 *
 * Unavailable is a normal outcome. Ollama not running, a model not pulled, a request that
 * takes too long: none of them fail the step. They fall through to Tier 2, and the step
 * log says Tier 1 was skipped so that a slow demo is diagnosable rather than mysterious.
 */

import type { Candidate } from './resolve';

/** Short. This is a tie-break, and a tie-break that takes a minute is worse than useless. */
export const LOCAL_TIMEOUT_MS = 15_000;

/**
 * The reader gets longer, because it is doing a larger job and often a cold one.
 *
 * Measured warm, the reader answers in 3.6s. The *first* call after Ollama starts also pays
 * for loading the model, and 15 seconds was not enough for that: the first real run of this
 * feature reported "the local model took too long" on the one step it was built for, which
 * is a timeout masquerading as a verdict.
 *
 * Still bounded, and still well under what the remote planner costs on this hardware.
 */
export const READER_TIMEOUT_MS = 45_000;

export const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:11434/v1/chat/completions';
export const DEFAULT_LOCAL_MODEL = 'qwen2.5:1.5b';

/**
 * The reader's model, which is deliberately not the tie-break's.
 *
 * Two different jobs with two different size requirements, measured rather than assumed
 * (`scripts/bench-reader.py`, against a real Ollama, eight sentences the grammar cannot
 * read):
 *
 *   qwen3:0.6b     0 right, 8 escalated, 0 wrong   3.5s
 *   qwen2.5:1.5b   2 right, 6 escalated, 0 wrong   3.6s
 *   qwen3:4b       3 right, 5 escalated, 0 wrong   7.0s
 *
 * The 0.6B can pick one of four labelled options, which is what `pickCandidate` asks of it.
 * It cannot read a sentence into a plan: it answers by putting the user's own instruction
 * into every box on the page. So the reader defaults a size up, to the smallest model that
 * gets anything right at all -- and if that model is not pulled, the request fails, the
 * caller escalates, and nothing is worse than it was before this existed.
 *
 * The "0 wrong" column is the one that made this shippable, and it is the guards' doing
 * rather than the models' -- see verify-plan.ts. Every model tried, including the 4B,
 * proposed at least one plan that would have typed nonsense into a real form.
 */
export const DEFAULT_READER_MODEL = 'qwen2.5:1.5b';

/**
 * Why a local call did not produce an answer.
 *
 * Every one of these used to be `null`, and the step log said "tier 1 declined" for all of
 * them. That sentence hid something worth knowing: Tier 1 had never once run in a real
 * browser. Ollama answers a `chrome-extension://` origin with **403**, because its CORS
 * allowlist does not include one by default, and the extension has been quietly falling
 * through to Tier 2 on every step since the rung was built. From the outside it looked
 * exactly like "the model considered it and passed".
 *
 * A tie-break that is switched off is a reasonable deployment. A tie-break that is switched
 * off *without anyone knowing* is a rung of the ladder that exists only in the architecture
 * diagram, and the whole point of this project's logging is that it does not do that.
 */
export type LocalFailure =
  /** Nothing listening on the endpoint. Ollama is not running. */
  | 'unreachable'
  /** Reached it, and it refused this origin. Set OLLAMA_ORIGINS. */
  | 'forbidden'
  /** Reached it, and the model is not pulled. */
  | 'no-model'
  /** It took longer than a tie-break is worth. */
  | 'timeout'
  /** It answered, and the answer was not usable. */
  | 'bad-answer';

/**
 * Every answer carries the model that gave it.
 *
 * Asked for, and right: a step log that says "tier 1" does not say which of two models on
 * this machine answered, and the two are a different size, a different job and a different
 * failure mode. "Tier 1 · qwen2.5:1.5b" is a sentence somebody can act on; "tier 1" is a
 * number somebody has to look up.
 */
export type LocalOutcome<T> =
  { ok: true; value: T; model: string } | { ok: false; why: LocalFailure; model: string };

/** What an operator should do about it. Shown in the panel, not only in the log. */
export function describeLocalFailure(why: LocalFailure): string {
  switch (why) {
    case 'unreachable':
      return 'the local model is not running (start ollama)';
    case 'forbidden':
      return (
        'ollama refused the extension (403) — it allows no browser-extension origin by ' +
        'default. Restart it with OLLAMA_ORIGINS set to chrome-extension://*'
      );
    case 'no-model':
      return 'ollama is running but the model is not pulled';
    case 'timeout':
      return 'the local model took too long';
    case 'bad-answer':
      return 'the local model answered with something unusable';
  }
}

/** HTTP status to cause. 403 is the one that matters and the one nobody was seeing. */
function failureFor(status: number): LocalFailure {
  if (status === 403) return 'forbidden';
  if (status === 404) return 'no-model';
  return 'bad-answer';
}

export interface LocalDeps {
  fetch: typeof fetch;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
}

async function fetchWithFallback(
  deps: LocalDeps,
  init: RequestInit,
): Promise<Response> {
  const primary = deps.endpoint ?? DEFAULT_LOCAL_ENDPOINT;
  try {
    return await deps.fetch(primary, init);
  } catch (err) {
    if (
      deps.fetch === globalThis.fetch &&
      !deps.endpoint &&
      primary.includes('localhost')
    ) {
      const fallback = primary.replace('localhost', '127.0.0.1');
      return await deps.fetch(fallback, init);
    }
    throw err;
  }
}

/**
 * One integer, or nothing.
 *
 * The schema is enforced rather than requested. A model told to "reply with a number"
 * replies with a sentence containing a number often enough to matter, and parsing prose is
 * how a tie-break becomes a second source of bugs.
 */
const REPLY_SCHEMA = {
  type: 'object',
  properties: { index: { type: 'integer' } },
  required: ['index'],
  additionalProperties: false,
} as const;

function buildPrompt(sentence: string, candidates: Candidate[]): string {
  const list = candidates
    .map((c) => `${c.index}: ${c.label || '(no label)'} (${c.role})`)
    .join('\n');
  return (
    `The user said: "${sentence}"\n\n` +
    `Which of these page elements did they mean?\n${list}\n\n` +
    `Reply with the number of the one element. Nothing else.`
  );
}

// -- Reading a sentence the grammar could not ---------------------------------

/**
 * Tier 1's second job: turn a sentence into actions when the grammar cannot.
 *
 * The grammar in `intent.ts` handles "fill X with Y" and refuses everything else, which is
 * the right trade for a rule you can read -- but it is still five patterns, and a person
 * typing at a task box is not consulting them. "Put my name down as Asha and send it off"
 * is an ordinary instruction and no regex is going to grow into it.
 *
 * So the same local model that breaks ties also gets asked the whole question: here is what
 * the user said, here are the fields on the page, what should happen? It runs on the user's
 * own machine, so it may see the sentence exactly as typed -- and nothing is sent, sealed or
 * photographed, so this is still a step that never leaves the device.
 *
 * ## Still not a free-text plan
 *
 * A list of `{index, text}`, schema-enforced, at most four. Every index must be one that was
 * offered and every value must be checkable against the sentence (see `verifyPlan` in the
 * caller). The model is choosing among things it was handed, not composing.
 */
export const MAX_LOCAL_ACTIONS = 4;

/**
 * The reply shape, with the verb named rather than inferred.
 *
 * The first version overloaded `text`: empty meant click, non-empty meant type. It reads
 * fine to a person and a 1.5B does not hold it -- asked to fill a name field, the model
 * answered `{"index": 70, "text": ""}`, which is "click the textbox". The guard caught it,
 * correctly, and the plan was refused for a reason that was really a prompt defect.
 *
 * An enum the schema enforces removes the convention entirely. There is nothing left to
 * misremember: the model says which of two things it means.
 */
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      maxItems: MAX_LOCAL_ACTIONS,
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          action: { type: 'string', enum: ['type', 'click', 'select'] },
          /** The value to type. Ignored, and expected empty, for a click. */
          text: { type: 'string' },
        },
        required: ['index', 'action', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['actions'],
  additionalProperties: false,
} as const;

const NORMALIZE_SCHEMA = {
  type: 'object',
  properties: {
    normalized: { type: 'string' },
  },
  required: ['normalized'],
  additionalProperties: false,
} as const;

export interface LocalAction {
  index: number;
  action: 'type' | 'click' | 'select';
  text: string;
}

function buildNormalizePrompt(sentence: string, candidates: Candidate[]): string {
  const list = candidates
    .filter((c) => c.label)
    .map((c) => `${c.label} (${c.role})`)
    .slice(0, 20)
    .join(', ');
  return (
    `A user gave an instruction on a web page:\n"${sentence}"\n\n` +
    (list ? `Available page fields: ${list}\n\n` : '') +
    `Convert this into clear, standard single/multi-clause format:\n` +
    `- "fill <field name> with <exact value>"\n` +
    `- "click <button name>"\n` +
    `- "select <option> in <dropdown name>"\n` +
    `Join multiple clauses with commas, e.g. "fill first name with dilip, fill last name with reddymalla".\n` +
    `Preserve all exact values from the user sentence without inventing anything.\n` +
    `Reply with JSON {"normalized": "..."}`
  );
}

/**
 * Ask the local model to rewrite / normalize an unparsed or casual user prompt into
 * standard Tier 0 grammar clauses.
 */
export async function normalizeGoal(
  sentence: string,
  candidates: Candidate[],
  deps: LocalDeps,
): Promise<LocalOutcome<string>> {
  const model = deps.model ?? DEFAULT_READER_MODEL;
  const controller = new AbortController();
  const expiry = setTimeout(() => controller.abort(), deps.timeoutMs ?? READER_TIMEOUT_MS);

  try {
    const reply = await fetchWithFallback(deps, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: buildNormalizePrompt(sentence, candidates) }],
        max_tokens: 128,
        temperature: 0,
        reasoning_effort: 'none',
        chat_template_kwargs: { enable_thinking: false },
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'normalize', schema: NORMALIZE_SCHEMA, strict: true },
        },
      }),
    });

    if (!reply.ok) return { ok: false, why: failureFor(reply.status), model };
    const payload = (await reply.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return { ok: false, why: 'bad-answer', model };

    const parsed = JSON.parse(content) as { normalized?: unknown };
    if (typeof parsed.normalized !== 'string' || !parsed.normalized.trim()) {
      return { ok: false, why: 'bad-answer', model };
    }

    return { ok: true, value: parsed.normalized.trim(), model };
  } catch (err) {
    return {
      ok: false,
      why: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'unreachable',
      model,
    };
  } finally {
    clearTimeout(expiry);
  }
}

function buildPlanPrompt(
  sentence: string,
  candidates: Candidate[],
  correction?: string,
  done: readonly string[] = [],
): string {
  const list = candidates
    .map((c) => `${c.index}: ${c.label || '(no label)'} (${c.role})`)
    .join('\n');

  // What the run has already verified.
  //
  // The grammar has no memory; the ledger does. On a multi-step run this model is asked
  // the same question about the same sentence every step, and with nothing to say
  // otherwise it gives the same answer every step. Measured on irctc.co.in: the origin and
  // the destination were re-typed on three consecutive steps, and a checkbox ticked on one
  // step was clicked again on the next, which unticked it -- so the run ended with the
  // form in a worse state than the step before.
  //
  // Tier 0 has had this since plans existed (`outstanding` in router.ts). This is the same
  // fact, in the only form a model can read.
  const already =
    done.length > 0
      ? `Already done on this page. Do not do these again:\n${done
          .map((line) => `- ${line}`)
          .join('\n')}\n\n`
      : '';

  return (
    `A user is looking at a web page and said:\n"${sentence}"\n\n` +
    already +
    `These are the fields and buttons on the page:\n${list}\n\n` +
    `Decide what should happen. Reply with a JSON list of actions.\n` +
    `Each action is {"index": <number from the list above>, ` +
    `"action": "type" or "click", "text": "<what to type>"}.\n` +
    `Use "click" for buttons and links, with text "".\n` +
    `Use "type" for text fields, with the text taken from the user's sentence.\n` +
    `Use "select" for a dropdown (combobox), with the text being the option to choose.\n\n` +
    `Rules:\n` +
    `- Only use index numbers from the list above.\n` +
    `- Copy the text to type from the user's sentence word for word. Do not invent ` +
    `names, emails, numbers or any other value.\n` +
    `- If the sentence does not name a value for a field, do not fill that field.\n` +
    `- If the sentence does not say what to do, reply with an empty list.\n` +
    `- Do not repeat anything listed as already done.` +
    (correction
      ? `\n\nYour previous answer was rejected: ${correction}\n` +
        `Try again. Every value must appear in the user's sentence above.`
      : '')
  );
}

/**
 * Ask the local model what the sentence means. Returns actions, or null.
 *
 * Null for every kind of not-working, exactly as `pickCandidate` does, because the caller
 * escalates to the remote planner on all of them. An empty list is *not* null: the model
 * saying "I cannot tell" is an answer, and it is the answer that keeps a 0.6B model from
 * guessing at a task it has no business attempting.
 */
export async function readGoal(
  sentence: string,
  candidates: Candidate[],
  deps: LocalDeps,
  /**
   * Why the last answer was refused, when this is a second attempt.
   *
   * One retry, and it is worth the round trip because of what the refusals actually look
   * like. Asked to read four lines onto four fields, a 1.5B got three right and typed the
   * word "Subject" into the Subject box -- it echoed the label instead of taking the value
   * from the sentence. The whole plan is refused for that, correctly, and three good actions
   * go with it. Telling the model what was wrong is how you would correct a colleague, and
   * it costs one call.
   */
  correction?: string,
  /** Work the ledger has already verified, in the user's own words. See buildPlanPrompt. */
  done: readonly string[] = [],
): Promise<LocalOutcome<LocalAction[]>> {
  const model = deps.model ?? DEFAULT_READER_MODEL;
  if (candidates.length === 0) return { ok: false, why: 'bad-answer', model };

  const controller = new AbortController();
  const expiry = setTimeout(() => controller.abort(), deps.timeoutMs ?? READER_TIMEOUT_MS);

  try {
    const reply = await fetchWithFallback(deps, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'user', content: buildPlanPrompt(sentence, candidates, correction, done) },
        ],
        // Four actions of a few tokens each, plus the JSON around them.
        max_tokens: 256,
        temperature: 0,
        reasoning_effort: 'none',
        chat_template_kwargs: { enable_thinking: false },
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'plan', schema: PLAN_SCHEMA, strict: true },
        },
      }),
    });

    if (!reply.ok) return { ok: false, why: failureFor(reply.status), model };
    const payload = (await reply.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return { ok: false, why: 'bad-answer', model };

    const parsed = JSON.parse(content) as { actions?: unknown };
    if (!Array.isArray(parsed.actions)) return { ok: false, why: 'bad-answer', model };

    const actions: LocalAction[] = [];
    for (const raw of parsed.actions.slice(0, MAX_LOCAL_ACTIONS)) {
      const item = raw as { index?: unknown; action?: unknown; text?: unknown };
      if (typeof item.index !== 'number' || !Number.isInteger(item.index)) {
        return { ok: false, why: 'bad-answer', model };
      }
      if (item.action !== 'type' && item.action !== 'click' && item.action !== 'select') {
        return { ok: false, why: 'bad-answer', model };
      }
      if (typeof item.text !== 'string') return { ok: false, why: 'bad-answer', model };
      // Only an index it was offered, same rule as the tie-break: a number nobody put in
      // front of it has been invented, and acting on it types into whatever happens to
      // carry that index.
      if (!candidates.some((c) => c.index === item.index)) {
        return { ok: false, why: 'bad-answer', model };
      }
      actions.push({ index: item.index, action: item.action, text: item.text });
    }
    // An empty list is a real answer: the model saying it cannot tell. The caller
    // escalates either way, but only one of them is a fault.
    return { ok: true, value: actions, model };
  } catch (err) {
    return {
      ok: false,
      why: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'unreachable',
      model,
    };
  } finally {
    clearTimeout(expiry);
  }
}

/**
 * Ask the local model to break the tie. Returns an index from the shortlist, or null.
 *
 * Null covers every way this can not work -- no server, no model, a timeout, a reply that
 * is not one of the offered indices -- because the caller does the same thing with all of
 * them: escalate. Distinguishing them here would be distinguishing them for nobody.
 */
export async function pickCandidate(
  sentence: string,
  candidates: Candidate[],
  deps: LocalDeps,
): Promise<LocalOutcome<number>> {
  const model = deps.model ?? DEFAULT_LOCAL_MODEL;
  if (candidates.length === 0) return { ok: false, why: 'bad-answer', model };

  const controller = new AbortController();
  const expiry = setTimeout(() => controller.abort(), deps.timeoutMs ?? LOCAL_TIMEOUT_MS);

  try {
    const reply = await fetchWithFallback(deps, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: buildPrompt(sentence, candidates) }],
        max_tokens: 32,
        temperature: 0,
        // Every Qwen3 ships thinking on, and a 0.6B that spends its budget reasoning
        // returns empty content -- a model failure that arrives looking like a timeout.
        reasoning_effort: 'none',
        chat_template_kwargs: { enable_thinking: false },
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'pick', schema: REPLY_SCHEMA, strict: true },
        },
      }),
    });

    if (!reply.ok) return { ok: false, why: failureFor(reply.status), model };
    const payload = (await reply.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return { ok: false, why: 'bad-answer', model };

    const parsed = JSON.parse(content) as { index?: unknown };
    const index = typeof parsed.index === 'number' ? parsed.index : NaN;

    // Only an index it was offered. A model that answers with a number nobody put in
    // front of it has not chosen, it has invented, and acting on that would type into
    // whatever element happened to carry that index.
    return candidates.some((c) => c.index === index)
      ? { ok: true, value: index, model }
      : { ok: false, why: 'bad-answer', model };
  } catch (err) {
    return {
      ok: false,
      why: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'unreachable',
      model,
    };
  } finally {
    clearTimeout(expiry);
  }
}
