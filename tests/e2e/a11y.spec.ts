/*
 * Accessibility, in a real browser, on every page the dashboard serves,
 * in the dark theme and the light one.
 *
 * On each page:
 *   - axe-core finds no WCAG 2.0 / 2.1 / 2.2 A or AA violation and no
 *     best-practice violation (tests/e2e/_axe.ts);
 *   - every id an ARIA relationship or a <label for> names exists on the
 *     page (a tab whose panel id is missing reads as "controls nothing");
 *   - Tab walks the page end to end without being trapped, every stop
 *     shows a focus indicator and is on screen, and every control a
 *     pointer can use is a Tab stop, or sits in a group (tabs, radios,
 *     a menu) whose one Tab stop is reached and whose arrow keys move
 *     within it.
 *
 * Each overlay (account menu, notifications, command palette, keyboard
 * shortcuts, the tour) is checked open: axe, focus moved into it, and
 * Escape closing it with focus returned to where it was.
 *
 * Colour contrast is enforced like every other rule. CONTRAST_PENDING is
 * where a rule would go if a known failure had to be reported without
 * failing the run; it is empty.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { AXE_VERSION, describeViolations, runAxe } from './_axe.js';

/** Rules reported but not yet enforced. None. */
const CONTRAST_PENDING = new Set<string>();

const THEMES = ['dark', 'light'] as const;
type Theme = (typeof THEMES)[number];

interface PageCase {
  path: string;
  /** Something only that page's own content renders, so the check runs on the page and not on a loading state. */
  ready: (page: Page) => Locator;
}

/** The page's own content: something in <main> other than the loading status or an error. */
const pageContent = (p: Page) => p.locator('main > :not([data-route-loading]):not([data-error-boundary])').first();

/*
 * Every route in dashboard/src/routes.tsx, each view of `/`, and the
 * not-found page, on the dataset tests/e2e/global-setup.ts seeds. The
 * moment page's id is the first moment the API returns.
 */
const PAGES: PageCase[] = [
  { path: '/', ready: (p) => p.getByRole('heading', { level: 2, name: 'What failed' }) },
  { path: '/?view=health', ready: (p) => p.getByRole('radio', { name: '30d' }) },
  { path: '/?view=drift', ready: (p) => p.getByRole('radio', { name: '7d' }) },
  { path: '/?view=stream', ready: (p) => p.getByRole('heading', { level: 2, name: 'Live now' }) },
  { path: '/moments', ready: (p) => p.getByLabel('Order moments') },
  { path: '/moments/:id', ready: (p) => p.getByRole('button', { name: /Make this a rule/i }) },
  { path: '/rules', ready: pageContent },
  { path: '/audit', ready: pageContent },
  { path: '/traces', ready: (p) => p.getByRole('button', { name: /Open trace/ }).first() },
  { path: '/traces?q=prompt', ready: (p) => p.getByRole('button', { name: /Open trace/ }).first() },
  { path: '/traces/e2e-trace-0019', ready: (p) => p.locator('[data-eval-id="e2e-eval-0019"]') },
  { path: '/traces/e2e-trace-0004', ready: (p) => p.locator('[data-eval-id="e2e-eval-0004"]') },
  { path: '/evals', ready: pageContent },
  { path: '/runs', ready: (p) => p.locator('[data-run-link="baseline"]') },
  { path: '/runs/baseline', ready: (p) => p.locator('[data-run-detail="baseline"]') },
  { path: '/cases/case-0', ready: (p) => p.locator('[data-case-detail="case-0"]') },
  { path: '/no-such-page', ready: (p) => p.locator('[data-page="not-found"]') },
];

/** Resolve `:id` in a path to a real record. */
async function resolvePath(page: Page, path: string): Promise<string> {
  if (!path.includes('/moments/:id')) return path;
  const res = await page.request.get('/api/v1/moments?limit=1');
  expect(res.ok()).toBe(true);
  const { moments } = (await res.json()) as { moments: Array<{ id: string }> };
  return path.replace(':id', encodeURIComponent(moments[0].id));
}

