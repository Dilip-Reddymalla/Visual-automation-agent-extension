/**
 * L2: named entities -- people, addresses and organisations that no pattern will catch.
 *
 * What is finished here is everything that does not need weights: the label mapping,
 * the span-to-box translation, the two operating points, and the early exit. The model
 * call itself is not, because the model has not been chosen -- see the note at the
 * bottom of extension/models/README.md, and the M5b report.
 *
 * Node-pure: the session arrives as an argument.
 */

import type { Box } from '../../shared/coords';
import type { ObservedElement } from '../../shared/observed';
import { isPlaceholderClass, type PlaceholderClass } from '../../shared/placeholders';
import type { FindingDraft } from '../../redaction/findings';
import type { ModelSession, TensorLike } from '../host';
import { createUnigramTokenizer } from './unigram';
import { CAPTION_WINDOW, disqualifiedByCaption } from '../../redaction/l1-lexical';
import {
  boxForSpan,
  buildOffsetTable,
  chunkDocument,
  dedupeSpans,
  type DocSpan,
  type OffsetTable,
} from './chunks';

/**
 * Model label to placeholder class, explicitly, in one table.
 *
 * An unmapped label is dropped rather than coerced. The temptation is to funnel
 * anything unrecognised into ORG or PERSON "to be safe", and it is the wrong instinct
 * twice over: it produces findings whose class is a guess, and over-redaction is a
 * first-class failure here, not a safe default (CLAUDE.md, what the evaluation
 * rewards).
 *
 * CoNLL-style B-/I- prefixes are stripped before lookup, so both halves of a
 * multi-token entity land on the same class.
 */
export const LABEL_TO_CLASS: Readonly<Record<string, PlaceholderClass>> = {
  GIVENNAME: 'PERSON',
  SURNAME: 'PERSON',
  STREET: 'ADDRESS',
  BUILDINGNUM: 'ADDRESS',
  CITY: 'ADDRESS',
  ZIPCODE: 'ADDRESS',
  TELEPHONENUM: 'PHONE',
  EMAIL: 'EMAIL',
  // DATE is mapped only when the text also reads as a birth date; see dateIsBirthday.
  DATE: 'DOB',
};

/** Labels a model emits that we deliberately ignore. Listed so they read as a decision. */
export const IGNORED_LABELS: ReadonlySet<string> = new Set([
  'O',
  // Attributes of a person rather than identifiers of one. Painting them costs visual
  // context and protects nothing a name and an address have not already given away.
  'AGE',
  'GENDER',
  'SEX',
  'TITLE',
  'TIME',
  // Every one of these is a checksummed class that L1 already owns, at a precision a
  // model cannot approach: a Verhoeff-valid Aadhaar is certain, and this model calling
  // a twelve-digit invoice number a SOCIALNUM at 0.38 is exactly the false positive
  // over-redaction is measured on. Deliberately dropped rather than merged.
  'SOCIALNUM',
  'IDCARDNUM',
  'TAXNUM',
  'CREDITCARDNUMBER',
  'PASSPORTNUM',
  'DRIVERLICENSENUM',
]);

/**
 * The checkpoint has no ORGANIZATION label.
 *
 * The module brief's mapping table lists `ORGANIZATION -> ORG`, and this model's
 * `id2label` does not contain it -- the label set is AGE, BUILDINGNUM, CITY,
 * CREDITCARDNUMBER, DATE, DRIVERLICENSENUM, EMAIL, GENDER, GIVENNAME, IDCARDNUM,
 * PASSPORTNUM, SEX, SOCIALNUM, STREET, SURNAME, TAXNUM, TELEPHONENUM, TIME, TITLE,
 * ZIPCODE. So ORG stays where it was: L0's lexicon, and unrecovered in prose.
 *
 * Recorded here rather than silently omitted, because a mapping table with a row that
 * can never fire reads as working code.
 */
export const UNAVAILABLE_LABELS = ['ORGANIZATION'] as const;

export function classForLabel(label: string): PlaceholderClass | null {
  const bare = label.replace(/^[BIESU]-/, '').toUpperCase();
  if (IGNORED_LABELS.has(bare)) return null;
  if (LABEL_TO_CLASS[bare]) return LABEL_TO_CLASS[bare];

  // A class is a valid spelling of itself. The INFER reply carries `cls` rather than the
  // model's raw label -- the wire type is NerSpan, and mapping at the host is right --
  // so by the time the span reaches detectEntities it has already been translated once.
  // Without this the second translation looks up 'PERSON' in a table whose keys are
  // GIVENNAME and SURNAME, finds nothing, and drops every span the model found.
  //
  // That failure is silent and expensive: the model still loads, still runs, still costs
  // 1.7 s a step and 340 MB of heap, and produces zero findings. Worth a line.
  return isPlaceholderClass(bare) ? bare : null;
}

