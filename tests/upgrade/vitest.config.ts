import { defineConfig } from 'vitest/config';

// The upgrade tests install the previous release from npm and upgrade a
// database it wrote with this checkout (#704). They need the network, so
// they run in CI's upgrade job and the root config excludes them; the
// suite's counts are then the same on every platform and offline.
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/upgrade/**/*.test.ts'],
    // The runtime guard first, as in every config (src/runtime-guard.ts).
    setupFiles: ['./tests/setup/runtime-guard.ts', './tests/setup/iris-home.ts'],
    testTimeout: 180_000,
    hookTimeout: 300_000,
  },
});
