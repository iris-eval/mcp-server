import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    /*
     * Confines every in-process test to a scratch IRIS_HOME. Without it, a
     * test that builds a server from defaultConfig writes to the developer's
     * real ~/.iris — mcp-protocol.test.ts was appending to their actual
     * audit.log on every run. See tests/setup/iris-home.ts.
     */
    setupFiles: ['./tests/setup/iris-home.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types/**', 'src/**/index.ts'],
      // Ratchet floors — enforced in CI (the test job runs `npm run test:coverage`).
      // Measured 2026-07-07: statements 75.93 / branches 69.42 / functions 79.32 /
      // lines 76.31. The previous 80s were aspirational and never enforced (CI ran
      // plain `vitest run`). Raise a floor when coverage grows past it; never lower
      // one. Target remains 80 across the board.
      thresholds: {
        lines: 75,
        branches: 68,
        functions: 78,
        statements: 75,
      },
    },
  },
});
