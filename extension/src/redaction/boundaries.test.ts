import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Guard rail 3 (CLAUDE.md invariant 8 and the conventions section).
 *
 * redaction/ and offscreen/tasks/ must be testable in Node with no browser globals,
 * because that is what lets the PII layers and the gate have real unit tests instead of
 * a headless-browser suite nobody runs. This test reads the source and says so out loud
 * when something drifts.
 *
 * It also checks the encoder ban at the source level. scripts/test-gate.mjs checks the
 * same thing in the built bundle, which is the check that cannot be disabled inline.
 */

const SRC = resolve(import.meta.dirname, '..');

const NODE_PURE_DIRS = [
  join(SRC, 'shared'),
  join(SRC, 'redaction'),
  join(SRC, 'offscreen', 'tasks'),
];

const BROWSER_GLOBALS = [
  { name: 'chrome', re: /\bchrome\s*\./ },
  { name: 'browser', re: /\bbrowser\s*\./ },
  { name: 'window', re: /\bwindow\s*\./ },
  { name: 'document', re: /\bdocument\s*\./ },
  { name: 'localStorage', re: /\blocalStorage\b/ },
  { name: 'fetch', re: /\bfetch\s*\(/ },
];

const FORBIDDEN_IMPORT = /from\s+'[^']*\/(worker|content|adapters|platform)\//;

const ENCODERS = /\b(toBlob|toDataURL|convertToBlob)\b/;
const GATE = join(SRC, 'redaction', 'gate.ts');

/** Prose is allowed to say "document." -- code is not. Scan code only. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function allSourceFiles(): string[] {
  return tsFiles(SRC);
}

describe('node-pure modules', () => {
  const files = NODE_PURE_DIRS.flatMap(tsFiles);

  it('finds the modules it is supposed to police', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it.each(files.map((f) => [relative(SRC, f), f]))(
    '%s uses no browser globals',
    (_rel, file) => {
      const text = stripComments(readFileSync(file, 'utf8'));
      const offenders = BROWSER_GLOBALS.filter((g) => g.re.test(text)).map((g) => g.name);
      expect(offenders).toEqual([]);
    },
  );

  it.each(files.map((f) => [relative(SRC, f), f]))(
    '%s imports nothing from a browser-bound layer',
    (_rel, file) => {
      expect(FORBIDDEN_IMPORT.test(stripComments(readFileSync(file, 'utf8')))).toBe(false);
    },
  );
});

/**
 * Test scaffolding that stands in for a browser type has to name that type's methods,
 * canvas encoders included. Exempting it is only safe because none of it ships, which
 * is the next test's job to prove rather than to assume.
 */
const TEST_SUPPORT = join(SRC, 'testing');

describe('the encoder ban, at source level', () => {
  it('finds no canvas encoder outside the gate', () => {
    const offenders = allSourceFiles()
      .filter((f) => f !== GATE)
      .filter((f) => !f.startsWith(TEST_SUPPORT))
      .filter((f) => ENCODERS.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('keeps the exempted scaffolding out of every bundle', () => {
    // The exemption above is worth exactly this assertion. If production code ever
    // imports src/testing/, the encoder inside it becomes reachable, esbuild bundles
    // it, and the guarantee quietly narrows -- so the import is what gets banned.
    const importers = allSourceFiles()
      .filter((f) => !f.startsWith(TEST_SUPPORT) && !f.endsWith('.test.ts'))
      .filter((f) => /from\s+'[^']*\/testing\//.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(importers).toEqual([]);
  });

  it('has an eslint-disable nowhere near the encoder rule', () => {
    const disabled = allSourceFiles()
      .filter((f) => /eslint-disable[^\n]*no-restricted-syntax/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(disabled).toEqual([]);
  });
});
