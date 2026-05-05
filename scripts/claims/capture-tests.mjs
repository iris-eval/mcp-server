#!/usr/bin/env node
// Captures test counts into .claims-cache/tests.json so the truthbase
// generator can read them without re-running the test suite each invocation.
//
// Run by:
//   - CI in the test workflow after vitest passes
//   - Local opt-in: `npm run claims:capture-tests`
//
// Strategy: reads the latest vitest output if available; else parses the
// vitest JSON reporter output passed via stdin. Conservative — emits
// schema-shaped output even on partial data.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

async function runVitestAndParse(scope) {
  // scope is either '' (root) or a workspace path like 'dashboard'
  const cwd = scope ? resolve(root, scope) : root;
  return new Promise((resolveP) => {
    const child = spawn('npx', ['vitest', 'run', '--reporter=json'], {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.on('close', () => {
      try {
        // vitest may emit non-JSON warnings before the JSON object; isolate the JSON.
        const start = out.indexOf('{');
        const json = JSON.parse(out.slice(start));
        resolveP({
          total: json.numTotalTests ?? null,
          passed: json.numPassedTests ?? null,
          failed: json.numFailedTests ?? null,
        });
      } catch {
        resolveP({ total: null, passed: null, failed: null });
      }
    });
  });
}

async function main() {
  const rootCounts = await runVitestAndParse('');
  // Dashboard has its own vitest config.
  const dashboardCounts = await runVitestAndParse('dashboard').catch(() => ({
    total: null,
    passed: null,
    failed: null,
  }));

  // Integration counts — heuristic: tests under tests/integration/.
  // We don't currently have a separate integration runner; use the cached
  // value from the existing claims.json if present, else null.
  let integration = { total: null, passed: null, failed: null };
  let playwrightE2E = { total: null, passed: null, failed: null, browsers: [] };
  try {
    const existing = JSON.parse(await readFile(resolve(root, '.claims.json'), 'utf-8'));
    if (existing?.tests?.integration) integration = existing.tests.integration;
    if (existing?.tests?.playwrightE2E) playwrightE2E = existing.tests.playwrightE2E;
  } catch { /* fine */ }

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

  await mkdir(resolve(root, '.claims-cache'), { recursive: true });
  await writeFile(
    resolve(root, '.claims-cache/tests.json'),
    JSON.stringify(result, null, 2) + '\n',
    'utf-8',
  );
  console.log('[claims:capture-tests] wrote .claims-cache/tests.json');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('[claims:capture-tests] error:', err);
  process.exit(1);
});
