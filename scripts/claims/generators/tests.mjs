// Tests generator — runs vitest --reporter=json across workspaces and counts.
//
// The actual numbers are produced by running the test runner. This generator
// reads a cached counts file written by `claims:capture-tests` (the build
// pipeline regenerates the cache, then the orchestrator reads it). We do
// NOT spawn vitest from inside the generator — that would couple every
// claims:generate invocation to a full test run.
//
// Cache file: .claims-cache/tests.json
// Captured by: scripts/claims/capture-tests.mjs (run separately, in CI before generate)
//
// Falls back to the previous claims.json values if the cache is absent so
// local `claims:generate` works without re-running tests every time.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function generate() {
  const cache = await readJsonOrNull(resolve(root, '.claims-cache/tests.json'));
  if (cache) return cache;

  // Fallback: read from existing claims.json so local invocations don't
  // require a fresh test run. CI captures fresh values and writes the cache
  // before invoking generate, so CI never hits this path.
  const existing = await readJsonOrNull(resolve(root, '.claims.json'));
  if (existing?.tests) return existing.tests;

  // Cold-start fallback — let the orchestrator decide what to do with nulls.
  return {
    vitestRoot: { total: null, passed: null, failed: null },
    vitestDashboard: { total: null, passed: null, failed: null },
    integration: { total: null, passed: null, failed: null },
    playwrightE2E: { total: null, passed: null, failed: null, browsers: [] },
    totalCombined: null,
  };
}
