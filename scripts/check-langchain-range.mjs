#!/usr/bin/env node
/*
 * @iris-eval/langchain must be installable against the server being released.
 *
 * packages/langchain/package.json declares a dependency range on
 * @iris-eval/mcp-server. For a 0.x package, `^0.4.0` means `>=0.4.0 <0.5.0`
 * — so on v0.5.0's ship day every `npm install` of the adapter resolved to
 * 0.4.6, the last line BEFORE the critical-rule veto and the regex sandbox,
 * and nothing in the release gate noticed because the range is not a
 * `.version` field. The adapter's OWN version is deliberately not synced
 * (it releases on its own cadence); its range is what must keep up.
 *
 * Called from scripts/check-version.sh, which runs in the release gate.
 * Exits 1 when the range does not admit the version in package.json.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const adapterPath = 'packages/langchain/package.json';
const adapter = JSON.parse(readFileSync(resolve(root, adapterPath), 'utf-8'));

const range =
  adapter.dependencies?.['@iris-eval/mcp-server'] ??
  adapter.peerDependencies?.['@iris-eval/mcp-server'];

if (!range) {
  // A missing range is a failure, not a skip — see check-version.sh on why
  // silently passing over a missing surface turns the gate into a no-op.
  console.error(`MISSING: ${adapterPath} declares no dependency on @iris-eval/mcp-server`);
  process.exit(1);
}

let semver;
try {
  semver = createRequire(import.meta.url)('semver');
} catch {
  console.error(`MISSING: the "semver" package is not installed — run npm ci before the version check`);
  process.exit(1);
}

// An RC is judged against the production version it precedes: v0.6.0-rc.1
// asks "will the range accept 0.6.0 when it ships?" — that is the release
// the adapter must be ready for, and prerelease semantics would otherwise
// fail every RC tag on a range that is perfectly correct.
const parsed = semver.parse(rootPkg.version);
const release = parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : rootPkg.version;

if (semver.satisfies(release, range)) {
  console.log(`  OK: ${adapterPath} "@iris-eval/mcp-server": "${range}" admits ${release}`);
  process.exit(0);
}

console.error(`MISMATCH: ${adapterPath} "@iris-eval/mcp-server": "${range}" does not admit ${release}`);
console.error(`          A fresh install of @iris-eval/langchain would resolve to an older server line.`);
console.error(`          Widen the range by hand (e.g. "^${parsed ? `${parsed.major}.${parsed.minor}.0` : release}") — the syncer does not rewrite dependency policy.`);
process.exit(1);
