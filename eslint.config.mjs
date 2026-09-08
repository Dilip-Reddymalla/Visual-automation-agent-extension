import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Guard rails live here. See CLAUDE.md, invariants 1 and 8.
 *
 *  - Only extension/src/redaction/gate.ts may name a canvas encoder.
 *  - redaction/ and offscreen/tasks/ must stay free of browser globals so they are
 *    unit-testable in plain Node.
 */

const ENCODERS = /^(toBlob|toDataURL|convertToBlob)$/;
const ENCODER_MESSAGE =
  'Canvas encoders are the redaction gate only (CLAUDE.md invariant 1). ' +
  'Pixels leave the device through extension/src/redaction/gate.ts and nowhere else.';

const NODE_PURE_MESSAGE =
  'shared/, redaction/ and offscreen/tasks/ must not touch browser globals ' +
  '(CLAUDE.md invariant 8 / conventions). Take what you need as a parameter, or put ' +
  'the browser call in platform/.';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'extension/models/**',
      'eval/report/**',
      'server/**',
      'demo/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        chrome: 'readonly',
        browser: 'readonly',
        console: 'readonly',
        document: 'readonly',
        window: 'readonly',
        self: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        crypto: 'readonly',
        performance: 'readonly',
        structuredClone: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      // Stub signatures document what a later module must accept, so an unused
      // parameter is expected until that module lands. Unused *variables* are not.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'all' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },

  // ── Guard rail 1: the encoder ban ────────────────────────────────────────────
  {
    files: ['extension/**/*.{ts,mjs,js}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: `Identifier[name=${ENCODERS}]`, message: ENCODER_MESSAGE },
        { selector: `Literal[value=${ENCODERS}]`, message: ENCODER_MESSAGE },
        {
          selector: `MemberExpression[computed=true][property.value=${ENCODERS}]`,
          message: ENCODER_MESSAGE,
        },
      ],
    },
  },
  {
    // The one exemption in the tree.
    files: ['extension/src/redaction/gate.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  // ── Guard rail 3: node-pure modules ──────────────────────────────────────────
  {
    files: [
      'extension/src/redaction/**/*.ts',
      'extension/src/offscreen/tasks/**/*.ts',
      'extension/src/offscreen/host.ts',
      'extension/src/offscreen/sessions.ts',
      'extension/src/offscreen/timings.ts',
      'extension/src/offscreen/smoke.ts',
      'extension/src/offscreen/fake-runtime.ts',
      'extension/src/shared/**/*.ts',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'chrome', message: NODE_PURE_MESSAGE },
        { name: 'browser', message: NODE_PURE_MESSAGE },
        { name: 'window', message: NODE_PURE_MESSAGE },
        { name: 'document', message: NODE_PURE_MESSAGE },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/offscreen/adapters/*', '**/worker/*', '**/content/*'],
              message: NODE_PURE_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  // Test doubles implement the interfaces they stand in for, including the canvas one.
  // Nothing outside a test imports extension/src/testing/, so none of it reaches a
  // bundle -- boundaries.test.ts asserts that, and `npm run test:gate` reads the
  // bundles, so the shipped guarantee is untouched.
  {
    // The label tool is a plain browser page with no build step, so it uses the DOM APIs
    // directly rather than through the extension's own wrappers.
    files: ['eval/label_tool/*.js'],
    languageOptions: {
      globals: {
        Blob: 'readonly',
        URL: 'readonly',
        JSON: 'readonly',
      },
    },
  },

  {
    files: ['extension/src/testing/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  {
    files: ['**/*.test.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
      },
    },
  },

  {
    files: ['scripts/**/*.mjs', 'extension/build.mjs', '*.mjs', '*.ts'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },
);
