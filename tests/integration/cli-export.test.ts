/*
 * `iris-eval export` (#4) through the REAL CLI entry point, each process in
 * its own scratch IRIS_HOME: traces stored with `ingest` come back out as
 * the same bytes the dashboard's export sends, filtered the same way, and
 * a bad flag is refused with the endpoint's own sentence.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import { CSV_BOM, TRACE_COLUMNS, traceEncoder } from '../../src/export/format.js';
import { parseCsv } from '../helpers/csv.js';

const repoRoot = resolve(__dirname, '..', '..');
const entryPoint = resolve(repoRoot, 'src', 'index.ts');
let home: string;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'iris-cli-export-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function run(args: string[], stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entryPoint, ...args], {
      cwd: repoRoot,
      env: { ...process.env, IRIS_HOME: home, IRIS_DB_PATH: join(home, 'iris.db'), IRIS_NO_AUTO_LAUNCH: '1' },
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (c: string) => { stdout += c; });
    child.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('error', rejectPromise);
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
    if (stdin !== undefined) { child.stdin!.write(stdin); child.stdin!.end(); }
  });
}

const TRACES = [
  { agent_name: 'support-bot', input: 'refund for order 5521?', output: '=1+1 your refund for order 5521 is approved', timestamp: '2026-09-01T10:00:00.000Z' },
  { agent_name: 'support-bot', output: 'shipping takes two days', timestamp: '2026-09-02T10:00:00.000Z' },
  { agent_name: 'sales-bot', output: 'refund declined', timestamp: '2026-09-03T10:00:00.000Z' },
].map((t) => JSON.stringify(t)).join('\n');

describe('iris-eval export', () => {
  it('writes the stored traces as the same JSON Lines the endpoint streams, with the filters applied', async () => {
    expect((await run(['ingest', '--evaluate'], TRACES)).code).toBe(0);
    const { code, stdout, stderr } = await run(['export', 'traces', '--format', 'jsonl', '--agent-name', 'support-bot', '--sort-order', 'asc']);
    expect(code, stderr).toBe(0);

    const storage = new SqliteAdapter(join(home, 'iris.db'));
    await storage.initialize();
    try {
      const expected: string[] = [];
      for await (const batch of storage.exportTraces(LOCAL_TENANT, { filter: { agent_name: 'support-bot' }, sort_order: 'asc' })) expected.push(traceEncoder('jsonl').batch(batch));
      expect(stdout).toBe(expected.join(''));
    } finally {
      await storage.close();
    }
    const lines = stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.trace.output)).toEqual(['=1+1 your refund for order 5521 is approved', 'shipping takes two days']);
    expect(lines[0].evals).toHaveLength(1);
  }, 60_000);

  it('writes CSV to --out with a BOM, searches with --q, and says how many it wrote', async () => {
    expect((await run(['ingest'], TRACES)).code).toBe(0);
    const out = join(home, 'refunds.csv');
    const { code, stderr } = await run(['export', 'traces', '--format', 'csv', '--q', 'refund', '--out', out]);
    expect(code, stderr).toBe(0);
    expect(stderr).toContain(`2 traces written to ${out}`);
    const text = readFileSync(out, 'utf8');
    expect(text.startsWith(CSV_BOM)).toBe(true);
    const [header, ...rows] = parseCsv(text.slice(CSV_BOM.length));
    expect(header).toEqual(TRACE_COLUMNS.map((c) => c.name));
    expect(rows.map((r) => r[header.indexOf('output')]).sort()).toEqual(["'=1+1 your refund for order 5521 is approved", 'refund declined']);
  }, 60_000);

  it('exports evaluations with their filters', async () => {
    expect((await run(['ingest', '--evaluate', '--eval-type', 'safety'], TRACES)).code).toBe(0);
    const { code, stdout, stderr } = await run(['export', 'evaluations', '--format', 'jsonl', '--eval-type', 'safety']);
    expect(code, stderr).toBe(0);
    const lines = stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.eval_type === 'safety')).toBe(true);
  }, 60_000);

  it('refuses a missing kind, a missing format, another kind’s filter and a bad value — exit 2, nothing written', async () => {
    const out = join(home, 'never.csv');
    const cases: Array<[string[], RegExp]> = [
      [['export', '--format', 'csv'], /say what to export: traces or evaluations/],
      [['export', 'traces'], /--format:/],
      [['export', 'traces', '--format', 'xml'], /format must be one of: csv, jsonl/],
      [['export', 'traces', '--format', 'csv', '--eval-type', 'safety', '--out', out], /--eval-type filters evaluations, not traces/],
      [['export', 'traces', '--format', 'csv', '--since', 'yesterday'], /--since:/],
      [['export', 'traces', '--format', 'csv', '--nope', 'x'], /Unknown option '--nope'/],
    ];
    for (const [args, message] of cases) {
      const { code, stderr, stdout } = await run(args);
      expect(code, args.join(' ')).toBe(2);
      expect(stderr, args.join(' ')).toMatch(message);
      expect(stdout).toBe('');
    }
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  it('export --help prints the usage on stdout', async () => {
    const { code, stdout } = await run(['export', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('export traces|evaluations --format csv|jsonl');
  }, 30_000);
});
