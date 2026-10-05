import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    // The real-client tests start installed MCP clients, the MCPB tests a
    // built bundle, the stall guard measures time and must run alone, and the
    // upgrade tests the previous release from npm; only their CI jobs run them,
    // through each folder's own vitest.config.ts.
    exclude: ['**/node_modules/**', 'tests/real-clients/**', 'tests/mcpb/**', 'tests/stall/**', 'tests/upgrade/**'],
    /*
     * Confines every in-process test to a scratch IRIS_HOME. Without it, a
     * test that builds a server from defaultConfig writes to the developer's
     * real ~/.iris — mcp-protocol.test.ts was appending to their actual
     * audit.log on every run. See tests/setup/iris-home.ts.
     */
    setupFiles: ['./tests/setup/iris-home.ts'],
    /*
     * Half the cores, not vitest's default of all but one: each worker is a
     * process with its own V8 garbage-collector and compiler threads, and at
     * 19 workers on a 20-core machine the CPU-heavy tests starved each other.
     * Measured there, the root suite took 78 s at the default and 61-62 s at
     * half; the composite measurement 33 s against 15 s, the judge composite
     * 44 s against 26 s; 53 tests ran over 2 s against 33-34. CI keeps the
     * default: on its 4-core runners half is 2 workers instead of 3, and the
     * Linux test jobs ran 10-30 s slower.
     */
    maxWorkers: process.env.CI ? undefined : '50%',
    /*
     * 30 s a test on a developer's machine, vitest's 5 s in CI. `npm run
     * preflight` runs this suite under coverage on whatever else the machine
     * is doing, and there 5 s measured the machine, not the test: on
     * 2026-10-05, in four preflight runs on the 20-core machine above, a test
     * that takes 45 ms alone (its first import of a module) timed out at 5 s
     * twice, and one that starts a Node process once, each failing a
     * 25-minute run. CI's runners do nothing else, keep the 5 s, and still
     * fail a test that is genuinely slow.
     */
    testTimeout: process.env.CI ? undefined : 30_000,
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
