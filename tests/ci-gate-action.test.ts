/*
 * The gate action: the composite action's shape, held as
 * text; the receipt built from what `ingest` prints; the comment's
 * decisions and its create-or-update against a local GitHub; the dogfood
 * job that runs it on every pull request; the fixtures it runs on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

// The two scripts run their main() on import unless told they are imported;
// hoisted so it is set before the static imports below are evaluated.
vi.hoisted(() => {
  process.env.GATE_RECEIPT_IMPORTED = '1';
  process.env.GATE_COMMENT_IMPORTED = '1';
});
import * as receiptScript from '../.github/actions/gate/receipt.mjs';
import * as commentScript from '../.github/actions/gate/comment.mjs';

const root = resolve(__dirname, '..');
const actionDir = join(root, '.github', 'actions', 'gate');
// Normalised: a Windows checkout reads CRLF, and the contract is about lines, not line endings.
const read = (rel: string) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');

const receiptModule = async () => receiptScript as unknown as { buildReceipt: (a: Record<string, unknown>) => { stored: number; evaluated: number; tripped: number; gated: number; markdown: string; emptyGreen: boolean } };
const commentModule = async () =>
  commentScript as unknown as {
    decide: (a: Record<string, unknown>) => { outcome: string; number?: number };
    upsertComment: (a: Record<string, unknown>) => Promise<string>;
    markerFor: (p: string) => string;
  };
/** The spawn-based cases start node twice; a loaded machine needs more than the default five seconds. */
const SPAWN_TIMEOUT = 30_000;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the action file', () => {
  const yml = read('.github/actions/gate/action.yml');

  it('is a composite action with the inputs and outputs the docs table lists', () => {
    expect(yml).toMatch(/^runs:\n {2}using: composite/m);
    for (const input of ['traces', 'fail-on', 'dataset', 'eval-type', 'redact', 'iris-home', 'version', 'command', 'comment', 'github-token']) {
      expect(yml, input).toMatch(new RegExp(`^ {2}${input}:\\n`, 'm'));
    }
    for (const output of ['exit-code', 'stored', 'evaluated', 'tripped', 'gated', 'summary-file', 'comment']) {
      expect(yml, output).toMatch(new RegExp(`^ {2}${output}:\\n {4}description:`, 'm'));
    }
    expect(yml).toMatch(/traces:\n {4}description: .*\n {4}required: true/);
    expect(yml).toContain('default: detector_veto');
    // Pinned to the release it ships in, rolled by version:sync (since 2026-09-23):
    // a workflow on @vX.Y.Z runs server X.Y.Z, not whatever npm calls latest today.
    const { version } = JSON.parse(read('package.json')) as { version: string };
    expect(yml).toContain(`default: '${version}'`);
  });

  it('runs ingest with flags the CLI parses, through npx by default, and reads the two scripts beside it', () => {
    const parsed = read('src/index.ts');
    for (const flag of ['--file', '--evaluate', '--fail-on', '--dataset', '--eval-type', '--redact']) {
      expect(yml, flag).toContain(flag);
      const name = flag.slice(2);
      expect(parsed, `src/index.ts parses ${flag}`).toMatch(new RegExp(`(?:'${name}'|(?<![\\w-])${name})\\s*:\\s*\\{`));
    }
    expect(yml).toContain('npx -y "@iris-eval/mcp-server@${INPUT_VERSION}"');
    expect(yml).toContain('IRIS_NO_AUTO_LAUNCH=1');
    expect(yml).toContain('node "$GITHUB_ACTION_PATH/receipt.mjs"');
    expect(yml).toContain('node "$GITHUB_ACTION_PATH/comment.mjs"');
    expect(() => readFileSync(join(actionDir, 'receipt.mjs'))).not.toThrow();
    expect(() => readFileSync(join(actionDir, 'comment.mjs'))).not.toThrow();
    // No third-party action inside the composite: nothing to pin, nothing to trust.
    expect(yml).not.toMatch(/^\s+uses:/m);
  });

  it('fails the job on ingest’s exit code only after the receipt and the comment ran', () => {
    const steps = [...yml.matchAll(/^ {4}- name: (.+)$/gm)].map((m) => m[1]);
    expect(steps).toEqual(['Evaluate the traces', 'The receipt', 'The comment', 'The verdict']);
    expect(yml).toMatch(/1\) echo "::error::Iris gate: .*; exit 1 ;;/);
  });
});