/**
 * Two operating points, reported together in the eval.
 *
 * Being explicit about the trade is the point: recall matters for privacy and precision
 * matters for the visual-context score, and a single number hides which one was chosen.
 */
export const THRESHOLDS = {
  /** Miss less. Used when the operator asks for maximum protection. */
  highRecall: 0.35,
  /** Over-redact less. The default. */
  highPrecision: 0.7,
} as const;

export type Operating = keyof typeof THRESHOLDS;

export interface NerInput {
  elements: ObservedElement[];
  /** Character ranges L0 and L1 already claimed, in document coordinates. */
  claimed?: Array<[number, number]>;
  operating?: Operating;
}

/**
 * Everything L2 needs to decide *whether to run at all*.
 *
 * The early exit is worth as much as the model: on a form where L0 identified every
 * field and L1 validated every value, there is nothing left for NER to find, and
 * loading 40-plus megabytes to confirm that is the single most expensive way to learn
 * nothing. This is the common case on the pages this agent is built for.
 */
export function needsModel(table: OffsetTable, claimed: Array<[number, number]> = []): boolean {
  if (table.text.trim().length === 0) return false;

  let unclaimed = 0;
  for (const entry of table.entries) {
    const covered = claimed.some(([s, e]) => entry.start >= s && entry.end <= e);
    if (!covered) unclaimed += entry.end - entry.start;
  }

  // A handful of stray characters is not worth a model load.
  return unclaimed > 24;
}

export interface NerRunner {
  /** Classify one chunk. Spans are in chunk coordinates. */
  (text: string): Promise<DocSpan[]>;
}

/**
 * The layer, with the model call injected.
 *
 * Written this way so the offset arithmetic, the chunking, the de-duplication and the
 * thresholds are all testable against a fake classifier -- which is most of the layer,
 * and all of the part that goes wrong quietly.
 */
export async function detectEntities(input: NerInput, run: NerRunner): Promise<FindingDraft[]> {
  const table = buildOffsetTable(
    input.elements.map((el) => ({ elementIndex: el.index, runs: el.textRuns })),
  );
  if (!needsModel(table, input.claimed)) return [];

  const threshold = THRESHOLDS[input.operating ?? 'highPrecision'];
  const documentText = table.text;
  const chunks = chunkDocument(table.text);

  const spans: DocSpan[] = [];
  for (const chunk of chunks) {
    for (const span of await run(chunk.text)) {
      spans.push({ ...span, start: span.start + chunk.offset, end: span.end + chunk.offset });
    }
  }

  const drafts: FindingDraft[] = [];
  for (const span of dedupeSpans(spans)) {
    if (span.score < threshold) continue;

    const cls = classForLabel(span.label);
    if (!cls) continue;

    // The same caption rule L1 applies. A value captioned "Waybill" or "Filed on" is
    // not personal data whichever layer found it, and until L2 used this it was
    // redacting the exact decoys L1 had been correctly refusing.
    const before = documentText.slice(Math.max(0, span.start - CAPTION_WINDOW), span.start);
    const after = documentText.slice(span.end, span.end + CAPTION_WINDOW);
    if (disqualifiedByCaption(before, after, cls)) continue;

    const box = boxForSpan(table, span.start, span.end);
    if (!box) continue;

    drafts.push({
      cls,
      box,
      layer: 'L2',
      confidence: span.score,
      reason: `ner-${span.label.toLowerCase()}`,
      elementIndex: elementForSpan(table, span.start, span.end),
      textSpan: [span.start, span.end],
      value: table.text.slice(span.start, span.end),
    });
  }

  return drafts;
}

function elementForSpan(table: OffsetTable, start: number, end: number): number | undefined {
  for (const entry of table.entries) {
    if (start < entry.end && end > entry.start) return entry.elementIndex;
  }
  return undefined;
}

/** Exported for the box arithmetic tests. */
export function spanBox(table: OffsetTable, start: number, end: number): Box | null {
  return boxForSpan(table, start, end);
}

/**
 * The model call. Not implemented: no NER model has been chosen that satisfies the
 * licence gate (MIT or Apache-2.0), is not access-gated, and covers Indian languages.
 * The candidates and their exact licences are recorded in extension/models/README.md;
 * this is a decision, not an oversight.
 */
/** XLM-R's special ids. Fixed by the checkpoint, not by the pruning. */
const BOS = 0;
const EOS = 2;

/** Longest sequence fed to the model. chunks.ts already splits well inside this. */
const MAX_TOKENS = 512;

