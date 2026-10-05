#!/usr/bin/env node
/*
 * A release ships only a commit whose required checks passed on main.
 *
 * The release workflow checked that the tagged commit is on main, then ran
 * a typecheck, the unit suite and a build itself. It never asked whether
 * main's own CI had passed on that commit: the proofs, the claims checks,
 * end to end, the image, the real clients. This reads the check runs on
 * the tagged commit and requires every context in
 * .github/required-checks.json that runs on a push to main to have
 * succeeded. A tag pushed while those runs are still going waits for them,
 * up to a limit; one that failed, or never ran, refuses the release before
 * anything is published.
 *
 *   node scripts/ci/require-checks-passed.mjs <sha>
 *
 * Env: GITHUB_REPOSITORY, GITHUB_TOKEN (needs checks: read), GITHUB_API_URL,
 * REQUIRE_CHECKS_WAIT_MINUTES (default 45).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Required contexts that run only on a pull request, so a commit on main
 * never carries them: the Python build (it runs on pull requests and on
 * py-v tags) and code scanning's own result.
 */
export const PULL_REQUEST_ONLY = new Set(['Build the sdist and the wheel', 'CodeQL']);

/**
 * The verdict on one commit. `runs` is the commit's check runs ({ name,
 * status, conclusion }); a context passes when any run of it succeeded (a
 * re-run that passed counts), and waits while one is still going.
 */
export function judge(contexts, runs) {
  const failed = [];
  const waiting = [];
  for (const context of contexts) {
    if (PULL_REQUEST_ONLY.has(context)) continue;
    const mine = runs.filter((r) => r.name === context);
    if (mine.some((r) => r.status === 'completed' && r.conclusion === 'success')) continue;
    if (mine.length === 0 || mine.some((r) => r.status !== 'completed')) waiting.push(context);
    else failed.push(`${context} (${mine.map((r) => r.conclusion).join(', ')})`);
  }
  return { failed, waiting };
}

async function checkRuns(sha) {
  const repo = process.env.GITHUB_REPOSITORY || 'iris-eval/mcp-server';
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'iris-require-checks' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const runs = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${api}/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GET commits/${sha}/check-runs answered ${res.status}`);
    const body = await res.json();
    runs.push(...body.check_runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion })));
    if (body.check_runs.length < 100) return runs;
  }
}

async function main() {
  const sha = process.argv[2];
  if (!sha) {
    console.error('usage: require-checks-passed.mjs <sha>');
    process.exit(2);
  }
  const { contexts } = JSON.parse(readFileSync(resolve(root, '.github', 'required-checks.json'), 'utf8'));
  const deadline = Date.now() + Number(process.env.REQUIRE_CHECKS_WAIT_MINUTES || 45) * 60_000;
  for (;;) {
    const { failed, waiting } = judge(contexts, await checkRuns(sha));
    if (failed.length > 0) {
      for (const f of failed) console.error(`[required-checks] did not pass on ${sha.slice(0, 8)}: ${f}`);
      console.error('[required-checks] A release ships only a commit main passed. Fix main, then tag the commit that passes.');
      process.exit(1);
    }
    if (waiting.length === 0) {
      console.log(`[required-checks] OK — every required check that runs on main passed on ${sha.slice(0, 8)}`);
      return;
    }
    if (Date.now() > deadline) {
      console.error(`[required-checks] still not finished on ${sha.slice(0, 8)} after the wait: ${waiting.join(', ')}`);
      process.exit(1);
    }
    console.log(`[required-checks] waiting for ${waiting.length}: ${waiting.slice(0, 5).join(', ')}${waiting.length > 5 ? ', …' : ''}`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
