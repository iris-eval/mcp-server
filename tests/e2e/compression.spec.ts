/*
 * The built dashboard goes out compressed, in a real browser.
 *
 * The npm package carries a .br and a .gz beside each file the dashboard
 * build emits; the server sends the one the browser accepts, and compresses
 * API responses of 1 KB or more for a client on another machine (never on
 * loopback, where this browser is). This checks the shipped build end to end:
 * the browser receives the entry chunk encoded and runs it, and the encoded
 * file is byte-for-byte the plain one once decoded.
 */
import { test, expect } from '@playwright/test';

test.describe('compressed responses', () => {
  test('the browser receives the entry chunk compressed, runs it, and the page renders', async ({ page }) => {
    const entry = new Promise<{ encoding: string | undefined; vary: string | undefined; type: string | undefined }>((resolve) => {
      page.on('response', async (r) => {
        if (/\/assets\/index-[^/]+\.js$/.test(new URL(r.url()).pathname)) {
          const h = await r.allHeaders();
          resolve({ encoding: h['content-encoding'], vary: h.vary, type: h['content-type'] });
        }
      });
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 2, name: 'What failed' })).toBeVisible();
    const seen = await entry;
    expect(['br', 'gzip']).toContain(seen.encoding);
    expect(seen.vary ?? '').toMatch(/Accept-Encoding/i);
    expect(seen.type ?? '').toMatch(/javascript/);
  });

  test('each encoding of an asset decodes to the same bytes as the plain file', async ({ page, request }) => {
    const chunk = new Promise<string>((resolve) => {
      page.on('response', (r) => {
        if (/\/assets\/index-[^/]+\.js$/.test(new URL(r.url()).pathname)) resolve(new URL(r.url()).pathname);
      });
    });
    await page.goto('/');
    const path = await chunk;
    const plain = await request.get(path, { headers: { 'accept-encoding': 'identity' } });
    expect(plain.headers()['content-encoding']).toBeUndefined();
    const plainBytes = await plain.body();
    for (const coding of ['br', 'gzip']) {
      const r = await request.get(path, { headers: { 'accept-encoding': coding } });
      expect(r.status(), coding).toBe(200);
      expect(r.headers()['content-encoding'], coding).toBe(coding);
      // Playwright decodes the body; what it decodes to must be the plain file.
      expect((await r.body()).equals(plainBytes), coding).toBe(true);
    }
  });

  test('a large API response goes to a page on this machine uncompressed, and never compressed for a cross-site request', async ({ request }) => {
    const same = await request.get('/api/v1/capabilities', { headers: { 'accept-encoding': 'br, gzip', 'sec-fetch-site': 'same-origin' } });
    expect(same.status()).toBe(200);
    // Loopback: there is no network to save, so the answer goes out as it is (the unit tests cover a client on another machine).
    expect(same.headers()['content-encoding']).toBeUndefined();
    const cross = await request.get('/api/v1/capabilities', { headers: { 'accept-encoding': 'br, gzip', 'sec-fetch-site': 'cross-site' } });
    expect(cross.headers()['content-encoding']).toBeUndefined();
    expect(await cross.json()).toEqual(await same.json());
  });
});