describe('the receipt', () => {
  const stdout = [
    JSON.stringify({ trace_id: 't-leak', evaluation_id: 'e1', passed: false, verdict: { state: 'fail', basis: 'detector_veto', by: ['no_pii'] }, gated: true, tripped: 'detector_veto', spans: [{ rule: 'no_pii', label: 'aws_access_key', source: 'output', start: 44, end: 64 }] }),
    JSON.stringify({ trace_id: 't-clean', evaluation_id: 'e2', passed: true, verdict: { state: 'pass', basis: 'clean', by: [] }, gated: true }),
    JSON.stringify({ trace_id: 't-outside', evaluation_id: 'e3', passed: false, verdict: { state: 'fail', basis: 'detector_veto', by: ['no_pii'] }, gated: false, unjudged: ['within_budget'] }),
    '',
  ].join('\n');
  const stderr = 'iris-eval ingest: 3 stored, 1 tripped --fail-on detector_veto (2 of 3 evaluated in dataset "release-gate")\n';

  it('counts stored, evaluated, tripped and gated from the lines, names the tripped trace with its rules and span labels, and never the text', async () => {
    const { buildReceipt } = await receiptModule();
    const r = buildReceipt({ stdout, stderr, exitCode: 1, tracesPath: 'traces.ndjson', failOn: 'detector_veto', dataset: 'release-gate' });
    expect(r).toMatchObject({ stored: 3, evaluated: 3, tripped: 1, gated: 2, emptyGreen: false });
    expect(r.markdown).toContain('### Iris gate — 1 of 2 tripped `--fail-on detector_veto`');
    expect(r.markdown).toContain('`iris-eval ingest: 3 stored, 1 tripped --fail-on detector_veto (2 of 3 evaluated in dataset "release-gate")`');
    expect(r.markdown).toContain('| `t-leak` | `detector_veto` | no_pii | no_pii: aws_access_key (output 44–64) |');
    expect(r.markdown).not.toContain('t-outside` | `detector_veto` | no_pii |'); // outside the gate: not a tripped row
    expect(r.markdown).toContain('| `detector_veto` | 2 |');
    expect(r.markdown).toContain('| `clean` | 1 |');
    expect(r.markdown).toContain('Unjudged questions: `within_budget` (1)');
    expect(r.markdown).toContain('dataset `release-gate`: 2 in the gate');
    expect(r.markdown).not.toMatch(/AKIA|access key/);
  });

  it('a clean run says so; an empty file is never green', async () => {
    const { buildReceipt } = await receiptModule();
    const clean = buildReceipt({ stdout: JSON.stringify({ trace_id: 't', evaluation_id: 'e', passed: true, verdict: { state: 'pass', basis: 'clean', by: [] } }) + '\n', stderr: 'iris-eval ingest: 1 stored, 0 tripped --fail-on any\n', exitCode: 0, tracesPath: 'clean.ndjson', failOn: 'any', dataset: '' });
    expect(clean).toMatchObject({ stored: 1, tripped: 0, gated: 1, emptyGreen: false });
    expect(clean.markdown).toContain('### Iris gate — 1 stored, nothing tripped `--fail-on any`');
    const empty = buildReceipt({ stdout: '', stderr: 'iris-eval ingest: 0 stored, 0 tripped --fail-on any\n', exitCode: 0, tracesPath: 'never-written.ndjson', failOn: 'any', dataset: '' });
    expect(empty.emptyGreen).toBe(true);
    expect(empty.markdown).toContain('**No trace was read from `never-written.ndjson`.**');
  });

  it('as a step: writes summary.md, the job summary and the outputs, and exits 1 on the empty-green case', async () => {
    const work = mkdtempSync(join(tmpdir(), 'iris-gate-receipt-'));
    dirs.push(work);
    writeFileSync(join(work, 'receipts.ndjson'), stdout);
    writeFileSync(join(work, 'ingest.log'), stderr);
    const summary = join(work, 'step-summary.md');
    const output = join(work, 'output.txt');
    writeFileSync(summary, '');
    writeFileSync(output, '');
    const env = { ...process.env, GATE_RECEIPT_IMPORTED: '', GATE_WORK: work, GATE_EXIT_CODE: '1', GATE_TRACES: 'traces.ndjson', GATE_FAIL_ON: 'detector_veto', GATE_DATASET: 'release-gate', GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output };
    delete (env as Record<string, string | undefined>).GATE_RECEIPT_IMPORTED;
    const code = await new Promise<number>((resolve) => spawn(process.execPath, [join(actionDir, 'receipt.mjs')], { env, windowsHide: true }).on('close', (c) => resolve(c ?? -1)));
    expect(code).toBe(0);
    expect(readFileSync(join(work, 'summary.md'), 'utf8')).toContain('1 of 2 tripped');
    expect(readFileSync(summary, 'utf8')).toContain('1 of 2 tripped');
    expect(readFileSync(output, 'utf8').replace(/\r\n/g, '\n')).toContain('stored=3\nevaluated=3\ntripped=1\ngated=2\nsummary-file=');
    writeFileSync(join(work, 'receipts.ndjson'), '');
    const emptyCode = await new Promise<number>((resolve) => spawn(process.execPath, [join(actionDir, 'receipt.mjs')], { env: { ...env, GATE_EXIT_CODE: '0' }, windowsHide: true }).on('close', (c) => resolve(c ?? -1)));
    expect(emptyCode).toBe(1);
  }, SPAWN_TIMEOUT);
});

