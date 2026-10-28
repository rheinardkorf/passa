import { defineConfig } from 'vitest/config';

// Integration tests against Moto. Start it first with `pnpm local:up`.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.int.test.ts'],
    testTimeout: 20_000,
  },
});
