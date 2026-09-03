#!/usr/bin/env node
/*
 * Print one version's section of CHANGELOG.md, heading included.
 *
 *   node scripts/changelog-section.mjs 0.5.1
 *
 * Used by .github/workflows/release.yml twice: the validate job runs it to
 * refuse a production tag that has no CHANGELOG entry, and the
 * github-release job runs it to build the release body. The section is the
 * ONLY place the "Check before upgrading" paragraph and the BREAKING entries
 * live, and v0.5.0's release page shipped without either because the page
 * was assembled from the PR list alone. Whatever is in the changelog is what
 * the release page says — one source, no second copy to drift.
 *
 * Exit 1 (nothing on stdout) when the section is missing. Callers decide
 * whether that is fatal (production tags) or a fallback (pre-releases).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/changelog-section.mjs <version>');
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lines = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf-8').split(/\r?\n/);

// Keep a Changelog headings: `## [0.5.1] - 2026-09-03`. Match on the bracketed
// version with plain string comparison — no regex built from input.
const heading = `## [${version}]`;
const start = lines.findIndex((l) => l.startsWith(heading));
if (start === -1) {
  console.error(`CHANGELOG.md has no "${heading}" section`);
  process.exit(1);
}

let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
if (end === -1) end = lines.length;

const section = lines.slice(start, end).join('\n').trimEnd();
if (section.split('\n').length < 2) {
  console.error(`CHANGELOG.md "${heading}" section is empty`);
  process.exit(1);
}

process.stdout.write(section + '\n');
