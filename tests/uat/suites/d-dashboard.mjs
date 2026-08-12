/*
 * Suite D — dashboard surface via Playwright (chromium).
 *
 * Runs against a real `--demo` server so the views have data to render;
 * an empty dashboard renders empty states and would prove nothing.
 *
 * Assertions are DOM + console only — no screenshots. Every view must
 * load with zero console errors, which is the single cheapest signal
 * that a React page is actually working rather than merely painting.
 *
 * Readiness is a per-view content selector (the heading that only
 * appears once that view's data has rendered), then a short bounded
 * drain so a late console error still lands in the same check.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../lib/proc.mjs';
import { getJson, postJson, raw } from '../lib/http.mjs';
import { assert, assertEq } from '../lib/report.mjs';
import { IRIS_NODE_MODULES, WORK_DIR } from '../lib/env.mjs';

const DRAIN_MS = 900;
const NAV_TIMEOUT = 25_000;
const RULE_NAME = 'uat-dashboard-rule';

/** Console noise that is not a defect in the page under test. */
function isBlocking(text) {
  // 429 = the harness itself out-polling the rate limiter; 400 = a
  // background poll racing a filter change. Neither breaks rendering,
  // and the repo's own e2e suite excludes both for the same reason.
  return !/\b(429|400)\b/.test(text);
}

function attachConsole(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

async function loadView(context, baseUrl, path, readySelector) {
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);
  const errors = attachConsole(page);
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: NAV_TIMEOUT });
  if (readySelector) {
    await page.locator(readySelector).first().waitFor({ state: 'visible', timeout: NAV_TIMEOUT });
  }
  await page.waitForTimeout(DRAIN_MS);
  return { page, errors };
}

function assertClean(errors, path) {
  const blocking = errors.filter(isBlocking);
  assert(
    blocking.length === 0,
    `${blocking.length} console error(s) on ${path}: ${blocking.slice(0, 3).join(' | ').slice(0, 320)}`,
  );
}

