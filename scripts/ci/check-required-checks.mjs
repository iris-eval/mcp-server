#!/usr/bin/env node
/*
 * The checks branch protection requires, against the list the repository
 * documents.
 *
 * CONTRIBUTING.md tells a contributor which checks block a merge, and
 * docs/proof.md says a rule change "cannot merge" without its numbers.
 * Both are statements about a repository SETTING, which no test can read
 * from the tree: CONTRIBUTING.md said "eleven required checks" while
 * nineteen were required, and the proof sentence was written while the
 * proof job was not among them.
 *
 * .github/required-checks.json is the documented list. The unit tests hold
 * the documents to that file; this script holds the file to the setting,
 * read from the public branch endpoint (no admin scope is needed for a
 * public repository). It runs on every pull request and every push to
 * main, so a change to the setting without the file turns main red.
 *
 *   node scripts/ci/check-required-checks.mjs
 *
 * Env: GITHUB_REPOSITORY (owner/name; defaults to iris-eval/mcp-server),
 * GITHUB_TOKEN (optional, only raises the rate limit), GITHUB_API_URL.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The sorted difference between the documented and the live contexts. */
export function compare(documented, live) {
  const a = new Set(documented);
  const b = new Set(live);
  return {
    missingFromFile: [...b].filter((c) => !a.has(c)).sort(),
    notRequired: [...a].filter((c) => !b.has(c)).sort(),
  };
}

async function main() {
  const file = JSON.parse(readFileSync(resolve(root, '.github', 'required-checks.json'), 'utf8'));
  const repo = process.env.GITHUB_REPOSITORY || 'iris-eval/mcp-server';
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'iris-required-checks' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`${api}/repos/${repo}/branches/${file.branch}`, { headers });
  if (!res.ok) {
    console.error(`[required-checks] GET branches/${file.branch} answered ${res.status}; the setting could not be read, so nothing is asserted about it.`);
    process.exit(1);
  }
  const live = (await res.json())?.protection?.required_status_checks?.contexts;
  if (!Array.isArray(live)) {
    console.error('[required-checks] the branch endpoint carries no protection.required_status_checks.contexts; if protection moved to a ruleset, read it from there and update this script.');
    process.exit(1);
  }
  const { missingFromFile, notRequired } = compare(file.contexts, live);
  if (missingFromFile.length === 0 && notRequired.length === 0) {
    console.log(`[required-checks] OK — .github/required-checks.json lists the ${live.length} contexts ${repo}@${file.branch} requires`);
    return;
  }
  for (const c of missingFromFile) console.error(`[required-checks] required on ${file.branch} and not in .github/required-checks.json: ${c}`);
  for (const c of notRequired) console.error(`[required-checks] in .github/required-checks.json and not required on ${file.branch}: ${c}`);
  console.error('[required-checks] Update the file and the table in CONTRIBUTING.md (tests/required-checks-documented.test.ts holds the two together), or restore the setting.');
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
