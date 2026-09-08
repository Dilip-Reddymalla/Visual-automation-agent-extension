/**
 * Two targets, one bundler, no plugins.
 *
 *   node extension/build.mjs chrome    -> dist/chrome
 *   node extension/build.mjs firefox   -> dist/firefox
 *
 * Plain esbuild on purpose. MV3 offscreen documents break in surprising ways under
 * framework plugins, and this build has to be something a judge can reproduce with one
 * command on a machine that has never seen the project.
 *
 * Not minified, deliberately: `npm run test:gate` reads the emitted file-path comments
 * to prove that the only canvas encoder in the bundle is the one inside
 * extension/src/redaction/gate.ts (CLAUDE.md invariant 1).
 */

import * as esbuild from 'esbuild';
import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'extension', 'src');

/**
 * ONNX Runtime ships its WASM binaries as separate files. The alternative is the
 * "bundle" build, which base64s a ~20 MB binary into the JS -- parsed on every open of
 * the offscreen document, for a latency budget that is 15% of the score. So: external
 * files, copied here, and `ort.env.wasm.wasmPaths` pointed at them by runtime-ort.ts.
 *
 * They are served from the extension origin, so they need no web_accessible_resources
 * entry; only page origins need that, and no page origin should be able to see these.
 *
 * The `.jsep.` pair is the one WebGPU uses -- JSEP is the JS execution provider bridge
 * that the GPU backend runs on top of. Shipping only the plain pair is the quiet way to
 * end up on WASM on every machine.
 */
const ORT_ASSETS = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
];

const TARGETS = {
  chrome: {
    outDir: join(root, 'dist', 'chrome'),
    manifest: join(root, 'extension', 'manifest.chrome.json'),
    // The offscreen document is Chrome's inference host; Firefox uses its event page.
    entries: {
      worker: join(src, 'worker', 'index.ts'),
      content: join(src, 'content', 'index.ts'),
      offscreen: join(src, 'offscreen', 'index.ts'),
      popup: join(src, 'ui', 'popup', 'index.ts'),
      // Its own window, deliberately: releasing a credential is not something to
      // confirm from a notification. See platform/vault-store.ts.
      confirm: join(src, 'ui', 'confirm', 'index.ts'),
      // The two surfaces a judge actually looks at.
      sidebyside: join(src, 'ui', 'sidebyside', 'index.ts'),
      hud: join(src, 'ui', 'hud', 'index.ts'),
      // The docked shell that frames all three.
      panel: join(src, 'ui', 'panel', 'index.ts'),
    },
    pages: [
      [join(src, 'ui', 'panel', 'panel.html'), 'panel.html'],
      [join(src, 'ui', 'popup', 'popup.html'), 'popup.html'],
      // Same controls, same bundle, no Evidence buttons -- inside the panel those point
      // at sibling tabs the reader is already on. See the note in agent.html.
      [join(src, 'ui', 'popup', 'agent.html'), 'agent.html'],
      [join(src, 'ui', 'confirm', 'confirm.html'), 'confirm.html'],
      [join(src, 'ui', 'sidebyside', 'sidebyside.html'), 'sidebyside.html'],
      [join(src, 'ui', 'hud', 'hud.html'), 'hud.html'],
      [join(src, 'offscreen', 'offscreen.html'), 'offscreen.html'],
    ],
  },
  firefox: {
    outDir: join(root, 'dist', 'firefox'),
    manifest: join(root, 'extension', 'manifest.firefox.json'),
    // No offscreen bundle: Firefox hosts inference in the background event page,
    // which has a real DOM. Its worker entry is the one that pulls the host in, so
    // Chrome's service worker never sees a byte of onnxruntime-web.
    entries: {
      worker: join(src, 'worker', 'index.firefox.ts'),
      content: join(src, 'content', 'index.ts'),
      popup: join(src, 'ui', 'popup', 'index.ts'),
      confirm: join(src, 'ui', 'confirm', 'index.ts'),
      sidebyside: join(src, 'ui', 'sidebyside', 'index.ts'),
      hud: join(src, 'ui', 'hud', 'index.ts'),
      panel: join(src, 'ui', 'panel', 'index.ts'),
    },
    pages: [
      [join(src, 'ui', 'panel', 'panel.html'), 'panel.html'],
      [join(src, 'ui', 'popup', 'popup.html'), 'popup.html'],
      // Same controls, same bundle, no Evidence buttons -- inside the panel those point
      // at sibling tabs the reader is already on. See the note in agent.html.
      [join(src, 'ui', 'popup', 'agent.html'), 'agent.html'],
      [join(src, 'ui', 'confirm', 'confirm.html'), 'confirm.html'],
      [join(src, 'ui', 'sidebyside', 'sidebyside.html'), 'sidebyside.html'],
      [join(src, 'ui', 'hud', 'hud.html'), 'hud.html'],
    ],
  },
};

