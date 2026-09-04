// Maintenance generator — MEASURED fix latency, from the public GitHub
// issues API, unauthenticated.
//
// Why this exists: the security page stated configured limits and no
// measured figure of any kind, so a stranger had no way to tell an
// abandoned repo from a maintained one. This block gives the page a dated,
// honest "how fast things get closed": issues closed in the last
// WINDOW_DAYS days (n), the median and 75th-percentile open-to-close time
// in hours, and how many issues are open right now. Pull requests are
// excluded (the /issues endpoint returns both).
//
// Determinism contract — read this before changing the refresh rule:
//
//   The truthbase gate (`generate.mjs --check`) regenerates every field and
//   fails the build when the result differs from the committed file. A
//   generator that hit the network on every run would move these numbers
//   on any day an issue closed, and an unrelated PR would go red for a
//   reason nothing in it could fix. So:
//
//   - By default (and ALWAYS under --check) this generator returns the
//     block already committed in .claims.json, verbatim. No network.
//   - `node scripts/claims/generate.mjs --live` (or IRIS_CLAIMS_LIVE=1)
//     fetches a fresh sample. `source: "live"` and `sampledAt` record that
//     the numbers came from the API at that moment.
//   - If a refresh was asked for and the API is unreachable, the committed
//     block is returned with `source: "cached"` so the surface can say the
//     sample is the last one that succeeded, and the error is printed.
//
//   The page renders `sampledAt`, so a stale sample reads as stale rather
//   than as current. This generator warns when the committed sample is
//   older than STALE_AFTER_DAYS.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const CLAIMS_PATH = resolve(root, '.claims.json');

export const REPO = 'iris-eval/mcp-server';
export const WINDOW_DAYS = 90;
export const STALE_AFTER_DAYS = 45;
const API = `https://api.github.com/repos/${REPO}/issues`;
const MAX_PAGES = 20; // hard stop; three pages covers this repo today
export const METHOD =
  `GitHub REST /repos/${REPO}/issues, unauthenticated; pull requests excluded; ` +
  `hours = closed_at minus created_at; median and p75 by linear interpolation between ` +
  `order statistics; window = issues whose closed_at falls in the last ${WINDOW_DAYS} days.`;

/** Linear-interpolated percentile (R-7 / NumPy default) of a sorted array. */
export function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

const round1 = v => (v === null ? null : Math.round(v * 10) / 10);

/**
 * Pure computation over raw API items. `closedItems` may contain pull
 * requests and issues closed outside the window (the API's `since` filter
 * is on updated_at, a superset); both are filtered here.
 */
export function computeMaintenance(closedItems, openItems, { now, windowDays = WINDOW_DAYS }) {
  const nowMs = now.getTime();
  const sinceMs = nowMs - windowDays * 86_400_000;
  const isIssue = i => !i.pull_request;
  const closed = closedItems
    .filter(isIssue)
    .filter(i => i.closed_at && Date.parse(i.closed_at) >= sinceMs && Date.parse(i.closed_at) <= nowMs);
  const hours = closed
    .map(i => (Date.parse(i.closed_at) - Date.parse(i.created_at)) / 36e5)
    .sort((a, b) => a - b);
  const open = openItems.filter(isIssue);
  return {
    repo: REPO,
    windowDays,
    sampledAt: now.toISOString(),
    issues: {
      closedInWindow: closed.length,
      closedAsCompleted: closed.filter(i => i.state_reason !== 'not_planned').length,
      closedAsNotPlanned: closed.filter(i => i.state_reason === 'not_planned').length,
      medianHoursToClose: round1(percentile(hours, 0.5)),
      p75HoursToClose: round1(percentile(hours, 0.75)),
      openNow: open.length,
    },
    method: METHOD,
  };
}

function nextLink(linkHeader) {
  if (!linkHeader) return null;
  const m = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

async function fetchAll(url, fetchImpl) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'iris-claims-generator (https://github.com/iris-eval/mcp-server)',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const items = [];
  let next = url;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const res = await fetchImpl(next, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${next}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(`GitHub API returned a non-array for ${next}`);
    items.push(...body);
    next = nextLink(res.headers.get('link'));
  }
  if (next) throw new Error(`GitHub API pagination exceeded ${MAX_PAGES} pages for ${url}`);
  return items;
}

/** Live sample. Exported so the test can drive it with a fake fetch. */
export async function sampleLive({ now = new Date(), fetchImpl = globalThis.fetch } = {}) {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const closedItems = await fetchAll(
    `${API}?state=closed&since=${encodeURIComponent(since)}&per_page=100`,
    fetchImpl,
  );
  const openItems = await fetchAll(`${API}?state=open&per_page=100`, fetchImpl);
  return { ...computeMaintenance(closedItems, openItems, { now }), source: 'live' };
}

async function readCached(claimsPath) {
  try {
    const claims = JSON.parse(await readFile(claimsPath, 'utf-8'));
    return claims.maintenance ?? null;
  } catch {
    return null;
  }
}

export function wantsLive(argv = process.argv, env = process.env) {
  const args = new Set(argv.slice(2));
  if (args.has('--check')) return false;
  return args.has('--live') || env.IRIS_CLAIMS_LIVE === '1';
}

export async function generate({
  argv = process.argv,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  claimsPath = CLAIMS_PATH,
  warn = msg => console.warn(msg),
} = {}) {
  const cached = await readCached(claimsPath);
  if (!wantsLive(argv, env)) {
    if (!cached) {
      throw new Error(
        'Maintenance generator: no `maintenance` block in .claims.json and no refresh requested. ' +
          'Run `node scripts/claims/generate.mjs --live` once while online.',
      );
    }
    warnIfStale(cached, now, warn);
    return cached;
  }
  try {
    return await sampleLive({ now, fetchImpl });
  } catch (err) {
    if (!cached) {
      throw new Error(`Maintenance generator: live sample failed and nothing is cached — ${err.message}`);
    }
    warn(
      `[claims:generate] maintenance: live sample failed (${err.message}); ` +
        `keeping the committed sample from ${cached.sampledAt} with source: "cached"`,
    );
    return { ...cached, source: 'cached' };
  }
}

function warnIfStale(block, now, warn) {
  const ageDays = (now.getTime() - Date.parse(block.sampledAt)) / 86_400_000;
  if (Number.isFinite(ageDays) && ageDays > STALE_AFTER_DAYS) {
    warn(
      `[claims:generate] maintenance sample is ${Math.floor(ageDays)} days old (sampled ${block.sampledAt}); ` +
        'refresh with `node scripts/claims/generate.mjs --live`',
    );
  }
}
