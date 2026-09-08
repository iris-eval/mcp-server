/*
 * `iris-eval ingest` — the third door, through the REAL CLI entry point.
 *
 * Every spawned process gets its own scratch IRIS_HOME. The race test is
 * the one this verb exists to survive: two processes opening one cold file
 * at once, which used to fail the loser on SQLITE_BUSY_SNAPSHOT or a
 * duplicate column because migrations read "not applied" outside the lock.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';

const repoRoot = resolve(__dirname, '..', '..');
const entryPoint = resolve(repoRoot, 'src', 'index.ts');
let home: string;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'iris-cli-ingest-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function run(args: string[], stdin?: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entryPoint, ...args], {
      cwd: repoRoot,
      env: { ...process.env, IRIS_HOME: home, IRIS_NO_AUTO_LAUNCH: '1', ...env },
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('error', rejectPromise);
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
    if (stdin !== undefined) { child.stdin!.write(stdin); child.stdin!.end(); }
  });
}

const CLEAN = { agent_name: 'gate-bot', input: 'What is 2+2?', output: 'Four. Two plus two is four, and that is the whole of it.', cost_usd: 0.01 };
const PII = { agent_name: 'gate-bot', input: 'Summarise the ticket', output: 'The reporter is Marisol Quintero, SSN 123-45-6789, and her card ending 4242 was charged twice.' };
const lines = (s: string) => s.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe('iris-eval ingest', () => {
  it('stores and evaluates one trace from stdin, and prints the verdict with its basis', async () => {
    const { code, stdout, stderr } = await run(['ingest', '--evaluate'], JSON.stringify(CLEAN));
    expect(code, stderr).toBe(0);
    const [line] = lines(stdout);
    expect(line.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(line.evaluation_id).toBeDefined();
    expect(line.passed).toBe(true);
    expect((line.verdict as { basis: string }).basis).toBe('clean');
    expect(line.unjudged, 'no tool calls were sent, so the trajectory questions were not judged').toBeDefined();
    const storage = new SqliteAdapter(join(home, 'iris.db'));
    await storage.initialize();
    const trace = await storage.getTrace(LOCAL_TENANT, line.trace_id as string);
    expect(trace?.source).toBe('cli');
    await storage.close();
  }, 60_000);

  it('--fail-on detector_veto exits 1 on a PII output and 0 on a clean one', async () => {
    const bad = await run(['ingest', '--evaluate', '--fail-on', 'detector_veto'], JSON.stringify(PII));
    expect(bad.code, bad.stderr).toBe(1);
    const [line] = lines(bad.stdout);
    expect((line.verdict as { basis: string }).basis).toBe('detector_veto');
    expect(line.tripped).toBe('detector_veto');
    const good = await run(['ingest', '--evaluate', '--fail-on', 'detector_veto'], JSON.stringify(CLEAN));
    expect(good.code, good.stderr).toBe(0);
  }, 90_000);

  it('reads NDJSON from --file, one line out per line in, and records --source hook', async () => {
    const file = join(home, 'traces.ndjson');
    writeFileSync(file, [JSON.stringify(CLEAN), JSON.stringify({ ...CLEAN, run: 'nightly-1', case_key: 'q1' })].join('\n') + '\n');
    const { code, stdout, stderr } = await run(['ingest', '--file', file, '--evaluate', '--source', 'hook']);
    expect(code, stderr).toBe(0);
    const out = lines(stdout);
    expect(out).toHaveLength(2);
    const storage = new SqliteAdapter(join(home, 'iris.db'));
    await storage.initialize();
    const second = await storage.getTrace(LOCAL_TENANT, out[1].trace_id as string);
    expect(second?.source).toBe('hook');
    expect(second?.run_id).toBe('nightly-1');
    await storage.close();
  }, 60_000);

  it('refuses evaluate without an output before storing anything, and refuses an unknown command', async () => {
    const r = await run(['ingest', '--evaluate'], JSON.stringify({ agent_name: 'x', input: 'no output' }));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('needs an output');
    const u = await run(['evaluate']);
    expect(u.code).toBe(2);
    expect(u.stderr).toContain('unknown command');
    const c = await run(['ingest', '--dashboard'], JSON.stringify(CLEAN));
    expect(c.code).toBe(2);
    expect(c.stderr).toContain('cannot be combined');
  }, 60_000);

  it('two processes opening one cold file at once both succeed, and every migration is applied exactly once', async () => {
    const [a, b] = await Promise.all([
      run(['ingest', '--evaluate'], JSON.stringify(CLEAN)),
      run(['ingest', '--evaluate'], JSON.stringify(CLEAN)),
    ]);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    const storage = new SqliteAdapter(join(home, 'iris.db'));
    await storage.initialize();
    const traces = await storage.queryTraces(LOCAL_TENANT, { limit: 10 });
    expect(traces.traces.length).toBe(2);
    await storage.close();
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(join(home, 'iris.db'), { readonly: true });
    const rows = db.prepare('SELECT id, COUNT(*) AS n FROM _iris_migrations GROUP BY id HAVING n > 1').all();
    expect(rows).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM _iris_migrations').get() as { n: number }).n).toBeGreaterThanOrEqual(10);
    db.close();
  }, 120_000);

  it('never sweeps retention: a trace older than the retention window survives an ingest', async () => {
    const storage = new SqliteAdapter(join(home, 'iris.db'));
    await storage.initialize();
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    await storage.insertTrace(LOCAL_TENANT, { trace_id: 'a'.repeat(32), agent_name: 'old', output: 'old', timestamp: old, created_at: old });
    await storage.close();
    const { code, stderr } = await run(['ingest'], JSON.stringify(CLEAN));
    expect(code, stderr).toBe(0);
    const again = new SqliteAdapter(join(home, 'iris.db'));
    await again.initialize();
    expect(await again.getTrace(LOCAL_TENANT, 'a'.repeat(32)), 'the old trace was not swept').toBeDefined();
    await again.close();
  }, 60_000);
});
