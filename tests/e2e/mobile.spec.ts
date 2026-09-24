/*
 * 390 px: a phone-width viewport. The dashboard is best on a
 * tablet or wider and says so in a dismissable notice; at this width it
 * still renders every landmark, the failure list, and a trace page whose
 * controls can be used.
 */
import { NAV_LABELS } from '../../dashboard/src/components/layout/navLabels.js';
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

test.describe('390 px', () => {
  test('the notice, the landmarks, the list, and a usable trace page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText(NAV_LABELS.failures);
    await expect(page.getByRole('complementary', { name: /Main navigation/i })).toBeVisible();
    await expect(page.getByRole('banner')).toBeVisible();

    const notice = page.getByRole('status').filter({ hasText: 'best on tablet or desktop' });
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice).toHaveCount(0);
    // Dismissed for the session: a navigation does not bring it back.
    await page.goto('/?view=health');
    await expect(page.getByRole('status').filter({ hasText: 'best on tablet or desktop' })).toHaveCount(0);

    await page.goto('/');
    await expect(page.locator('a[href^="/moments/"]').first()).toBeVisible();
    // The page never scrolls sideways as a whole: the content, not the document, takes the overflow.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.goto('/traces/e2e-trace-0019');
    await expect(page.locator('[data-verdict-panel="cost"] [data-verdict-state]')).toHaveText('PASS');
    const control = page.locator('[data-label-control="cost_under_threshold"]');
    await expect(control).toBeVisible();
    await expect(control.getByRole('button', { name: 'wrong' })).toBeEnabled();
  });
});
