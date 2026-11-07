import { defineConfig } from 'vitest/config';

// Integration tests against Moto. Start it first with `pnpm local:up`.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.int.test.ts'],
    testTimeout: 20_000,
    // Setting up starts the whole local stack against Moto (and, for the
    // browser tests, Chrome) while other files use Moto too; the 10 s default
    // was too tight, and timed out in CI now and then.
    hookTimeout: 60_000,
  },
});
