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
    /*
     * One retry per case. A hosted runner now and then stalls a process on
     * its own (on this job, once in several runs: 322 ms in one attempt and
     * 96 ms in the next, on the same commit); a stall the code causes is
     * there on every attempt, as the code before the steps was (3.3 s and
     * 0.5 s, each time).
     */
    retry: 1,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