export interface NerAssets {
  /** The pruned vocabulary, as `tokenizer.json` ships it. */
  vocab: ReadonlyArray<readonly [string, number]>;
  unkId: number;
  /** `id2label` from config.json, in id order. */
  labels: readonly string[];
}

/**
 * The model call.
 *
 * Argmax per token, then contiguous tokens carrying the same class are one span. The
 * B-/I- prefixes are not trusted to mark boundaries: this checkpoint labels almost every
 * piece `B-`, so relying on them would split "Asha Menon" into two people and, worse,
 * split one name across two boxes. Adjacency in the source text is the reliable signal
 * and it is the one used.
 *
 * The score reported for a span is its **lowest** token score, not its mean. A span is
 * only as good as its weakest piece, and averaging lets one confident token carry two
 * doubtful ones past the threshold -- which is precisely the shape of a false positive
 * that over-redaction is measured on.
 */
export function createNerRunner(
  session: ModelSession,
  assets: NerAssets,
  makeTensor: (type: string, data: BigInt64Array, dims: number[]) => TensorLike,
): NerRunner {
  const tokenizer = createUnigramTokenizer(assets.vocab, assets.unkId);

  return async (text: string): Promise<DocSpan[]> => {
    const tokens = tokenizer.encode(text).slice(0, MAX_TOKENS - 2);
    if (tokens.length === 0) return [];

    const ids = new BigInt64Array(tokens.length + 2);
    ids[0] = BigInt(BOS);
    for (let i = 0; i < tokens.length; i += 1)
      ids[i + 1] = BigInt(tokens[i]?.id ?? assets.unkId);
    ids[tokens.length + 1] = BigInt(EOS);

    const mask = new BigInt64Array(ids.length).fill(1n);
    const dims = [1, ids.length];

    const output = await session.run({
      input_ids: makeTensor('int64', ids, dims),
      attention_mask: makeTensor('int64', mask, dims),
    });

    // A missing output is a fault, not an absence of entities. Returning [] here reads
    // downstream as "this page has no names on it", which is the same answer a working
    // model gives for a page of numbers -- and the difference costs a second and a half
    // a step to discover.
    const logits = output.logits ?? output[session.outputNames[0] ?? ''];
    if (!logits) {
      throw new Error(
        `ner: the model returned no logits (outputs: ${Object.keys(output).join(', ') || 'none'})`,
      );
    }
    const values = logits.data as Float32Array | number[];

    // From the tensor, cross-checked against the label table. An empty or short label
    // table makes the stride zero, every row read as index 0, and every token come back
    // 'O' -- a model that runs perfectly and finds nothing, with no error anywhere.
    const labelCount = logits.dims[logits.dims.length - 1] ?? 0;
    if (labelCount !== assets.labels.length) {
      throw new Error(
        `ner: the model emits ${labelCount} labels and the table has ` +
          `${assets.labels.length}. One of them is from a different checkpoint.`,
      );
    }

    const spans: DocSpan[] = [];
    let open: { cls: string; start: number; end: number; score: number } | null = null;

    const flush = (): void => {
      if (open)
        spans.push({ start: open.start, end: open.end, label: open.cls, score: open.score });
      open = null;
    };

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!token) continue;
      // +1 for the BOS row the model saw but the text does not have.
      const row = (i + 1) * labelCount;

      let bestAt = 0;
      let best = -Infinity;
      let total = 0;
      for (let k = 0; k < labelCount; k += 1) {
        const value = Math.exp(Number(values[row + k] ?? 0));
        total += value;
        if (value > best) {
          best = value;
          bestAt = k;
        }
      }

      const label = assets.labels[bestAt] ?? 'O';
      const bare = label.replace(/^[BI]-/, '');
      const score = total > 0 ? best / total : 0;

      // Group by the *class*, not the raw label. This model splits a person into
      // GIVENNAME and SURNAME and an address into STREET, BUILDINGNUM, CITY and
      // ZIPCODE, so grouping on the label leaves "Asha Menon" as two spans covering one
      // word each -- and a box over half a name matches no ground truth and protects
      // nobody.
      if (!LABEL_TO_CLASS[bare]) {
        flush();
        continue;
      }

      // Adjacent means "same word or the next one", not "touching". A comma between two
      // names is still two names, and a gap of more than one character is a new span.
      const continues = open !== null && open.cls === bare && token.start - open.end <= 1;

      if (continues && open) {
        open.end = token.end;
        open.score = Math.min(open.score, score);
      } else {
        flush();
        open = { cls: bare, start: token.start, end: token.end, score };
      }
    }
    flush();

    return spans;
  };
}
