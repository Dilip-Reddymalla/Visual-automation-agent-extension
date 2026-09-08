/**
 * Guard rail 2 (CLAUDE.md invariant 1): prove it in the *build output*, not the source.
 *
 * The eslint rule can be silenced with a disable comment. This cannot: it reads every
 * emitted bundle, attributes each line to the module esbuild says it came from, and
 * fails if any canvas encoder appears anywhere except extension/src/redaction/gate.ts.
 *
 * Run after a build:  npm run test:gate
 *
 * What it sees, and what it does not. This reads the *emitted* bundles, so it only
 * covers code that survived tree-shaking. An encoder call in an unused export is
 * invisible here -- verified in M6 by planting one, watching this pass, and moving the
 * call into a reachable function, at which point it failed. That is the correct
 * division rather than a gap: dead code cannot encode anything, and eslint catches it
 * in the source regardless. Both checks are needed, and neither is sufficient.
 *
 * ---
 * Third-party code (added M2, and it needs the team's agreement)
 *
 * onnxruntime-web's Tensor class ships `toDataURL` and `toImageData` helpers for
 * turning a tensor into a picture. We never call them -- the extension's only use of
 * ORT is `InferenceSession.create` and `session.run` in offscreen/runtime-ort.ts -- but
 * they are in the bundle, so a plain grep can no longer say "no encoder outside the
 * gate" about the emitted file.
 *
 * Deleting them is not on offer: patching a vendored library is worse than the problem.
 * So the guarantee is narrowed, deliberately and in one place:
 *
 *   First-party code             unchanged. Any encoder attributed to extension/src/**
 *                                outside gate.ts fails the build, as before.
 *   Third-party code             allowed only for the exact (module, identifier) pairs
 *                                pinned in VENDOR_ALLOW below. A new vendor encoder, a
 *                                new dependency, or ORT growing a new one all fail the
 *                                build and land back here for review.
 *
 * What still holds the line for real: eslint's no-restricted-syntax rule over
 * extension/src/**, which no vendor file can trip, plus the receipt check -- the worker
 * refuses a payload whose receipt hash does not match its manifest, whoever produced
 * the bytes.
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIRS = [join(root, 'dist', 'chrome'), join(root, 'dist', 'firefox')];

const ENCODERS = ['toBlob', 'toDataURL', 'convertToBlob'];
const GATE = 'extension/src/redaction/gate.ts';

/** Vendor modules permitted to contain an encoder, and which ones. Pinned exactly. */
const VENDOR_ALLOW = [
  {
    module: 'node_modules/onnxruntime-web/dist/ort.min.mjs',
    identifiers: ['toDataURL'],
    /**
     * The exact number of hits, per bundle that contains ORT. A pin without a count is
     * a blanket: it would let a future ORT grow ten more encoder call sites without
     * anyone noticing. When an upgrade moves this number, read the new lines before
     * changing it.
     */
    expect: 4,
    why: "ORT's Tensor.toDataURL image helper; never called by this extension.",
  },
];

export function vendorRuleFor(module) {
  return VENDOR_ALLOW.find((v) => module.endsWith(v.module)) ?? null;
}

export function vendorAllows(module, line) {
  const rule = vendorRuleFor(module);
  if (!rule) return false;
  // Every encoder identifier on the line has to be one this rule covers.
  return ENCODERS.filter((e) => new RegExp(`\\b${e}\\b`).test(line)).every((e) =>
    rule.identifiers.includes(e),
  );
}

/** How many encoder identifiers appear on one line. */
export function countEncoders(line) {
  return ENCODERS.reduce(
    (sum, e) => sum + (line.match(new RegExp(`\\b${e}\\b`, 'g'))?.length ?? 0),
    0,
  );
}

/** First-party code has no exemptions at all. */
export function isFirstParty(module) {
  return module.startsWith('extension/src/');
}

