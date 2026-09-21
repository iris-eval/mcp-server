#!/usr/bin/env node
/*
 * SECURITY.md's supported-versions table must agree with the policy and the
 * version being released.
 *
 * The policy (arc 8, R-6): the current minor receives every fix; the
 * previous minor receives security fixes for 90 days after the current
 * minor's first release; older minors receive none. Before 0.15.0 the
 * policy was "only the latest minor", and on v0.5.0's ship day the table
 * still read `0.4.x | Yes` and the prose still said "upgrade to the current
 * 0.4.x line" — by its own rule the security policy pointed readers at an
 * unsupported line. Nothing checked it, because it carries a version in
 * prose rather than in a `.version` field.
 *
 * Called from scripts/check-version.sh, which runs in the release gate.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The minor before `minor` ("0.14" → "0.13"); null at x.0. */
export function previousMinor(minor) {
  const [major, min] = minor.split('.').map(Number);
  if (min > 0) return `${major}.${min - 1}`;
  return null;
}

/**
 * The problems with SECURITY.md's table for a release of `version`, or []
 * when it states the policy correctly. Pure, so the guard can be tested on
 * text it has never seen.
 *
 * Read the whole table once with a STATIC regex, then compare in plain JS.
 * Interpolating the version into a pattern would mean escaping it, and
 * partial escaping is its own bug class (CodeQL js/incomplete-sanitization).
 */
export function securityTableProblems(text, version) {
  const minor = version.split('.').slice(0, 2).join('.');
  const previous = previousMinor(minor);
  const errors = [];

  const rows = [...text.matchAll(/^\|\s*(\d+\.\d+)\.x(\s+and lower)?\s*\|\s*(Yes|No)([^|]*)\|/gm)].map(([, ver, andLower, verdict, rest]) => ({
    ver,
    andLower: Boolean(andLower),
    supported: verdict === 'Yes',
    rest: rest.trim(),
  }));
  const supported = rows.filter((r) => r.supported).map((r) => r.ver);

  if (!supported.includes(minor)) {
    errors.push(`SECURITY.md table does not mark ${minor}.x as Supported: Yes`);
  }
  if (previous !== null) {
    const row = rows.find((r) => r.ver === previous && !r.andLower);
    if (!row || !row.supported) {
      errors.push(`SECURITY.md table does not mark the previous minor ${previous}.x as supported (security fixes for 90 days after ${minor}.0)`);
    } else if (!/until \d{4}-\d{2}-\d{2}/.test(row.rest)) {
      errors.push(`SECURITY.md row for ${previous}.x does not name the window's end date ("Yes, security fixes until YYYY-MM-DD")`);
    }
  }
  // No OTHER minor may be marked supported.
  for (const other of supported) {
    if (other !== minor && other !== previous) {
      errors.push(`SECURITY.md still marks ${other}.x as supported (current minor is ${minor}; the previous minor is ${previous ?? 'none'})`);
    }
  }
  // And the prose above it must point at the same line.
  if (!text.includes(`upgrade to the current \`${minor}.x\` line`)) {
    errors.push(`SECURITY.md prose does not point at the current \`${minor}.x\` line`);
  }
  return errors;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
  const txt = readFileSync(resolve(root, 'SECURITY.md'), 'utf-8');
  const errors = securityTableProblems(txt, pkg.version);
  if (errors.length > 0) {
    for (const e of errors) console.error(`MISMATCH: ${e}`);
    process.exit(1);
  }
  const minor = pkg.version.split('.').slice(0, 2).join('.');
  console.log(`  OK: SECURITY.md supported lines (${minor}.x, and ${previousMinor(minor) ?? 'no previous minor'} for 90 days)`);
}