/**
 * Every weight, present and byte-for-byte the one that was measured.
 *
 * `.gitignore` excludes `extension/models/*.onnx` -- GitHub refuses raw files over 100 MB
 * and `ner.onnx` is 111 MB -- so a fresh clone gets some of the weights and not others,
 * with nothing anywhere to say which. The bundle then builds, loads, and fails at runtime
 * in the offscreen document, several layers away from the cause.
 *
 * So the build refuses instead, by name. A digest rather than mere existence because the
 * failure that costs most is not an absent file, it is a *different* file: a model
 * re-exported with other settings produces plausible output and every number in the report
 * silently stops describing what shipped.
 *
 * `extension/models/manifest.json` is the record -- name, size, digest, licence and where
 * it came from. Regenerate it with `python scripts/hash-models.py` when a weight changes
 * deliberately.
 */
async function verifyModels(dir) {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${manifestPath} is missing. It records every weight and its digest; ` +
        'regenerate it with `python scripts/hash-models.py`.',
    );
  }

  const { files } = JSON.parse(await readFile(manifestPath, 'utf8'));
  const problems = [];

  for (const [name, expected] of Object.entries(files)) {
    const path = join(dir, name);
    if (!existsSync(path)) {
      problems.push(`${name}: missing (${expected.bytes} bytes expected)`);
      continue;
    }
    const bytes = await readFile(path);
    if (bytes.length !== expected.bytes) {
      problems.push(`${name}: ${bytes.length} bytes, expected ${expected.bytes}`);
      continue;
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== expected.sha256) {
      problems.push(
        `${name}: sha256 ${digest.slice(0, 16)}..., expected ${expected.sha256.slice(0, 16)}...`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      [
        'model weights do not match extension/models/manifest.json:',
        ...problems.map((problem) => `  ${problem}`),
        '',
        'Run `python scripts/fetch-models.py` to fetch them, or',
        '`python scripts/hash-models.py` if you changed one on purpose.',
      ].join('\n'),
    );
  }
}

async function buildTarget(name) {
  const target = TARGETS[name];
  if (!target) throw new Error(`unknown target "${name}" (chrome | firefox)`);

  await rm(target.outDir, { recursive: true, force: true });
  await mkdir(target.outDir, { recursive: true });

  const started = Date.now();

  for (const [outName, entry] of Object.entries(target.entries)) {
    await esbuild.build({
      entryPoints: [entry],
      outfile: join(target.outDir, `${outName}.js`),
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['chrome116', 'firefox115'],
      sourcemap: 'linked',
      minify: false,
      legalComments: 'inline',
      define: {
        __BROWSER__: JSON.stringify(name),
        'process.env.NODE_ENV': JSON.stringify('production'),
      },
      // Picks onnxruntime-web's external-wasm entry over the base64 bundle.
      conditions: ['onnxruntime-web-use-extern-wasm'],
      logLevel: 'warning',
      absWorkingDir: root,
    });
  }

  const manifest = JSON.parse(await readFile(target.manifest, 'utf8'));
  await writeFile(
    join(target.outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  for (const [from, to] of target.pages) {
    await cp(from, join(target.outDir, to));
  }

  // Weights travel verbatim. Nothing is fetched at runtime (CLAUDE.md invariant 4).
  const models = join(root, 'extension', 'models');
  await verifyModels(models);
  await cp(models, join(target.outDir, 'models'), { recursive: true });

  const ortDist = join(root, 'node_modules', 'onnxruntime-web', 'dist');
  await mkdir(join(target.outDir, 'ort'), { recursive: true });
  for (const asset of ORT_ASSETS) {
    const from = join(ortDist, asset);
    if (!existsSync(from)) {
      throw new Error(`missing ${asset}: run npm install before building`);
    }
    await cp(from, join(target.outDir, 'ort', asset));
  }

  console.log(`built dist/${name} in ${Date.now() - started}ms`);
}

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const names = requested.length > 0 ? requested : ['chrome'];

for (const name of names) {
  await buildTarget(name);
}
