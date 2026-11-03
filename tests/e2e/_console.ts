/*
 * The console errors and uncaught exceptions a page produces, for specs
 * that require none.
 *
 * One report is left out, in WebKit only. When a navigation cancels a
 * fetch the page being left still had in flight, WebKit reports
 * "Fetch API cannot load <url> due to access control checks." as an
 * error, where Chromium and Firefox report nothing; Playwright delivers it
 * as a page error. That report is dropped only while the page is
 * navigating, from the main frame's navigation request until the new
 * page's load event, so the same message at any other time (a request
 * refused by a real access-control check) still fails the spec.
 */
import type { Page } from '@playwright/test';

const CANCELLED_FETCH = /Fetch API cannot load .* due to access control checks\.?$/;

export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  let navigating = false;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigating = true;
  });
  page.on('load', () => {
    navigating = false;
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    // Playwright splits WebKit's message at its first colon, the one in "http:".
    if (navigating && CANCELLED_FETCH.test(`${err.name}:${err.message}`)) return;
    errors.push(err.message);
  });
  return errors;
}