/** esbuild writes `  // extension/src/foo.ts` above each module it inlines. */
const MODULE_COMMENT = /^\s*\/\/\s+(.+\.(?:ts|tsx|mts|cts|js|mjs|cjs))\s*$/;
const ENCODER_RE = new RegExp(`\\b(${ENCODERS.join('|')})\\b`);

async function scanFile(dist, name) {
  const text = await readFile(join(dist, name), 'utf8');
  const violations = [];
  const exempted = [];
  let module = '(bundle prologue)';

  text.split('\n').forEach((line, i) => {
    const header = MODULE_COMMENT.exec(line);
    if (header) {
      module = header[1].replace(/\\/g, '/');
      return;
    }
    if (!ENCODER_RE.test(line)) return;
    if (module === GATE) return;
    if (!isFirstParty(module) && vendorAllows(module, line)) {
      // Occurrences, not lines: ORT has one line carrying two calls, and counting
      // lines would let a third be added to it without moving the number.
      exempted.push({ module, file: `${name}:${i + 1}`, hits: countEncoders(line) });
      return;
    }
    violations.push({
      file: `${name}:${i + 1}`,
      module,
      line: line.trim().slice(0, 120),
    });
  });

  return { violations, exempted };
}

/**
 * Every script the extension ships, at any depth. The first version of this looked at
 * top-level .js only, which missed dist/<target>/ort/ .mjs files entirely -- files that are loaded
 * at runtime by the WASM backend and are as much a part of the extension as the
 * bundles are.
 */
async function emittedScripts(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await emittedScripts(full)));
      continue;
    }
    if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

async function main() {
  const present = DIST_DIRS.filter((d) => existsSync(d));
  if (present.length === 0) {
    console.error('test:gate: no dist/ found. Run "npm run build" first.');
    process.exit(1);
  }

  const violations = [];
  const exempted = [];
  let scanned = 0;

  for (const dist of present) {
    for (const file of await emittedScripts(dist)) {
      scanned += 1;
      const result = await scanFile(dist, relative(dist, file));
      violations.push(...result.violations.map((v) => ({ ...v, dist })));
      exempted.push(...result.exempted);
    }
  }

  // A pinned count that has moved is a review item, not a pass.
  const miscounts = [];
  for (const rule of VENDOR_ALLOW) {
    if (rule.expect === undefined) continue;
    const byBundle = new Map();
    for (const hit of exempted) {
      if (!hit.module.endsWith(rule.module)) continue;
      const bundle = hit.file.replace(/:\d+$/, '');
      byBundle.set(bundle, (byBundle.get(bundle) ?? 0) + hit.hits);
    }
    for (const [bundle, count] of byBundle) {
      if (count !== rule.expect) miscounts.push({ rule, bundle, count });
    }
  }

  if (miscounts.length > 0) {
    console.error('test:gate: a pinned vendor exemption changed size.\n');
    for (const m of miscounts) {
      console.error(
        `  ${m.bundle}: ${m.count} hit(s) in ${m.rule.module}, expected ${m.rule.expect}`,
      );
    }
    console.error(
      '\nRead the new lines before touching `expect` in VENDOR_ALLOW. An encoder that ' +
        'appeared in a dependency upgrade is exactly what this number exists to catch.',
    );
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error('test:gate: canvas encoders escaped the gate.\n');
    for (const v of violations) {
      console.error(`  ${v.dist.replace(root, '.')}/${v.file}`);
      console.error(`    from ${v.module}`);
      console.error(`    ${v.line}\n`);
    }
    console.error(
      `Only ${GATE} may encode pixels (CLAUDE.md invariant 1). ` +
        'Everything else takes a sealed canvas or takes bytes.',
    );
    process.exit(1);
  }

  const vendorNote =
    exempted.length > 0
      ? ` ${exempted.reduce((n, e) => n + e.hits, 0)} pinned vendor hit(s) in ` +
        `${[...new Set(exempted.map((e) => e.module))].join(', ')}.`
      : '';

  console.log(
    `test:gate: ok -- ${scanned} bundle(s) scanned, ` +
      `no ${ENCODERS.join('/')} in first-party code outside ${GATE}.${vendorNote}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
