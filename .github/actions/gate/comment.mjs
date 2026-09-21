/*
 * The comment (arc 9, N-17): on a pull request, the receipt as one comment
 * on the pull request, updated in place on every run — found by a marker
 * that names the traces file, so two gates in one workflow keep two
 * comments. Everywhere else it says why it did nothing and does nothing:
 * not a pull request; a pull request from a fork (its token is read-only);
 * the comment turned off; no token; the API refusing. A comment that fails
 * never fails the gate — the job summary already has the receipt.
 *
 * Plain `fetch` against the GitHub API; no third-party action to pin.
 *
 * Env: GATE_COMMENT ('true'/'false'), GATE_TOKEN, GATE_SUMMARY_FILE,
 * GATE_TRACES; GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY,
 * GITHUB_API_URL, GITHUB_OUTPUT as the runner sets them.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export const MARKER_PREFIX = '<!-- iris-gate:';

export function markerFor(tracesPath) {
  return `${MARKER_PREFIX}${String(tracesPath).replace(/-->/g, '').trim()} -->`;
}

/** What to do, from the event alone. */
export function decide({ comment, eventName, event, repository, token }) {
  if (String(comment).toLowerCase() !== 'true') return { outcome: 'skipped-off' };
  if (eventName !== 'pull_request' && eventName !== 'pull_request_target') return { outcome: 'skipped-not-pr' };
  const pr = event?.pull_request;
  if (!pr || typeof pr.number !== 'number') return { outcome: 'skipped-not-pr' };
  const headRepo = pr.head?.repo?.full_name;
  if (pr.head?.repo?.fork === true || (headRepo && repository && headRepo !== repository)) return { outcome: 'skipped-fork', number: pr.number };
  if (!token) return { outcome: 'skipped-no-token', number: pr.number };
  return { outcome: 'go', number: pr.number };
}

/** Create or update the one comment. Returns 'posted' | 'updated'; throws on an API refusal. */
export async function upsertComment({ api, repository, number, token, marker, body, fetchImpl = fetch }) {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'iris-gate' };
  const base = `${api}/repos/${repository}/issues/${number}/comments`;
  let existing = null;
  for (let page = 1; page <= 10 && existing === null; page += 1) {
    const res = await fetchImpl(`${base}?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GET comments: HTTP ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) break;
    existing = list.find((c) => typeof c.body === 'string' && c.body.startsWith(marker)) ?? null;
    if (list.length < 100) break;
  }
  const text = `${marker}\n${body}`;
  if (existing) {
    const res = await fetchImpl(`${api}/repos/${repository}/issues/comments/${existing.id}`, { method: 'PATCH', headers, body: JSON.stringify({ body: text }) });
    if (!res.ok) throw new Error(`PATCH comment ${existing.id}: HTTP ${res.status}`);
    return 'updated';
  }
  const res = await fetchImpl(base, { method: 'POST', headers, body: JSON.stringify({ body: text }) });
  if (!res.ok) throw new Error(`POST comment: HTTP ${res.status}`);
  return 'posted';
}

function output(outcome) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `comment=${outcome}\n`);
  process.stdout.write(`Iris gate comment: ${outcome}\n`);
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH ?? '';
  const event = eventPath && existsSync(eventPath) ? JSON.parse(readFileSync(eventPath, 'utf8')) : null;
  const decision = decide({
    comment: process.env.GATE_COMMENT ?? 'true',
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    event,
    repository: process.env.GITHUB_REPOSITORY ?? '',
    token: process.env.GATE_TOKEN ?? '',
  });
  if (decision.outcome !== 'go') {
    if (decision.outcome === 'skipped-fork') process.stdout.write('::notice::Iris gate: the pull request comes from a fork, whose token cannot comment; the receipt is on the job summary\n');
    output(decision.outcome);
    return;
  }
  const summaryFile = process.env.GATE_SUMMARY_FILE ?? '';
  const body = summaryFile && existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : '(no receipt was written)';
  try {
    const outcome = await upsertComment({
      api: process.env.GITHUB_API_URL ?? 'https://api.github.com',
      repository: process.env.GITHUB_REPOSITORY ?? '',
      number: decision.number,
      token: process.env.GATE_TOKEN ?? '',
      marker: markerFor(process.env.GATE_TRACES ?? ''),
      body,
    });
    output(outcome);
  } catch (err) {
    process.stdout.write(`::warning::Iris gate: the comment was not posted (${err instanceof Error ? err.message : String(err)}); the receipt is on the job summary. Does the job have permissions: pull-requests: write?\n`);
    output('skipped-error');
  }
}

if (process.env.GATE_COMMENT_IMPORTED !== '1') await main();
