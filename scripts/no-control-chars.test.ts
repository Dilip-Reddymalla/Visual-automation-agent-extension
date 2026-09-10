/**
 * No stray control characters anywhere in the source tree.
 *
 * This exists because of a bug that cost an afternoon and was invisible in every diff.
 * A regex meant to read `\b(?:with|as)` was written with a literal backspace instead of
 * the two-character escape, so the pattern never matched -- and the source looked
 * completely normal in an editor, in `git diff`, and in a code review. The same slip put a
 * NUL inside a template literal in `worker/progress.ts`, where it became the separator in
 * every persisted ledger key.
 *
 * Neither was caught by the type checker, the linter or any test, because both files were
 * valid TypeScript and valid Python. The only thing that distinguishes them from correct
 * code is a byte nobody can see, which is exactly the kind of thing a machine should be
 * looking for instead of a person.
 *
 * Tab, newline and carriage return are the three that belong in a text file. Everything
 * else in the C0 range, plus DEL, is a mistake.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '__pycache__',
  'report',
  'models',
]);

const CHECKED = /\.(ts|tsx|mjs|js|py|json|md|html|css|yml|yaml)$/;

/** Tab (9), newline (10) and carriage return (13) are text. Nothing else under 32 is. */
function offendingBytes(text: string): Array<{ code: number; at: number }> {
  const found: Array<{ code: number; at: number }> = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127) found.push({ code, at: i });
  }
  return found;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') && entry !== '.github') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      sourceFiles(path, out);
    } else if (CHECKED.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

describe('the source tree', () => {
  it('has no invisible control characters in it', () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(ROOT)) {
      const text = readFileSync(path, 'utf8');
      const found = offendingBytes(text);
      if (found.length === 0) continue;
      const where = found
        .slice(0, 3)
        .map((f) => `0x${f.code.toString(16)} at offset ${f.at}`)
        .join(', ');
      offenders.push(`${relative(ROOT, path)}: ${where}`);
    }

    // Named rather than counted: the point of the failure is to say which byte and where,
    // because the one thing this bug never does is show itself.
    expect(offenders).toEqual([]);
  });

  it('recognises the two characters that actually caused this', () => {
    // A backspace inside a regex, and a NUL inside a template literal.
    expect(offendingBytes(`re.search("${String.fromCharCode(8)}(?:with)")`)).toHaveLength(1);
    expect(offendingBytes(`\`\${verb}${String.fromCharCode(0)}\${target}\``)).toHaveLength(1);
    expect(offendingBytes('a normal line\twith a tab\r\n')).toEqual([]);
  });
});
