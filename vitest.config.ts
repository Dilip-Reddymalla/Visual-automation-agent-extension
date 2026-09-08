import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['extension/src/**/*.test.ts', 'scripts/**/*.test.ts', 'eval/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