/** Open a page in a theme and wait for its own content. */
async function open(page: Page, theme: Theme, pageCase: PageCase): Promise<void> {
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem('iris-theme', t);
    } catch {
      /* the theme then follows prefers-color-scheme, set below */
    }
  }, theme);
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(await resolvePath(page, pageCase.path));
  await expect(pageCase.ready(page)).toBeVisible();
  await expect(page.locator('[data-route-loading]')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // Let the page's own requests settle, so axe sees the page and not a skeleton.
  await page.waitForLoadState('networkidle');
}

/** axe: no violation outside CONTRAST_PENDING; the pending ones are annotated on the test. */
async function expectNoAxeViolations(page: Page, where: string): Promise<void> {
  const violations = await runAxe(page);
  const pending = violations.filter((v) => CONTRAST_PENDING.has(v.id));
  const enforced = violations.filter((v) => !CONTRAST_PENDING.has(v.id));
  for (const v of pending) {
    test.info().annotations.push({ type: `pending: ${v.id}`, description: `${where}: ${v.nodes.length} element(s)` });
  }
  expect(enforced, `${where}\n${describeViolations(enforced)}`).toEqual([]);
}

/** Every id named by aria-controls, -labelledby, -describedby, -owns, -activedescendant, -errormessage, -details or <label for> exists. */
async function expectIdReferencesResolve(page: Page, where: string): Promise<void> {
  const missing = await page.evaluate(() => {
    const attrs = ['aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns', 'aria-activedescendant', 'aria-errormessage', 'aria-details', 'for'];
    const out: string[] = [];
    for (const attr of attrs) {
      for (const el of Array.from(document.querySelectorAll(`[${attr}]`))) {
        if (attr === 'for' && el.tagName !== 'LABEL') continue;
        for (const id of (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)) {
          if (!document.getElementById(id)) out.push(`${el.tagName.toLowerCase()}[${attr}="${id}"]`);
        }
      }
    }
    return out;
  });
  expect(missing, `${where}: ARIA or <label> references to ids that are not on the page`).toEqual([]);
}

interface TabStop {
  key: string;
  describe: string;
  indicator: boolean;
  onScreen: boolean;
}

/*
 * Press Tab from the top of the page until focus leaves the document or
 * comes back to a stop already seen. Each stop gets a data attribute so
 * the reachability check can match stops to controls. A native date
 * input takes one Tab per field (month, day, year) while staying the
 * focused element, so repeats of the stop just left are not a trap.
 */
async function walkTabStops(page: Page, limit = 500): Promise<{ stops: TabStop[]; trappedAt: string | null }> {
  /*
   * A last Tab stop marks the end of the page. Past the real last stop,
   * Chromium moves focus to <body> but Firefox hands it to the browser's
   * own controls and leaves activeElement unchanged, which would read as
   * a trap.
   */
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    const end = document.createElement('span');
    end.tabIndex = 0;
    end.dataset.a11yEnd = 'true';
    document.body.append(end);
    window.scrollTo(0, 0);
  });
  const stops: TabStop[] = [];
  const seen = new Set<string>();
  let repeats = 0;
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate((n) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || el === document.documentElement || el.dataset.a11yEnd) return null;
      if (!el.dataset.a11yStop) el.dataset.a11yStop = String(n);
      const cs = getComputedStyle(el);
      const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      const shadow = cs.boxShadow !== 'none';
      const r = el.getBoundingClientRect();
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
      const hit = document.elementFromPoint(cx, cy);
      const inView = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
      const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      return {
        key: el.dataset.a11yStop,
        describe: `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''} "${name}"`,
        indicator: outline || shadow,
        onScreen: inView && !!hit && (hit === el || el.contains(hit) || hit.contains(el)),
      };
    }, i);
    if (!stop) break;
    if (stop.key === stops[stops.length - 1]?.key) {
      if (++repeats > 8) return { stops, trappedAt: `${stop.describe} (Tab does not leave it)` };
      continue;
    }
    repeats = 0;
    if (seen.has(stop.key)) return { stops, trappedAt: `${stop.describe} (Tab cycles back before the end of the page)` };
    seen.add(stop.key);
    stops.push(stop);
    if (i === limit - 1) return { stops, trappedAt: `more than ${limit} stops` };
  }
  await page.evaluate(() => document.querySelector('[data-a11y-end]')?.remove());
  return { stops, trappedAt: null };
}

