import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Mirror vite.config.ts — components read the server version + claim counts
// from these build-time defines; tests need the same globals.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
  version: string;
};
const claims = JSON.parse(readFileSync(new URL('../.claims.json', import.meta.url), 'utf-8')) as {
  evalRules: { builtInCount: number };
};

export default defineConfig({
  plugins: [react()],
  define: {
    __IRIS_VERSION__: JSON.stringify(pkg.version),
    __IRIS_RULE_COUNT__: JSON.stringify(claims.evalRules.builtInCount),
  },
  test: {
    environment: 'jsdom',
    /*
     * Half the cores, not vitest's default of all but one. Each worker is a
     * process with its own jsdom and its own V8 garbage-collector threads,
     * and at 19 workers on a 20-core machine they starved each other: the
     * suite took 25-27 s, its slowest test 4.8-5.5 s against the 5 s
     * timeout (it failed 2 of 3 plain runs), and 18-22 tests passed 2 s. At
     * half the cores the same suite took 23 s and its slowest test 2.6-2.9 s,
     * with 3-4 tests over 2 s.
     */
    maxWorkers: '50%',
    /*
     * Every test here renders React into jsdom, and half the files then run
     * axe over the result; that work is the test. With 20 busy-loop
     * processes on the same 20-core machine, and at half the cores, the
     * heaviest measured up to 8.0 s over ten runs (a 50-row trace list rendered three
     * times; the populated moment page and the verdict panel through axe at
     * about 6 s each) and 7-8 tests missed vitest's 5 s default in each of
     * four runs. An axe run cut off by the timeout also fails every later
     * axe test in its file ("Axe is already running"). 20 s is about two and
     * a half times the loaded maximum.
     */
    testTimeout: 20_000,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    globals: false,
  },
});
