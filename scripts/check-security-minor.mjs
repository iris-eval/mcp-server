#!/usr/bin/env node
/*
 * SECURITY.md's supported-versions table must name the CURRENT minor.
 *
 * The policy in that file is "only the latest minor receives security
 * fixes". On v0.5.0's ship day the table still read `0.4.x | Yes` and the
 * prose still said "upgrade to the current 0.4.x line" — so by its own rule
 * the security policy was pointing readers at an unsupported line. Nothing
 * checked it, because it carries a version in prose rather than in a
 * `.version` field.
 *
 * Called from scripts/check-version.sh, which runs in the release gate.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const minor = pkg.version.split('.').slice(0, 2).join('.');
const escaped = minor.replace(/\./g, '\\.');
const txt = readFileSync(resolve(root, 'SECURITY.md'), 'utf-8');

const errors = [];

// The table row for the current minor must say Yes.
if (!new RegExp(`^\\|\\s*${escaped}\\.x\\s*\\|\\s*Yes\\s*\\|`, 'm').test(txt)) {
  errors.push(`SECURITY.md table does not mark ${minor}.x as Supported: Yes`);
}

// No OLDER minor may still be marked supported.
for (const [, other] of txt.matchAll(/^\|\s*(\d+\.\d+)\.x\s*\|\s*Yes\s*\|/gm)) {
  if (other !== minor) {
    errors.push(`SECURITY.md still marks ${other}.x as supported (current minor is ${minor})`);
  }
}

// And the prose above it must point at the same line.
if (!txt.includes(`upgrade to the current \`${minor}.x\` line`)) {
  errors.push(`SECURITY.md prose does not point at the current \`${minor}.x\` line`);
}

if (errors.length > 0) {
  for (const e of errors) console.error(`MISMATCH: ${e}`);
  process.exit(1);
}

console.log(`  OK: SECURITY.md supported line (${minor}.x)`);