describe('the comment', () => {
  let server: Server | null = null;
  afterEach(async () => {
    server?.closeAllConnections?.();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  it('decides from the event: off, not a pull request, a fork, no token, go', async () => {
    const { decide } = await commentModule();
    const pr = { pull_request: { number: 7, head: { repo: { full_name: 'iris-eval/mcp-server', fork: false } } } };
    expect(decide({ comment: 'false', eventName: 'pull_request', event: pr, repository: 'iris-eval/mcp-server', token: 't' })).toEqual({ outcome: 'skipped-off' });
    expect(decide({ comment: 'true', eventName: 'push', event: {}, repository: 'iris-eval/mcp-server', token: 't' })).toEqual({ outcome: 'skipped-not-pr' });
    const fork = { pull_request: { number: 8, head: { repo: { full_name: 'someone/mcp-server', fork: true } } } };
    expect(decide({ comment: 'true', eventName: 'pull_request', event: fork, repository: 'iris-eval/mcp-server', token: 't' })).toEqual({ outcome: 'skipped-fork', number: 8 });
    expect(decide({ comment: 'true', eventName: 'pull_request', event: pr, repository: 'iris-eval/mcp-server', token: '' })).toEqual({ outcome: 'skipped-no-token', number: 7 });
    expect(decide({ comment: 'true', eventName: 'pull_request', event: pr, repository: 'iris-eval/mcp-server', token: 't' })).toEqual({ outcome: 'go', number: 7 });
  });

  it('posts one comment behind the marker, updates it on the next run, and keeps two gates apart by their traces file', async () => {
    const { upsertComment, markerFor } = await commentModule();
    const comments: Array<{ id: number; body: string }> = [];
    const requests: string[] = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString();
      });
      req.on('end', () => {
        requests.push(`${req.method} ${req.url} auth=${req.headers.authorization}`);
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET') {
          res.end(JSON.stringify(comments));
        } else if (req.method === 'POST') {
          const c = { id: comments.length + 1, body: (JSON.parse(body) as { body: string }).body };
          comments.push(c);
          res.statusCode = 201;
          res.end(JSON.stringify(c));
        } else if (req.method === 'PATCH') {
          const id = Number(req.url!.split('/').pop());
          const c = comments.find((x) => x.id === id)!;
          c.body = (JSON.parse(body) as { body: string }).body;
          res.end(JSON.stringify(c));
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const common = { api, repository: 'iris-eval/mcp-server', number: 7, token: 'ghs_test' };
    expect(await upsertComment({ ...common, marker: markerFor('traces.ndjson'), body: '### Iris gate — first' })).toBe('posted');
    expect(await upsertComment({ ...common, marker: markerFor('traces.ndjson'), body: '### Iris gate — second' })).toBe('updated');
    expect(await upsertComment({ ...common, marker: markerFor('other.ndjson'), body: '### Iris gate — other' })).toBe('posted');
    expect(comments).toHaveLength(2);
    expect(comments[0].body).toBe('<!-- iris-gate:traces.ndjson -->\n### Iris gate — second');
    expect(comments[1].body).toBe('<!-- iris-gate:other.ndjson -->\n### Iris gate — other');
    expect(requests[0]).toBe('GET /repos/iris-eval/mcp-server/issues/7/comments?per_page=100&page=1 auth=Bearer ghs_test');
    expect(requests.some((r) => r.startsWith('PATCH /repos/iris-eval/mcp-server/issues/comments/1 '))).toBe(true);
  });

  it('an API refusal is a warning and skipped-error, never a failed step', async () => {
    server = createServer((_req, res) => {
      res.statusCode = 403;
      res.end('{"message":"Resource not accessible by integration"}');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const work = mkdtempSync(join(tmpdir(), 'iris-gate-comment-'));
    dirs.push(work);
    const eventPath = join(work, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7, head: { repo: { full_name: 'iris-eval/mcp-server', fork: false } } } }));
    const summaryFile = join(work, 'summary.md');
    writeFileSync(summaryFile, '### Iris gate — x');
    const output = join(work, 'output.txt');
    writeFileSync(output, '');
    const env: Record<string, string | undefined> = { ...process.env, GATE_COMMENT: 'true', GATE_TOKEN: 't', GATE_SUMMARY_FILE: summaryFile, GATE_TRACES: 'traces.ndjson', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: 'iris-eval/mcp-server', GITHUB_API_URL: api, GITHUB_OUTPUT: output };
    delete env.GATE_COMMENT_IMPORTED;
    let stdout = '';
    const code = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [join(actionDir, 'comment.mjs')], { env, windowsHide: true });
      child.stdout.on('data', (c: Buffer) => {
        stdout += c.toString();
      });
      child.on('close', (c) => resolve(c ?? -1));
    });
    expect(code).toBe(0);
    expect(stdout).toContain('::warning::Iris gate: the comment was not posted (GET comments: HTTP 403)');
    expect(readFileSync(output, 'utf8')).toBe('comment=skipped-error\n');
  }, SPAWN_TIMEOUT);
});