/*
 * Controls that are on screen and usable but that Tab never reached, and
 * elements given an interactive role that cannot take focus at all. An
 * item of a roving group (tab, radio, menu item) with tabIndex -1 is
 * reached through its group: the group must have had a Tab stop.
 */
async function unreachableControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const FOCUSABLE =
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [contenteditable=""], [contenteditable="true"], [tabindex]';
    const INTERACTIVE_ROLES = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'option', 'slider', 'spinbutton', 'textbox', 'combobox', 'searchbox', 'treeitem'];
    const ROVING_ROLES: Record<string, string> = { tab: '[role="tablist"]', radio: '[role="radiogroup"]', menuitem: '[role="menu"]', menuitemradio: '[role="menu"]', menuitemcheckbox: '[role="menu"]', option: '[role="listbox"]' };
    const visible = (el: Element): boolean =>
      (el as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? (el as HTMLElement).offsetParent !== null;
    const describe = (el: Element): string => {
      const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      return `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''} "${name}"`;
    };
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE))) {
      if (!visible(el) || el.closest('[inert], [aria-hidden="true"]')) continue;
      if ((el as HTMLButtonElement).disabled) continue;
      if (el.dataset.a11yStop) continue;
      const role = el.getAttribute('role') ?? '';
      if (el.tabIndex < 0) {
        const group = ROVING_ROLES[role] ? el.closest(ROVING_ROLES[role]) : null;
        // Not a group item: tabindex=-1 on purpose (focus is moved there by script).
        if (!group) continue;
        if (group.querySelector('[data-a11y-stop]')) continue;
        out.push(`${describe(el)}: its ${group.getAttribute('role')} has no Tab stop`);
        continue;
      }
      // A radio input shares one Tab stop with the rest of its group.
      if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
        const peers = document.querySelectorAll<HTMLElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`);
        if (Array.from(peers).some((p) => p.dataset.a11yStop)) continue;
      }
      out.push(`${describe(el)}: never reached by Tab`);
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(INTERACTIVE_ROLES.map((r) => `[role="${r}"]`).join(', ')))) {
      if (!visible(el) || el.closest('[inert], [aria-hidden="true"]')) continue;
      if (el.matches(FOCUSABLE)) continue;
      // An option or menu item may be managed by aria-activedescendant on its container.
      if (el.id && document.querySelector(`[aria-activedescendant="${CSS.escape(el.id)}"]`)) continue;
      if (el.closest('[aria-activedescendant]')) continue;
      out.push(`${describe(el)}: has an interactive role but cannot take focus`);
    }
    return out;
  });
}

async function expectKeyboardReachable(page: Page, where: string): Promise<void> {
  const { stops, trappedAt } = await walkTabStops(page);
  expect(trappedAt, `${where}: Tab is trapped`).toBeNull();
  expect(stops.length, `${where}: Tab reached nothing`).toBeGreaterThan(0);
  const noIndicator = stops.filter((s) => !s.indicator).map((s) => s.describe);
  expect(noIndicator, `${where}: Tab stops with no visible focus indicator (WCAG 2.4.7)`).toEqual([]);
  const hidden = stops.filter((s) => !s.onScreen).map((s) => s.describe);
  expect(hidden, `${where}: Tab stops that are off screen or covered when focused (WCAG 2.4.11)`).toEqual([]);
  expect(await unreachableControls(page), `${where}: controls the keyboard cannot reach (WCAG 2.1.1)`).toEqual([]);
}

test.describe('accessibility', () => {
  test('the axe engine is one that knows WCAG 2.2', () => {
    const [major, minor] = AXE_VERSION.split('.').map(Number);
    // wcag22aa rules arrived in axe-core 4.5; an older copy would pass them by not knowing them.
    expect(major > 4 || (major === 4 && minor >= 5), `axe-core ${AXE_VERSION}`).toBe(true);
  });

  test('the page list covers every route the dashboard has', () => {
    const routes = readFileSync(join(process.cwd(), 'dashboard', 'src', 'routes.tsx'), 'utf8');
    const paths = [...routes.matchAll(/route\('([^']+)'/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    const covered = PAGES.map((p) => p.path.split('?')[0]);
    const missing = paths.filter((route) => {
      const pattern = new RegExp(`^${route.replace(/:[^/]+/g, '[^/]+')}$`);
      return !covered.some((c) => pattern.test(c));
    });
    expect(missing, 'routes with no accessibility check: add them to PAGES').toEqual([]);
  });

  for (const theme of THEMES) {
    for (const pageCase of PAGES) {
      test(`${pageCase.path} (${theme}): axe, id references, and the keyboard`, async ({ page }) => {
        await open(page, theme, pageCase);
        const where = `${pageCase.path} (${theme})`;
        await expectNoAxeViolations(page, where);
        await expectIdReferencesResolve(page, where);
        await expectKeyboardReachable(page, where);
      });
    }
  }

  /** A keyboard reader's starting point for the shortcut-opened overlays: the selected view tab. */
  async function focusSelectedTab(p: Page): Promise<Locator> {
    const tab = p.getByRole('tab', { selected: true });
    await tab.focus();
    return tab;
  }

  interface Overlay {
    name: string;
    /** Opens the overlay from the keyboard; returns the element focus should return to on close. */
    open: (page: Page) => Promise<Locator>;
    surface: (page: Page) => Locator;
  }

  const OVERLAYS: Overlay[] = [
    {
      name: 'account menu',
      open: async (p) => {
        const trigger = p.getByRole('button', { name: 'Account menu' });
        await trigger.focus();
        await p.keyboard.press('Enter');
        return trigger;
      },
      surface: (p) => p.getByRole('menu', { name: 'Account options' }),
    },
    {
      name: 'notifications',
      open: async (p) => {
        const trigger = p.getByRole('button', { name: /^Notifications/ });
        await trigger.focus();
        await p.keyboard.press('Enter');
        return trigger;
      },
      surface: (p) => p.getByRole('dialog', { name: 'Notifications' }),
    },
    {
      name: 'command palette',
      open: async (p) => {
        const from = await focusSelectedTab(p);
        await p.keyboard.press('Control+k');
        return from;
      },
      surface: (p) => p.getByRole('dialog'),
    },
    {
      name: 'keyboard shortcuts',
      open: async (p) => {
        const from = await focusSelectedTab(p);
        await p.keyboard.press('Shift+Slash');
        return from;
      },
      surface: (p) => p.getByRole('dialog'),
    },
    {
      name: 'tour',
      open: async (p) => {
        const from = await focusSelectedTab(p);
        await p.keyboard.press('Control+k');
        await expect(p.getByRole('dialog')).toBeVisible();
        await p.keyboard.type('tour');
        await expect(p.getByRole('option', { name: /Onboarding tour/i }).first()).toBeVisible();
        await p.keyboard.press('Enter');
        return from;
      },
      surface: (p) => p.getByRole('dialog'),
    },
  ];

  for (const theme of THEMES) {
    for (const overlay of OVERLAYS) {
      test(`${overlay.name} open (${theme}): axe, focus moves in, Escape closes and returns focus`, async ({ page }) => {
        await open(page, theme, PAGES[0]);
        const where = `${overlay.name} (${theme})`;
        const trigger = await overlay.open(page);
        const surface = overlay.surface(page);
        await expect(surface).toBeVisible();
        await expect
          .poll(() => surface.evaluate((el) => el.contains(document.activeElement)), { message: `${where}: focus did not move into it` })
          .toBe(true);
        await expectNoAxeViolations(page, where);
        await expectIdReferencesResolve(page, where);
        await page.keyboard.press('Escape');
        await expect(surface).toHaveCount(0);
        await expect(trigger, `${where}: focus did not return to where it was before it opened`).toBeFocused();
      });
    }
  }
});
