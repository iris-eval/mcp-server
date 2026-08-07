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
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    globals: false,
  },
});
