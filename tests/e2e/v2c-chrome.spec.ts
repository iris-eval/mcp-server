/*
 * v2.C chrome E2E — density toggle + sidebar collapse persistence.
 *
 * These features have unit tests (DensitySync hook, AccountMenu a11y)
 * but the DOM-level persistence + reload behavior can only be proven
 * end-to-end. Regressions here would look like:
 *   - User toggles density, reloads, loses the preference
 *   - User collapses sidebar, reloads, loses the preference
 *   - <html data-density> stops matching the stored preference after
 *     a PATCH race
 *
 * Uses the shared fixture (font-blocking) so clicks don't race on
 * Google Fonts layout shifts in CI.
 */
import { test, expect } from './fixtures';

test.describe('v2.C chrome persistence', () => {
  test('density toggle applies data-density + persists across reload', async ({ page }) => {
    await page.goto('/');

    // Baseline: data-density is 'compact' (default per R2.3)
    const initialDensity = await page.evaluate(() =>
      document.documentElement.getAttribute('data-density'),
    );
    expect(initialDensity).toBe('compact');

    // Open AccountMenu, click "Comfortable". Wait for the PATCH response
    // so we know the server persisted before we reload — the AccountMenu
    // fires the patch as fire-and-forget, so without this wait the
    // reload navigation cancels the in-flight request.
    await page.getByRole('button', { name: 'Account menu' }).click();
    const patchResponse = page.waitForResponse(
      (res) =>
        res.url().endsWith('/api/v1/preferences') && res.request().method() === 'PATCH',
    );
    await page.getByRole('menuitemradio', { name: 'Comfortable' }).click();
    const patchRes = await patchResponse;
    expect(patchRes.status()).toBe(200);

    // data-density reflects optimistic update immediately
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.getAttribute('data-density')),
      )
      .toBe('comfortable');

    // Close menu + reload — preference must survive
    await page.keyboard.press('Escape');
    await page.reload();

    // After reload, DensitySync waits for preferences to finish loading
    // before applying data-density. Poll rather than read once so the
    // assertion succeeds as soon as the hook hydrates.
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.getAttribute('data-density')),
      )
      .toBe('comfortable');

    // Clean up for the next test: reset to compact + wait for patch
    await page.getByRole('button', { name: 'Account menu' }).click();
    const resetResponse = page.waitForResponse(
      (res) =>
        res.url().endsWith('/api/v1/preferences') && res.request().method() === 'PATCH',
    );
    await page.getByRole('menuitemradio', { name: 'Compact' }).click();
    await resetResponse;
  });

  test('sidebar collapse persists across reload', async ({ page }) => {
    await page.goto('/');

    const sidebar = page.getByRole('complementary', { name: /Main navigation/i });
    // Baseline: sidebar expanded (256px). We don't measure CSS pixels
    // (that varies with browser chrome); instead we observe that the
    // brand wordmark is visible when expanded but NOT when collapsed.
    await expect(sidebar.getByText('Iris')).toBeVisible();

    // Click the collapse toggle; wait for PATCH before reload.
    const toggleBtn = sidebar.getByRole('button', { name: /collapse/i });
    const collapsePatch = page.waitForResponse(
      (res) =>
        res.url().endsWith('/api/v1/preferences') && res.request().method() === 'PATCH',
    );
    await toggleBtn.click();
    await collapsePatch;

    // Wordmark hidden when collapsed
    await expect(sidebar.getByText('Iris')).toBeHidden();

    // Reload — state must persist (preferences.sidebarCollapsed=true)
    await page.reload();
    const sidebarAfter = page.getByRole('complementary', { name: /Main navigation/i });
    await expect(sidebarAfter.getByText('Iris')).toBeHidden();

    // Clean up: expand again; wait for patch so next test sees clean state
    const expandPatch = page.waitForResponse(
      (res) =>
        res.url().endsWith('/api/v1/preferences') && res.request().method() === 'PATCH',
    );
    await sidebarAfter.getByRole('button', { name: /expand/i }).click();
    await expandPatch;
  });

  test('notifications popover unread badge clears on open', async ({ page, request }) => {
    await page.goto('/audit');

    // The seeded audit log contains 1 entry (globalSetup). globalSetup
    // also resets notificationsLastSeen to the epoch so the seeded entry
    // always registers as unread. Poll the bell's aria-label since the
    // useAuditLog hook may still be fetching on first paint.
    const bell = page.getByRole('button', { name: /Notifications/i });
    await expect.poll(async () => bell.getAttribute('aria-label')).toMatch(/\d+ unread/);

    // Open — this should PATCH notificationsLastSeen
    await bell.click();
    await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();

    // Close popover
    await page.keyboard.press('Escape');

    // After the patch propagates, the badge clears.
    await expect
      .poll(async () => await bell.getAttribute('aria-label'))
      .toBe('Notifications');

    // Verify the PATCH actually landed on the server side
    const prefsRes = await request.get('/api/v1/preferences');
    expect(prefsRes.ok()).toBe(true);
    const prefsData = await prefsRes.json();
    expect(prefsData.preferences.notificationsLastSeen).toBeDefined();
  });
});