export async function runSuiteD(t) {
  t.beginSuite('D', 'Dashboard surface (Playwright / chromium)');

  const home = join(WORK_DIR, 'd-dashboard');
  mkdirSync(home, { recursive: true });

  let chromium;
  try {
    ({ chromium } = await import(pathToFileURL(join(IRIS_NODE_MODULES, 'playwright', 'index.mjs')).href));
  } catch (err) {
    t.fail('D0', 'playwright loads from the iris repo node_modules', err.message);
    return;
  }

  let srv;
  try {
    srv = await startServer({
      argsFor: (p) => ['--demo', '--dashboard-port', String(p)],
      irisHome: home,
      label: '--demo dashboard server',
      timeoutMs: 90_000,
    });
  } catch (err) {
    t.fail('D0', '--demo dashboard server starts for the browser suite', err.message);
    return;
  }

  const port = srv.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  let browser;
  let context;

  try {
    // The Welcome Tour is an aria-modal dialog that covers the page and
    // swallows pointer events. Dismiss it through the API — a raw write
    // to the preferences file is invisible to a server that already read
    // it into memory at boot.
    const patched = await raw({
      port,
      method: 'PATCH',
      path: '/api/v1/preferences',
      body: {
        autoLaunch: false,
        dismissedTours: ['tour-welcome'],
        density: 'compact',
        sidebarCollapsed: false,
        notificationsLastSeen: '1970-01-01T00:00:00.000Z',
      },
    });
    assert(patched.status === 200, `preferences PATCH failed: ${patched.status} ${patched.body.slice(0, 200)}`);

    // A real demo trace to drill into, and a rule so /rules has a row
    // with a Delete button.
    const traces = await getJson(port, '/api/v1/traces?limit=1');
    assert(traces.traces?.length > 0, 'demo server returned no traces — the drill-through checks would be vacuous');
    const demoTrace = traces.traces[0];

    const ruleRes = await postJson(
      port,
      '/api/v1/rules/custom',
      {
        name: RULE_NAME,
        description: 'UAT harness rule for the dashboard delete-confirm check.',
        evalType: 'custom',
        severity: 'medium',
        definition: { name: RULE_NAME, type: 'min_length', config: { min_length: 40 } },
      },
      201,
    );
    const ruleId = ruleRes.json.rule.id;

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    const dashboardViews = [
      ['D1', 'Failures view (landing) loads with zero console errors', '/', 'h2:text-is("What failed")'],
      ['D2', 'Health view loads with zero console errors', '/?view=health', 'h2:text-is("Headline")'],
      ['D3', 'Drift view loads with zero console errors', '/?view=drift', 'h2:text-is("What changed")'],
      ['D4', 'Stream view loads with zero console errors', '/?view=stream', 'h2:text-is("Live now")'],
    ];

    for (const [id, name, path, ready] of dashboardViews) {
      await t.check(id, name, async () => {
        const { page, errors } = await loadView(context, baseUrl, path, ready);
        try {
          assertClean(errors, path);
          const text = await page.locator('body').innerText();
          assert(text.trim().length > 200, `page rendered only ${text.trim().length} chars of text — likely an empty shell`);
          return `${path} clean`;
        } finally {
          await page.close();
        }
      });
    }

    await t.check('D5', 'trace detail page renders the real trace with zero console errors', async () => {
      const path = `/traces/${demoTrace.trace_id}`;
      const { page, errors } = await loadView(context, baseUrl, path, `text=${demoTrace.agent_name}`);
      try {
        assertClean(errors, path);
        const text = await page.locator('body').innerText();
        assert(text.includes(demoTrace.agent_name), 'trace detail did not render the agent name');
        assert(/Input \/ Output/.test(text), 'trace detail is missing the Input / Output section');
        return `${demoTrace.agent_name} · ${demoTrace.trace_id.slice(0, 12)}…`;
      } finally {
        await page.close();
      }
    });

    await t.check('D6', 'moment detail page renders with zero console errors', async () => {
      const path = `/moments/${demoTrace.trace_id}`;
      const { page, errors } = await loadView(context, baseUrl, path, `text=${demoTrace.agent_name}`);
      try {
        assertClean(errors, path);
        const text = await page.locator('body').innerText();
        assert(text.includes(demoTrace.agent_name), 'moment detail did not render the agent name');
        return `moment ${demoTrace.trace_id.slice(0, 12)}…`;
      } finally {
        await page.close();
      }
    });

    for (const [id, name, path, ready] of [
      ['D7', 'Custom Rules page loads with zero console errors', '/rules', `text=${RULE_NAME}`],
      ['D8', 'Audit Log page loads with zero console errors', '/audit', null],
    ]) {
      await t.check(id, name, async () => {
        const { page, errors } = await loadView(context, baseUrl, path, ready);
        try {
          assertClean(errors, path);
          const text = await page.locator('body').innerText();
          assert(text.trim().length > 100, `page rendered only ${text.trim().length} chars of text — likely an empty shell`);
          return `${path} clean`;
        } finally {
          await page.close();
        }
      });
    }

    await t.check('D9', 'list routes (/traces, /evals, /moments) load with zero console errors', async () => {
      const errs = [];
      for (const path of ['/traces', '/evals', '/moments']) {
        const { page, errors } = await loadView(context, baseUrl, path, null);
        try {
          const blocking = errors.filter(isBlocking);
          if (blocking.length) errs.push(`${path}: ${blocking.slice(0, 2).join(' | ')}`);
        } finally {
          await page.close();
        }
      }
      assert(errs.length === 0, errs.join(' || ').slice(0, 400));
      return '3 list routes clean';
    });

    await t.check('D10', 'Ctrl+K opens the command palette', async () => {
      const { page, errors } = await loadView(context, baseUrl, '/', 'h2:text-is("What failed")');
      try {
        await page.keyboard.press('Control+k');
        const dialog = page.locator('[role="dialog"][aria-label="Command palette"]');
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await page.locator('input[aria-label="Command query"]').waitFor({ state: 'visible', timeout: 5000 });
        assertClean(errors, 'command palette open');
        return 'palette visible with a focused query input';
      } finally {
        await page.close();
      }
    });

    await t.check('D11', 'the command palette returns DATA results for a query matching demo content', async () => {
      const { page, errors } = await loadView(context, baseUrl, '/', 'h2:text-is("What failed")');
      try {
        await page.keyboard.press('Control+k');
        const input = page.locator('input[aria-label="Command query"]');
        await input.waitFor({ state: 'visible', timeout: 10_000 });
        await input.fill(demoTrace.agent_name);
        // Data results carry ids namespaced by kind (rule./trace./eval.);
        // a command-registry hit would NOT match these selectors, so this
        // proves the palette searched the user's data and not just its
        // own static command list.
        const dataOption = page.locator(
          '#command-palette-list [role="option"][id^="cmd-trace."], #command-palette-list [role="option"][id^="cmd-eval."], #command-palette-list [role="option"][id^="cmd-rule."]',
        );
        await dataOption.first().waitFor({ state: 'visible', timeout: 15_000 });
        const count = await dataOption.count();
        assert(count > 0, 'palette returned no data results');
        assertClean(errors, 'command palette search');
        return `${count} data result(s) for "${demoTrace.agent_name}"`;
      } finally {
        await page.close();
      }
    });

    await t.check('D12', 'a rules-page delete opens the in-app confirm dialog (role=alertdialog)', async () => {
      const { page, errors } = await loadView(context, baseUrl, '/rules', `text=${RULE_NAME}`);
      try {
        await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
        const dialog = page.locator('[role="alertdialog"]');
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        const title = await dialog.locator('h2').innerText();
        assert(title.includes(RULE_NAME), `confirm dialog does not name the rule: "${title}"`);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
        assertClean(errors, '/rules delete confirm');
        return `alertdialog titled "${title.slice(0, 60)}"`;
      } finally {
        await page.close();
      }
    });

    await t.check('D13', 'confirming the dialog actually deletes the rule', async () => {
      const { page, errors } = await loadView(context, baseUrl, '/rules', `text=${RULE_NAME}`);
      try {
        await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
        const dialog = page.locator('[role="alertdialog"]');
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await dialog.getByRole('button', { name: 'Delete rule' }).click();
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
        await page.locator(`text=${RULE_NAME}`).first().waitFor({ state: 'detached', timeout: 10_000 });
        const list = await getJson(port, '/api/v1/rules/custom');
        assert(!list.rules.some((r) => r.id === ruleId), 'the rule is still in the store after confirming delete');
        assertClean(errors, '/rules delete confirm');
        return 'rule removed from the page and the store';
      } finally {
        await page.close();
      }
    });

    await t.check('D14', 'the SPA serves its own bundle (no 404 on the built assets)', async () => {
      const page = await context.newPage();
      const failed = [];
      page.on('response', (res) => {
        if (res.status() >= 400 && /\.(js|css|svg|woff2?)$/.test(new URL(res.url()).pathname)) {
          failed.push(`${res.status()} ${new URL(res.url()).pathname}`);
        }
      });
      try {
        await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await page.locator('h1').first().waitFor({ state: 'visible', timeout: NAV_TIMEOUT });
        await page.waitForTimeout(DRAIN_MS);
        assert(failed.length === 0, `asset requests failed: ${failed.join(', ')}`);
        return 'all bundle assets served';
      } finally {
        await page.close();
      }
    });
  } catch (err) {
    t.fail('D99', 'dashboard suite completed without an unhandled error', err.message);
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await srv.stop();
  }
}
