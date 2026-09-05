#!/usr/bin/env node
// Security-alert delta gate.
//
// Fails the PR if any open advisory at severity >= moderate (GitHub's
// "medium") does not have a corresponding GHSA-* row in
// SECURITY-EXPOSURE.md. Forces every new advisory to be triaged with a
// documented decision (override / dismiss / track / patch) instead of
// accumulating silently.
//
// DEADLOCK-FREE BY DESIGN — preserve this property in any future change.
// This is the repo's authoritative dependency-security gate as of
// 2026-08-06, when `npm audit --audit-level=high` was removed from the
// lint-and-typecheck job. That check failed on the WHOLE set of open
// advisories, so with N>1 HIGHs outstanding every PR went red — including
// each Dependabot PR that fixed one, since the other N-1 remained. Nothing
// could merge, so nothing could drain (4 HIGHs blocked all 40 open PRs).
//
// The invariant that prevents it: A BLOCKING GATE MUST ALWAYS BE
// SATISFIABLE BY A CHANGE MADE INSIDE THE PULL REQUEST IT BLOCKS. This
// gate satisfies it — both exits (add a triage row, or bump the dep) are
// edits within the PR. Never make failure here depend on another PR
// merging first, and never gate on a total count of pre-existing debt.
//
// Remediation pressure is kept WITHOUT blocking: advisories that npm
// reports as having an available fix are printed as a REMEDIATION
// AVAILABLE report. It is informational on purpose — making it fatal
// would recreate the deadlock, because the fix usually lives in a
// separate Dependabot PR.
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
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
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
/*
 * Every workspace with its own lockfile.
 *
 * This gate used to audit the ROOT only, while calling itself "the repo's
 * authoritative dependency-security gate" — authoritative for one workspace
 * and silent in three. That is exactly how dashboard/ carried 2 HIGHs while
 * the Dependabot dashboard read 0 alerts. `npm audit` resolves against the
 * lockfile in its cwd and does not traverse into nested projects, so each
 * one needs its own run.
 */
const AUDIT_WORKSPACES = ['.', 'dashboard', 'website', 'packages/init'];

function auditWorkspace(workspace) {
  const cwd = resolve(root, workspace);
  if (!existsSync(join(cwd, 'package-lock.json'))) return null;
  // Windows: shell:true is required for .cmd resolution (npm is npm.cmd).
  // Node 22+ deprecation warning about arg passing with shell:true does not
  // apply here because args are hardcoded literals, not user input. The
  // warning fires only on Windows; CI runs on Linux and uses shell:false.
  const proc = spawnSync('npm', ['audit', '--json'], {
    cwd,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    maxBuffer: 50 * 1024 * 1024,
  });
  // npm audit exits non-zero when vulnerabilities are found — that's not
  // a script error. Treat exit code 1 as "audit ran and found stuff."
  if (proc.status !== 0 && proc.status !== 1) {
    err(`npm audit failed in ${workspace} (exit ${proc.status}): ${proc.stderr || proc.stdout}`);
  }
  try {
    return JSON.parse(proc.stdout);
  } catch (e) {
    err(`could not parse npm audit JSON from ${workspace}: ${e.message}`);
  }
}

function getAuditAdvisories() {
  const advisories = [];
  const seen = new Set();
  const audited = [];

  for (const workspace of AUDIT_WORKSPACES) {
    const parsed = auditWorkspace(workspace);
    if (!parsed) continue;
    audited.push(workspace);

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
        advisories.push({
          ghsa,
          severity,
          package: pkg,
          workspace,
          title: via.title ?? '',
          // npm sets this on the vulnerability entry, not the advisory:
          // true | false | {name, version, isSemVerMajor}
          fixAvailable: info.fixAvailable ?? false,
        });
      }
    }
  }

  // State which workspaces were covered. A gate that quietly audits a
  // subset reads exactly like one that audited everything and found nothing.
  console.log(`[security-gate] audited lockfiles: ${audited.join(', ')}`);
  return advisories;
}

// Informational, never fatal — see the deadlock note in the file header.
// Surfaces advisories npm can already fix so documented-and-forgotten
// doesn't become a permanent parking spot, without blocking any PR on
// work that lives in a different one.
function reportRemediable(advisories) {
  const remediable = advisories.filter(a => a.fixAvailable);
  if (remediable.length === 0) return;
  const rank = { critical: 0, high: 1, moderate: 2 };
  remediable.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
  console.log(
    `[security-gate] REMEDIATION AVAILABLE — ${remediable.length} advisory(ies) have an upstream fix:`,
  );
  for (const a of remediable) {
    const via = typeof a.fixAvailable === 'object' && a.fixAvailable?.name
      ? ` (via ${a.fixAvailable.name}@${a.fixAvailable.version}${a.fixAvailable.isSemVerMajor ? ', SEMVER-MAJOR' : ''})`
      : '';
    console.log(`  - ${a.severity.padEnd(8)} ${a.package}: ${a.ghsa}${via}`);
  }
  console.log('[security-gate] (informational — merge the Dependabot PR or add an override)');
}

/*
 * Installed-version claims in the record must match the lockfile.
 *
 * The hono row said "1.19.13 installed" for a month after the MCP SDK's
 * 1.30.0 bump had put 2.1.0 in the tree — the assessment that "the fix is a
 * major bump that must arrive via the SDK" had already come true and the
 * record still argued for tolerating the old version. A reader trusting the
 * record over the lockfile got the wrong picture. Every "**Package:**
 * \`name\` (X.Y.Z installed" phrase is now compared with the root lockfile;
 * a mismatch fails the gate, and the fix is an edit inside the same PR
 * (the deadlock invariant holds).
 */
async function checkInstalledVersionClaims() {
  const content = await readFile(EXPOSURE_FILE, 'utf-8');
  let lock;
  try {
    lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf-8'));
  } catch (e) {
    err(`cannot read package-lock.json: ${e.message}`);
  }
  const claims = [...content.matchAll(/\*\*Package:\*\* `([^`]+)` \((\d[^\s)]*) installed/g)];
  const mismatches = [];
  for (const [, name, claimed] of claims) {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (!entry) {
      mismatches.push(`${name}: the record says ${claimed} installed; the root lockfile has no node_modules/${name}`);
    } else if (entry.version !== claimed) {
      mismatches.push(`${name}: the record says ${claimed} installed; the lockfile has ${entry.version}`);
    }
  }
  console.log(`[security-gate] ${claims.length} installed-version claim(s) in SECURITY-EXPOSURE.md checked against package-lock.json`);
  if (mismatches.length > 0) {
    fail(`SECURITY-EXPOSURE.md disagrees with package-lock.json:\n  - ${mismatches.join('\n  - ')}\nUpdate the row (and its decision, if the upgrade closed the advisory).`);
  }
}

async function main() {
  const documented = await getDocumentedGhsas();
  await checkInstalledVersionClaims();
  const advisories = getAuditAdvisories();

  console.log(`[security-gate] npm audit reports ${advisories.length} advisory(ies) at >=moderate severity`);
  console.log(`[security-gate] SECURITY-EXPOSURE.md documents ${documented.size} GHSA reference(s)`);

  reportRemediable(advisories);

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
