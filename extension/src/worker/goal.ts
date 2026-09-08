/**
 * The user's goal, placeholdered before it enters a request.
 *
 * `StepRequestSchema.goal` has said "already placeholdered" since M0 and nothing was
 * doing it. An operator typing "apply for the scholarship using Aadhaar 7237 2429 6561"
 * would have sent that number to the planner in plain text, past a gate that had been
 * carefully arranged to stop exactly that -- the picture redacted, the sentence beside
 * it not.
 *
 * The same treatment for history entries: an action line is assembled from placeholders
 * and never from raw text.
 *
 * What this can and cannot catch is worth being exact about. L1 is checksummed patterns
 * -- Aadhaar, PAN, card, email, phone, GSTIN, IFSC, UPI, and the labelled cases. A name
 * typed into the goal is L2's job and L2 is not implemented, so a name in the goal
 * reaches the planner. The popup says so rather than implying otherwise, because a
 * privacy tool that overstates its coverage is worse than one that states it plainly.
 */

import { scanText } from '../redaction/l1-lexical';
import type { PlaceholderClass } from '../shared/placeholders';

export interface Substitution {
  cls: PlaceholderClass;
  value: string;
  placeholder: string;
}

export interface PlaceholderedText {
  text: string;
  substitutions: Substitution[];
}

/**
 * What is substituted out of the task box before it is sent. The panel shows this list.
 *
 * Two mechanisms feed it, and the difference matters for what can honestly be claimed:
 *
 *   L1 shape rules      an Aadhaar number looks like one wherever it appears, so these
 *                       are found in any sentence, in any phrasing.
 *   the intent parser   "fill first name with leo" says what "leo" is because of the
 *                       field the user named (worker/intent.ts). No shape, no model --
 *                       the sentence is the evidence.
 *
 * PERSON and ADDRESS are here on the strength of the second. They are covered when the
 * sentence names the field the value is going into, which is the phrasing that carries a
 * name in practice; a name mentioned in passing in an open-ended goal is not caught, and
 * ORG is not caught at all. That distinction is in the panel's wording rather than
 * flattened away, because the whole point of the line is to let an operator know what
 * they can rely on.
 *
 * Page content is a different question and a stronger answer: L2 reads the page and
 * catches all three there.
 */
export const PROTECTED_IN_GOAL: readonly PlaceholderClass[] = [
  'AADHAAR',
  'PAN',
  'GSTIN',
  'IFSC',
  'UPI',
  'CARD',
  'ACCOUNT',
  'EMAIL',
  'PHONE',
  'DOB',
  'PASSPORT',
  'LICENCE',
  // Caught when the sentence names the field they go into. See the note above.
  'PERSON',
  'ADDRESS',
];

/**
 * Still not caught in the task box, and said rather than implied.
 *
 * An organisation name has no shape for L1 and no field-name rule in the parser, so a
 * company mentioned in a goal reaches the planner as typed. L2 would catch it on the
 * page; the sentence is not the page.
 */
export const UNPROTECTED_IN_GOAL: readonly PlaceholderClass[] = ['ORG'];

export type Allocate = (cls: PlaceholderClass, value: string) => string;

/**
 * Replace every identifier in `text` with a placeholder.
 *
 * Right to left, so an earlier replacement cannot shift the offsets of a later one --
 * the alternative is recomputing every span after each substitution, which is the same
 * work with more chances to be wrong.
 */
export function placeholderText(text: string, allocate: Allocate): PlaceholderedText {
  const matches = scanText(text).sort((a, b) => b.start - a.start);
  const substitutions: Substitution[] = [];

  let out = text;
  for (const match of matches) {
    const placeholder = allocate(match.cls, match.text);
    substitutions.unshift({ cls: match.cls, value: match.text, placeholder });
    out = out.slice(0, match.start) + placeholder + out.slice(match.end);
  }

  return { text: out, substitutions };
}

/**
 * One history line, assembled from the plan rather than from the page.
 *
 * An action's `text` may itself be a placeholder the planner chose; anything else is
 * summarised by shape. The alternative -- describing what was typed -- would put the
 * typed value in the history, which is the same leak one step later.
 */
export function describeAction(action: {
  type: string;
  index?: number;
  text?: string;
  option?: string;
  key?: string;
}): string {
  const target = action.index === undefined ? '' : ` [${action.index}]`;

  switch (action.type) {
    case 'type': {
      // A placeholder is safe to record; anything else is described, not quoted.
      const value = action.text ?? '';
      const safe = /^«[A-Z]+(_\d+)?»$/.test(value) ? value : `${value.length} characters`;
      return `type${target} ${safe}`;
    }
    case 'select':
      return `select${target} an option`;
    case 'key':
      return `key ${action.key ?? ''}`;
    default:
      return `${action.type}${target}`;
  }
}
