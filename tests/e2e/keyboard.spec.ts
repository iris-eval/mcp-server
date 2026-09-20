/*
 * Keyboard only (arc 7, D-9): no pointer anywhere in this file. The
 * sidebar is reached by Tab and followed by Enter, the palette opens on
 * Ctrl+K and runs a command on Enter, and a label is written from the
 * keyboard on the trace page.
 */
import { NAV_LABELS } from '../../dashboard/src/components/layout/navLabels.js';
import { test, expect, type Page } from '@playwright/test';

/** Tab until the focused element has this accessible name, or give up after `budget` presses. */
async function tabTo(page: Page, name: string, budget = 40): Promise<void> {
  for (let i = 0; i < budget; i++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? (el.getAttribute('aria-label') ?? el.textContent ?? '').trim() : '';
    });
    if (focused === name) return;
  }
  throw new Error(`nothing named "${name}" received focus within ${budget} Tab presses`);
}

test.describe('keyboard only', () => {
  test('Tab reaches the sidebar and Enter follows a link', async ({ page }) => {
    await page.goto('/');
    await tabTo(page, NAV_LABELS.runs);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/runs$/);
    await expect(page.locator('h1')).toHaveText(NAV_LABELS.runs);
  });

  test('Ctrl+K opens the palette, typing narrows it, Enter runs the command', async ({ page }) => {
    await page.goto('/');
    // The shortcut is bound once the shell has rendered; press it after the title is up.
    await expect(page.locator('h1')).toHaveText(NAV_LABELS.failures);
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await expect(palette).toBeVisible();
    await page.keyboard.type(NAV_LABELS.rules);
    await expect(palette.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/rules$/);
  });

  test('a fired rule can be labelled from the keyboard', async ({ page }) => {
    await page.goto('/traces/e2e-trace-0019');
    const right = page.locator('[data-label-control="cost_under_threshold"]').getByRole('button', { name: 'right' });
    await right.focus();
    await expect(right).toBeFocused();
    const written = page.waitForResponse((res) => res.url().endsWith('/api/v1/labels') && res.request().method() === 'POST');
    await page.keyboard.press('Enter');
    expect((await written).status()).toBe(201);
    await expect(right).toHaveAttribute('aria-pressed', 'true');
    // The outcome is announced in the live region, not only drawn.
    await expect(page.locator('[data-eval-id="e2e-eval-0019"] [data-eval-note]')).toContainText('cost_under_threshold: 1 of 20 labels');
  });
});
