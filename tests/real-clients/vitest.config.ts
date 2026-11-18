import { defineConfig } from 'vitest/config';

// The real-client tests install the packed server into MCP clients on the
// runner and ask each client whether it connected. They run only in CI's
// real-clients job (IRIS_REAL_CLIENTS=1), so the root config excludes them and
// the suite's counts are the same on every platform.
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/real-clients/**/*.test.ts'],
    // The runtime guard first, as in every configuration whose tests evaluate (src/runtime-guard.ts).
    setupFiles: ['./tests/setup/runtime-guard.ts', './tests/setup/iris-home.ts'],
    testTimeout: 180_000,
  },
});
