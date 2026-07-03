import { defineConfig } from 'vitest/config';

// Local config so vitest does NOT walk up to the repo root's
// vitest.config.ts — in isolated CI checkouts (release-init.yml,
// bootstrap workflow) only this package's node_modules exist, and the
// root config's imports fail with ERR_MODULE_NOT_FOUND.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
