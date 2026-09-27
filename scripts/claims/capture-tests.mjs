#!/usr/bin/env node
// Captures test counts into .claims-cache/tests.json so the truthbase
// generator can read them without re-running the test suite each invocation.
//
// Strategy: runs `vitest run --reporter=json --outputFile=<path>` so the JSON
// reporter output goes directly to a file (avoids stdout parsing edge cases
// across runners + log noise).
//
// Run by:
//   - CI in the test workflow after vitest passes
//   - Local opt-in: `npm run claims:capture-tests`
//
// A report that must not become counts is refused, not recorded: a test file
// that failed to load (its tests would be missing from the total with
// nothing failed), a run that failed outside any test, or a skipped test.
// The rules live in capture-report.mjs. `--report <scope>=<file>` reads an
// existing vitest JSON report for a scope (root or dashboard) instead of
// running vitest, to check a report or to capture from one already made.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { CaptureRefused, checkReport } from './capture-report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function runVitestToFile(cwd, outFile) {
  await rm(outFile, { force: true });
  return new Promise((resolveP) => {
    // npx will resolve the workspace's vitest. Pass --outputFile + reporter via
    // explicit args so vitest writes JSON to disk regardless of stdout chatter.
    const child = spawn('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${outFile}`], {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrTail = '';
    child.stderr.on('data', d => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-2000);
    });
    child.on('close', code => {
      resolveP({ exitCode: code, stderrTail });
    });
  });
}

/** `--report root=<file>` / `--report dashboard=<file>`: reports to read instead of running vitest. */
function givenReports(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--report') continue;
    const [scope, ...rest] = String(argv[i + 1] ?? '').split('=');
    if (!rest.length) throw new Error('[claims:capture-tests] --report takes <scope>=<file>, e.g. --report root=report.json');
    out.set(scope === 'root' ? '' : scope, resolve(process.cwd(), rest.join('=')));
    i += 1;
  }
  return out;
}
const GIVEN = givenReports(process.argv.slice(2));

async function captureScope(scope) {
  const cwd = scope ? resolve(root, scope) : root;
  let report;
  if (GIVEN.has(scope)) {
    report = await readJsonOrNull(GIVEN.get(scope));
    if (report === null) throw new CaptureRefused(`[claims:capture-tests] --report for "${scope || 'root'}" is not a readable JSON report: ${GIVEN.get(scope)}`);
  } else {
    const outFile = resolve(root, `.claims-cache/vitest-report-${scope || 'root'}.json`);
    const { exitCode, stderrTail } = await runVitestToFile(cwd, outFile);
    report = await readJsonOrNull(outFile);
    if (report === null) {
      console.warn(`[claims:capture-tests] WARN — could not parse vitest report for scope "${scope || 'root'}" (exit ${exitCode}). stderr tail:`);
      console.warn(stderrTail);
    }
  }
  const summary = checkReport(report, { scope: scope || 'root', root: cwd });
  return summary;
}

// Playwright E2E is captured STATICALLY — the spec inventory is deterministic
// from the repo, and spawning browsers here would couple every capture to a
// full E2E run. total = bare `test(` cases across tests/e2e/*.spec.ts;
// passed/failed stay null (only a live run knows those); browsers come from
// the project names in playwright.config.ts. CI runs the suite separately
// (test:e2e job), so the claim is "these specs exist and run in CI".
async function capturePlaywrightStatic() {
  const { readdir } = await import('node:fs/promises');
  const e2eDir = resolve(root, 'tests/e2e');
  const entries = await readdir(e2eDir);
  let total = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.spec.ts')) continue;
    const src = await readFile(resolve(e2eDir, entry), 'utf-8');
    total += (src.match(/^\s*test\(/gm) ?? []).length;
  }
  const pwConfig = await readFile(resolve(root, 'playwright.config.ts'), 'utf-8');
  const browsers = [...pwConfig.matchAll(/name:\s*'([^']+)'/g)].map(m => m[1]);
  return { total: total > 0 ? total : null, passed: null, failed: null, browsers };
}

async function captureScopeWithFallback(scope, fallback) {
  try {
    const summary = await captureScope(scope);
    if (summary.total !== null) return summary;
    if (fallback?.total != null) {
      console.warn(`[claims:capture-tests] preserving committed value for "${scope || 'root'}": total=${fallback.total}`);
      return fallback;
    }
    return summary;
  } catch (err) {
    // A refused report is an answer, not an unavailable runner: never covered by the committed counts.
    if (err instanceof CaptureRefused) throw err;
    console.warn(`[claims:capture-tests] WARN — capture failed for "${scope || 'root'}":`, err.message);
    if (fallback?.total != null) return fallback;
    return { total: null, passed: null, failed: null };
  }
}

async function main() {
  await mkdir(resolve(root, '.claims-cache'), { recursive: true });

  // Read the existing committed claims.json so we can preserve any scope's
  // count when its runner is unavailable in the current environment (e.g.,
  // CI without the dashboard workspace deps installed).
  const existing = await readJsonOrNull(resolve(root, '.claims.json'));
  const existingTests = existing?.tests ?? {};

  // Each scope runs independently. If a scope fails to produce real counts,
  // we fall back to the committed value rather than overwrite with null —
  // null would force an unrelated regen drift. Local environments with the
  // dashboard workspace installed get fresh counts; CI without dashboard
  // deps preserves the last committed dashboard counts.
  const rootCounts = await captureScopeWithFallback('', existingTests.vitestRoot);
  const dashboardCounts = await captureScopeWithFallback('dashboard', existingTests.vitestDashboard);

  const integration = existingTests.integration ?? { total: null, passed: null, failed: null };

  let playwrightE2E;
  try {
    playwrightE2E = await capturePlaywrightStatic();
  } catch (err) {
    console.warn('[claims:capture-tests] WARN — static Playwright capture failed:', err.message);
    playwrightE2E = existingTests.playwrightE2E ?? { total: null, passed: null, failed: null, browsers: [] };
  }

  const totalCombined =
    (rootCounts.total ?? 0) +
    (dashboardCounts.total ?? 0) +
    (integration.total ?? 0) +
    (playwrightE2E.total ?? 0);

  const result = {
    vitestRoot: rootCounts,
    vitestDashboard: dashboardCounts,
    integration,
    playwrightE2E,
    totalCombined: totalCombined > 0 ? totalCombined : null,
  };

  await writeFile(
    resolve(root, '.claims-cache/tests.json'),
    JSON.stringify(result, null, 2) + '\n',
    'utf-8',
  );
  console.log('[claims:capture-tests] wrote .claims-cache/tests.json');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  if (err instanceof CaptureRefused) console.error(err.message);
  else console.error('[claims:capture-tests] error:', err);
  process.exit(1);
});
