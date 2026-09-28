import { defineConfig } from 'vitest/config';

// The event-loop stall guard measures time, so it runs alone, in CI's
// stall-guard job, with no other test file competing for the CPU. The root
// config excludes it.
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/stall/**/*.test.ts'],
    setupFiles: ['./tests/setup/iris-home.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
