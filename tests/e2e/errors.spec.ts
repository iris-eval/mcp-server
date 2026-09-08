/*
 * The failure states a reader can hit (arc 7, D-1), driven through the real
 * dashboard in a real browser.
 *
 *   - an address the router does not know → the not-found page, inside the
 *     shell, with the address and the section links;
 *   - the API not answering → the widget that asked says "Iris did not
 *     answer" in its own place, and the page around it still renders.
 *
 * The second is produced by aborting every /api/v1 request at the browser,
 * which is what a stopped server looks like from the page's side.
 */
import { test, expect } from '@playwright/test';

test.describe('failure states', () => {
  test('an unknown address gets the not-found page, inside the shell', async ({ page }) => {
    await page.goto('/no/such/page');
    await expect(page.getByRole('heading', { name: 'Nothing at this address' })).toBeVisible();
    await expect(page.getByText('/no/such/page')).toBeVisible();
    await expect(page.locator('h1')).toHaveText('Not found');
    // The shell is still there: the sidebar's own landmark.
    await expect(page.getByRole('navigation').first()).toBeVisible();
    await page.getByRole('link', { name: 'Dashboard' }).first().click();
    await expect(page.locator('h1')).toHaveText('Dashboard');
  });

  test('when the API does not answer, the widget says so and the page stays up', async ({ page }) => {
    await page.route('**/api/v1/**', (route) => route.abort('connectionrefused'));
    await page.goto('/');
    const alert = page.getByRole('alert').filter({ hasText: 'Iris did not answer' }).first();
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute('data-error-kind', 'unreachable');
    // The page around the failed widget rendered: its title and its tabs.
    await expect(page.locator('h1')).toHaveText('Dashboard');
    await expect(page.getByRole('tab', { name: 'Failures' })).toBeVisible();
    // A retry is offered on this kind.
    await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});
