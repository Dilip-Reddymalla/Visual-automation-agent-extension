# Prompt 00 — Bootstrap the repository

> Run this once, in an empty directory, before anything else.
> Prerequisite: place `CLAUDE.md` in the repo root first so this session inherits it.

---

You are setting up the repository for SIH26171 — a privacy-preserving browser agent that
does all visual perception on-device. Read `CLAUDE.md` in full before writing anything; its
invariants govern every decision in this project.

**Scope of this session: scaffolding only.** Create the structure, the build, the lint rules,
the shared types and the guard rails. Do not implement any module logic — every real file
gets a typed stub that throws `new Error('not implemented')`. Later sessions fill them in.

## Build

1. `npm init`, TypeScript in strict mode, Vitest, ESLint, Prettier.
2. `extension/build.mjs` using esbuild with two targets writing `dist/chrome` and
   `dist/firefox`. Each target bundles the entry points, copies the matching manifest as
   `manifest.json`, and copies `extension/models/` verbatim. No framework plugin — plain
   esbuild, because MV3 offscreen documents break in surprising ways under bundler plugins.
3. Entry points: `worker/index.ts`, `content/index.ts`, `offscreen/index.ts`,
   `ui/popup/index.ts`.

## Manifests

Write both, differing only where they must:

- **Chrome**: `manifest_version: 3`, `background.service_worker`, permissions
  `activeTab, scripting, storage, offscreen, tabs`, `host_permissions` restricted to
  `http://localhost/*` and `file:///*` for now.
- **Firefox**: `background.scripts` (an event page — it has a real DOM, which is how Firefox
  gets an inference host without `chrome.offscreen`), plus
  `browser_specific_settings.gecko.id`.

Both must set:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

Without `wasm-unsafe-eval` the ONNX WASM backend fails silently at runtime with an
unhelpful error. This is the single most common lost day on this project.

## Shared types — write these fully, not as stubs

- `shared/coords.ts` — `Box = { x, y, w, h }` in CSS pixels of the visual viewport, origin
  top-left. Export `toImageSpace(box, scale)`, `fromImageSpace`, `iou(a, b)`, `union(a, b)`,
  `expand(box, pct)`, `clampToViewport(box, vp)`. Unit-test every one of them now.
- `shared/placeholders.ts` — the frozen class union and a `PlaceholderAllocator` that hands
  out stable per-class, per-session numbering (`«PERSON_1»` is the same human on step 2 and
  step 9) and holds the local rehydration map. The map is a private field; expose only
  `allocate(cls, value)` and `resolve(placeholder)`.
- `shared/messages.ts` — a discriminated union of every cross-context message with a
  request-id envelope, plus a promise-based `send<T>()` wrapper. Every later module talks
  through this and nothing else.
- `shared/contract.ts` — Zod schemas for the step request and response. Generate
  `server/schema.json` from them in a build step; the server loads that file for guided
  decoding. A mismatch must fail the build.

## Guard rails — these are the point of this session

1. ESLint `no-restricted-syntax` banning `toBlob`, `toDataURL` and `convertToBlob` anywhere
   except `extension/src/redaction/gate.ts`.
2. `npm run test:gate` — greps the built bundle for those identifiers and asserts they appear
   only inside the gate's emitted code.
3. An ESLint rule (or a simple import-boundary test) asserting that `redaction/` and
   `offscreen/tasks/` import no `chrome.*` globals, so both are unit-testable in Node.

## Deliverable

`npm run build` produces `dist/chrome` and `dist/firefox`. The Chrome build loads unpacked
at `chrome://extensions`; the Firefox build loads via `about:debugging`. The popup opens and
logs. `npm run lint`, `npm test` and `npm run test:gate` all pass on the stubbed tree.
Deliberately adding a `canvas.toBlob()` call in `content/` must fail the lint run — verify
that it does, then remove it.

Commit as `M0: scaffold`.