describe('the dogfood job and the fixtures', () => {
  it('ci.yml runs the action against the walk-through fixtures with the dataset seeded, on this checkout’s build, with the comment permission, and asserts both events', () => {
    const ci = read('.github/workflows/ci.yml');
    const job = ci.slice(ci.indexOf('  gate-action:'));
    expect(job.length).toBeGreaterThan(0);
    expect(job).toContain('pull-requests: write');
    expect(job).toContain('uses: ./.github/actions/gate');
    expect(job).toContain('traces: tests/fixtures/ci-gate/traces.ndjson');
    expect(job).toContain('traces: tests/fixtures/ci-gate/clean.ndjson');
    expect(job).toContain('dataset: release-gate');
    expect(job).toContain('command: node dist/index.js');
    expect(job).toContain('node scripts/ci/seed-gate-dataset.mjs');
    expect(job).toContain('[ "$LEAK_EXIT" = "1" ]');
    expect(job).toContain('[ "$CLEAN_EXIT" = "0" ]');
    expect(job).toContain('"skipped-not-pr"');
    expect(job).toContain('[ "$AGAIN_COMMENT" = "updated" ]');
  });

  it('the fixtures are the walk-through: two leaks (one outside the dataset) and one clean answer, each with a case key', () => {
    const traces = read('tests/fixtures/ci-gate/traces.ndjson').trim().split('\n').map((l) => JSON.parse(l) as { case_key: string; output: string });
    expect(traces.map((t) => t.case_key)).toEqual(['deploy-config', 'release-notes', 'scratch-experiment']);
    expect(traces.filter((t) => /AKIA[0-9A-Z]{16}/.test(t.output)).map((t) => t.case_key)).toEqual(['deploy-config', 'scratch-experiment']);
    const clean = read('tests/fixtures/ci-gate/clean.ndjson').trim().split('\n');
    expect(clean).toHaveLength(1);
    expect(JSON.parse(clean[0])).toMatchObject({ case_key: 'release-notes' });
    const seed = read('scripts/ci/seed-gate-dataset.mjs');
    expect(seed).toContain("label: 'release-gate'");
    expect(seed).toContain("caseKey: 'deploy-config'");
    expect(seed).toContain("caseKey: 'release-notes'");
    expect(seed).not.toContain('scratch-experiment');
  });
});
