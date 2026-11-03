/*
 * The key a keyboard user presses to move to the next focusable element.
 *
 * Tab in Chromium and Firefox. In WebKit it is Option+Tab (`Alt+Tab` to
 * Playwright): Safari's Tab moves only between form controls and buttons
 * and skips links unless the user has turned on "Press Tab to highlight
 * each item" in Safari's settings, while Option+Tab moves through every
 * focusable element, links included. Playwright's WebKit keeps Safari's
 * default, so walking a page with plain Tab there would report every link
 * as unreachable when a Safari user reaches it with Option+Tab.
 */
import type { Page } from '@playwright/test';

export function nextStopKey(page: Page): 'Tab' | 'Alt+Tab' {
  return page.context().browser()?.browserType().name() === 'webkit' ? 'Alt+Tab' : 'Tab';
}
