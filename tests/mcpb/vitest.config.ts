import { defineConfig } from 'vitest/config';

// The MCPB bundle tests start a built iris-eval.mcpb the way a host does.
// They run only in CI's mcpb job, which builds the bundle and points
// IRIS_MCPB_BUNDLE at it, so the root config excludes them and the suite's
// counts are the same on every platform.
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/mcpb/**/*.test.ts'],
    setupFiles: ['./tests/setup/iris-home.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
