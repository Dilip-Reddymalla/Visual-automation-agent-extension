# SIH26171 — Claude Code prompt pack

Thirteen prompts that build the Redaction Gate project end to end.

## Setup

1. Create an empty repo and put **`CLAUDE.md`** in its root. Every Claude Code session in
   that directory inherits it automatically — the invariants, the architecture, the
   conventions and the anti-patterns. This file is doing most of the work; the prompts are
   deliberately short because they can assume it.
2. Copy `prompts/` into the repo (or keep it outside — it does not matter, they are for you).
3. Run `00-bootstrap.md` first, in an empty directory.

## Running order

```
00-bootstrap            scaffold, build, guard rails          ~1 session
  │
  ├─ M1  extension shell + message bus                        ~1 session
  │    │
  │    ├─ M2  inference host        ◀── HIGHEST RISK, DO SECOND
  │    │      │
  │    │      ├─ M4  capture + coordinate contract
  │    │      └─ M5  PII detection  (two sessions: A then B)
  │    │             │
  │    │             └─ M6  redaction gate
  │    │                    │
  │    │                    └─ M7  transport + contract
  │    │                           │
  │    │                           ├─ M8  server
  │    │                           └─ M9  action executor
  │    │
  │    └─ M3  DOM perception        (parallel with M2/M4)
  │
  ├─ M10 operator UI                (after M6, M7)
  ├─ M11 eval harness               (start day 8, not day 18)
  └─ M12 demo assets                (pages in week 1, script in week 3)
```

**M2 is the gating risk.** If WebGPU inference will not run inside an extension on your
machines, the whole plan changes — so find out on day two, not day fourteen.

## How to run one

Start a fresh Claude Code session per module, in the repo root:

```
> /clear
> paste the module prompt
```

Fresh context per module matters. A session that has been open through three modules starts
making decisions based on stale details from the first one.

For the larger modules (M3, M5, M11), consider plan mode first: paste the prompt, let Claude
produce a plan, review the algorithm choices, then approve. M5 in particular is written to be
split across two sessions and will go badly as one.

## Adapting them

Each prompt has four parts: **what to build**, **constraints**, **acceptance criteria**, and
**do not**. If you change the design, change the acceptance criteria in the same edit —
otherwise you will get code that satisfies a test you no longer want.

The `do not` sections are not padding. Each one is a specific failure this project has a
reason to expect: over-redacting as a safe default, OCR-ing the whole screenshot, setting
`element.value` directly, adding features after the freeze.

## Two things to verify before day one

1. **WebGPU on your actual demo machine**, in both Chrome and Firefox. Firefox ships WebGPU
   on Windows and Apple-silicon macOS; Linux is still in progress. If your demo laptop is
   Firefox-on-Linux, you are on the WASM path and you need to know that in week one.
2. **The current Qwen-VL release**, before anyone writes the server prompt in M8.
