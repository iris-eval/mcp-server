#!/usr/bin/env node
// Security-alert delta gate.
//
// Fails the PR if any open Dependabot alert at severity >= medium does not
// have a corresponding GHSA-* row in SECURITY-EXPOSURE.md. Forces every new
// alert to be triaged with a documented decision (override / dismiss /
// track / patch) instead of accumulating silently.
//
// Run locally:    GH_TOKEN=$(gh auth token) node scripts/security/check-exposure-coverage.mjs
// Run in CI:      uses Actions' GITHUB_TOKEN with security-events: read
//
// Exit codes:
//   0 — every open >=medium alert has a SECURITY-EXPOSURE.md row
//   1 — at least one alert is uncovered (gate fails the PR)
//   2 — script error (network, parse, etc.) — also fails the PR

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'iris-eval/mcp-server';
const SEVERITY_THRESHOLD = new Set(['critical', 'high', 'medium']);

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
  // Match GHSA-xxxx-xxxx-xxxx anywhere in the document. We don't try to
  // parse section structure — any mention is taken as documentation.
  const matches = content.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/gi) ?? [];
  return new Set(matches.map(s => s.toUpperCase()));
}

async function getOpenAlerts() {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) err('no GH_TOKEN or GITHUB_TOKEN in environment');

  const url = `https://api.github.com/repos/${REPO}/dependabot/alerts?state=open&per_page=100`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (e) {
    err(`network error fetching dependabot alerts: ${e.message}`);
  }
  if (!res.ok) {
    err(`GitHub API returned ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

async function main() {
  const [documented, alerts] = await Promise.all([
    getDocumentedGhsas(),
    getOpenAlerts(),
  ]);

  const undocumented = [];
  let inScope = 0;
  for (const alert of alerts) {
    const severity = alert.security_advisory?.severity?.toLowerCase();
    if (!SEVERITY_THRESHOLD.has(severity)) continue;
    inScope += 1;
    const ghsa = alert.security_advisory?.ghsa_id?.toUpperCase();
    if (!ghsa) continue;
    if (!documented.has(ghsa)) {
      undocumented.push({
        ghsa,
        severity,
        package: alert.dependency?.package?.name,
        summary: alert.security_advisory?.summary,
      });
    }
  }

  console.log(`[security-gate] scanned ${alerts.length} open alert(s); ${inScope} at >=medium severity`);
  console.log(`[security-gate] SECURITY-EXPOSURE.md documents ${documented.size} GHSA reference(s)`);

  if (undocumented.length === 0) {
    console.log('[security-gate] OK — every >=medium alert has a documented row');
    return;
  }

  console.error('[security-gate] FAIL: undocumented >=medium alerts:');
  for (const a of undocumented) {
    console.error(`  - ${a.ghsa} (${a.severity}) on ${a.package}: ${a.summary}`);
  }
  console.error('');
  console.error('Action required:');
  console.error('  1. Open SECURITY-EXPOSURE.md');
  console.error('  2. Add a section per advisory with the threat-model assessment');
  console.error('     (load-graph reachability, code-path, untrusted-input, downstream guards)');
  console.error('  3. Record the decision (override / dismiss-as-not-used / dismiss-as-tolerable-risk / track / patch)');
  console.error('  4. Re-run this script to verify');
  fail(`${undocumented.length} undocumented advisory(ies) at >=medium severity`);
}

main().catch(e => err(e.stack ?? e.message));
