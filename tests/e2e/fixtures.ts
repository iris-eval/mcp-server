/*
 * Playwright test fixtures — shared setup applied to every spec.
 *
 * The dashboard's tokens.css imports fonts from fonts.googleapis.com.
 * In CI (cold runner, slow first-contact, sometimes outbound-restricted)
 * the font fetch may take several seconds and triggers layout shifts
 * that keep Playwright's click actionability check from ever declaring
 * the target element "stable" — so `click()` times out at 30s even
 * though the locator resolved immediately.
 *
 * Blocking font requests at the network layer makes the layout settle
 * on the system fallback (Space Grotesk → -apple-system → Arial) and
 * lets click() succeed deterministically. The tests exercise
 * functionality, not typography — the block is sound.
 *
 * Every spec should `import { test, expect } from './fixtures'` instead
 * of `from '@playwright/test'` to inherit this behavior.
 */
import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  page: async ({ page }, use) => {
    // Short-circuit Google Fonts with empty responses instead of aborting.
    // `route.abort()` surfaces ERR_FAILED console errors that trip the
    // smoke suite's zero-console-errors assertion. Empty successful
    // responses let the CSS @import "succeed" with no font-face rules,
    // so layout falls back to the system font stack silently.
    await page.route(/\/\/fonts\.googleapis\.com\//, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/css',
        body: '/* fonts blocked for e2e determinism */',
      }),
    );
    await page.route(/\/\/fonts\.gstatic\.com\//, (route) =>
      route.fulfill({ status: 200, contentType: 'font/woff2', body: '' }),
    );
    await use(page);
  },
});

export { expect };
