#!/usr/bin/env node
// Security-alert delta gate.
//
// Fails the PR if any open advisory at severity >= moderate (GitHub's
// "medium") does not have a corresponding GHSA-* row in
// SECURITY-EXPOSURE.md. Forces every new advisory to be triaged with a
// documented decision (override / dismiss / track / patch) instead of
// accumulating silently.
//
// Implementation: walks `npm audit --json` output instead of calling the
// GitHub Dependabot Alerts API. The two sources are equivalent for this
// purpose (both originate in the GitHub Advisory Database), and npm audit
// is auth-free and CI-portable. GitHub Actions' default GITHUB_TOKEN does
// not have permission to read Dependabot alerts, so an API-based gate
// would require a PAT secret per repo.
//
// Run locally:  node scripts/security/check-exposure-coverage.mjs
// Run in CI:    same — no secrets needed
//
// Exit codes:
//   0 — every >=moderate advisory has a SECURITY-EXPOSURE.md row
//   1 — at least one advisory is uncovered (gate fails the PR)
//   2 — script error (npm audit failed unexpectedly, parse failure, etc.)

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SEVERITY_THRESHOLD = new Set(['critical', 'high', 'moderate']);
const GHSA_RE = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/gi;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const EXPOSURE_FILE = resolve(root, 'SECURITY-EXPOSURE.md');

function fail(msg) {
  console.error(`[security-gate] FAIL: ${msg}`);
  process.exit(1);
}

function err(msg) {
  console.error(`[security-gate] ERROR: ${msg}`);
  process.exit(2);
}

async function getDocumentedGhsas() {
  let content;
  try {
    content = await readFile(EXPOSURE_FILE, 'utf-8');
  } catch (e) {
    err(`cannot read ${EXPOSURE_FILE}: ${e.message}`);
  }
  const matches = content.match(GHSA_RE) ?? [];
  return new Set(matches.map(s => s.toUpperCase()));
}

// Walks `npm audit --json` output to collect every advisory referenced via
// the `via[].url` chain at >=moderate severity. Returns array of
// {ghsa, severity, package, title}.
function getAuditAdvisories() {
  // Windows: shell:true is required for .cmd resolution (npm is npm.cmd).
  // Node 22+ deprecation warning about arg passing with shell:true does not
  // apply here because args are hardcoded literals, not user input. The
  // warning fires only on Windows; CI runs on Linux and uses shell:false.
  const proc = spawnSync('npm', ['audit', '--json'], {
    cwd: root,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    maxBuffer: 50 * 1024 * 1024,
  });
  // npm audit exits non-zero when vulnerabilities are found — that's not
  // a script error. Treat exit code 1 as "audit ran and found stuff."
  if (proc.status !== 0 && proc.status !== 1) {
    err(`npm audit failed (exit ${proc.status}): ${proc.stderr || proc.stdout}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(proc.stdout);
  } catch (e) {
    err(`could not parse npm audit JSON: ${e.message}`);
  }

  const advisories = [];
  const seen = new Set();
  for (const [pkg, info] of Object.entries(parsed.vulnerabilities ?? {})) {
    for (const via of info.via ?? []) {
      if (typeof via !== 'object' || !via.url) continue;
      const m = via.url.match(GHSA_RE);
      if (!m) continue;
      const ghsa = m[0].toUpperCase();
      if (seen.has(ghsa)) continue;
      seen.add(ghsa);
      const severity = (via.severity ?? '').toLowerCase();
      if (!SEVERITY_THRESHOLD.has(severity)) continue;
      advisories.push({ ghsa, severity, package: pkg, title: via.title ?? '' });
    }
  }
  return advisories;
}

async function main() {
  const documented = await getDocumentedGhsas();
  const advisories = getAuditAdvisories();

  console.log(`[security-gate] npm audit reports ${advisories.length} advisory(ies) at >=moderate severity`);
  console.log(`[security-gate] SECURITY-EXPOSURE.md documents ${documented.size} GHSA reference(s)`);

  const undocumented = advisories.filter(a => !documented.has(a.ghsa));
  if (undocumented.length === 0) {
    console.log('[security-gate] OK — every >=moderate advisory has a documented row');
    return;
  }

  console.error('[security-gate] FAIL: undocumented >=moderate advisories:');
  for (const a of undocumented) {
    console.error(`  - ${a.ghsa} (${a.severity}) on ${a.package}: ${a.title}`);
  }
  console.error('');
  console.error('Action required:');
  console.error('  1. Open SECURITY-EXPOSURE.md');
  console.error('  2. Add a section per advisory with the threat-model assessment');
  console.error('     (load-graph reachability, code-path, untrusted-input, downstream guards)');
  console.error('  3. Record the decision (override / dismiss-as-not-used / dismiss-as-tolerable-risk / track / patch)');
  console.error('  4. Re-run this script to verify');
  fail(`${undocumented.length} undocumented advisory(ies) at >=moderate severity`);
}

main().catch(e => err(e.stack ?? e.message));
