import { defineConfig } from 'vitest/config';

// Unit tests only. Integration tests (*.int.test.ts) need Moto: see vitest.int.config.ts.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    exclude: ['**/*.int.test.ts', '**/node_modules/**'],
  },
});
