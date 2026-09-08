# Prompt M7 — Transport and the shared contract

> Depends on: M6. Owner: Server + Platform. Estimate: ~8 h.

---

Read `CLAUDE.md`. You are implementing M7: one source of truth for the wire format, used by
the client validator, the server validator, and the model's guided decoder.

## What to build

**`shared/contract.ts`** — finish the Zod schemas. Generate `server/schema.json` from them
in a build step; the server loads that file for guided decoding. Changing one without the
other must fail the build — add a CI check that regenerates and diffs.

### Device → server

```jsonc
POST /v1/step
{
  "session": "s_9f2c", "step": 4,
  "task": "Complete the scholarship application from my saved profile",
  "viewport": { "w": 1280, "h": 720, "scroll_y": 640, "doc_h": 3200 },
  "page": { "origin_class": "gov.in", "title": "Application — «ORG_1»" },

  "elements": "[4]<input aria-label=\"Full name\" value=\"«PERSON_1»\" />\n...",

  "vision": {
    "image": "<base64 jpeg, post-gate>", "scale": 0.8,
    "regions": [ { "box": [640,120,240,240], "kind": "image",
                   "caption": "photograph, one face", "op": "blur" } ]
  },

  "redaction_manifest": {
    "scheme": "sih26171/v1",
    "placeholders": { "PERSON": 1, "AADHAAR": 1, "EMAIL": 2, "SECRET": 1 },
    "ops": [
      { "box": [220,470,380,32], "op": "box",  "cls": "aadhaar", "by": "L0:autocomplete" },
      { "box": [640,120,240,240], "op": "blur", "cls": "face",   "by": "L3:face@0.94" }
    ],
    "coverage": { "detected": 9, "redacted": 9 }, "sha": "3f1a…"
  },

  "last_action": { "op": "click", "index": 3, "result": "ok" }
}
```

### Server → device

```jsonc
{
  "thought": "Name and Aadhaar are already filled — the manifest says both are redacted,
              not empty. Email at [6] is empty and [8] shows a validation error for it.",
  "actions": [
    { "op": "type",  "index": 6, "text": "«EMAIL_1»", "clear": true },
    { "op": "click", "index": 9 }
  ],
  "expect": { "kind": "url_change", "hint": "confirmation or next section" },
  "done": false, "confidence": 0.82
}
```

## Why the manifest is not optional

The problem statement requires a server that is _aware of the redaction scheme_. The
manifest satisfies that literally: it tells the planner what was removed, by which detector,
and why — so a masked field reads as **known and handled** rather than empty and needing to
be filled. Without it, the agent will cheerfully re-type an Aadhaar number into a field that
already has one, in front of the judges.

## `worker/transport.ts`

1. Recompute the receipt hash from the manifest; refuse to POST on mismatch (M6 built this —
   wire it in here).
2. Validate the outbound body against the Zod schema before sending, and the inbound body
   after receiving. A schema failure is a retryable error, not a thrown exception that kills
   the run.
3. Retry once on network failure with a 1 s backoff, then surface the error to the popup.
4. `worker/trace.ts` — write one structured JSON line per step: timings by stage, payload
   sizes, findings count, manifest coverage, and the returned plan. The eval harness reads
   this directly, so do not change its shape casually.

## The placeholder vocabulary is frozen here

`PERSON, ADDRESS, EMAIL, PHONE, DOB, AADHAAR, PAN, GSTIN, IFSC, UPI, ACCOUNT, CARD,
PASSPORT, LICENCE, ORG, SECRET`. Per-class, per-session numbering, stable across steps —
`«PERSON_1»` is the same human on step 2 and step 9, which is what lets the planner reason
about identity without knowing it. Adding a class means changing `shared/placeholders.ts`,
the server system prompt and the eval harness **in the same commit**.

## Acceptance criteria

1. Both worked examples above validate against the schemas.
2. `server/schema.json` regenerates identically from `contract.ts`; CI fails if it drifts.
3. A payload whose receipt hash does not match its manifest is refused before the fetch.
4. A malformed server response produces a retryable error, not a crash.
5. One trace line per step, parseable by `eval/harness.py`.

## Do not

- Do not hand-write `schema.json`. Generate it.
- Do not add fields to the wire format without a corresponding acceptance test.
- Do not put user data in the trace log. Placeholders only — the trace is a debugging
  artefact that will end up in a screenshot on a slide.

Commit as `M7: transport and contract`.
