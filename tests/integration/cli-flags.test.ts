/*
 * `iris-mcp --version`, the version in `--help`, `--purge`, and the
 * mode-flag exclusivity — through the REAL CLI entry point, the way a user
 * runs it. Every spawned process gets its own scratch IRIS_HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PKG_VERSION } from '../../src/config/defaults.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import { generateEvalId } from '../../src/utils/ids.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const entryPoint = join(repoRoot, 'src', 'index.ts');

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'iris-cli-flags-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entryPoint, ...args], {
      cwd: repoRoot,
      env: { ...process.env, IRIS_HOME: home, IRIS_NO_AUTO_LAUNCH: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('error', rejectPromise);
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe('--version / --help', () => {
  it('--version prints the bare package version on stdout and exits 0 (#369 item 5)', async () => {
    const { code, stdout, stderr } = await runCli(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(PKG_VERSION);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(stderr).toBe('');
    // Answers without touching the home directory.
    expect(existsSync(join(home, 'iris.db'))).toBe(false);
  }, 30_000);

  it('--help prints the version in its banner and documents --version and --purge', async () => {
    const { code, stderr } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stderr).toContain(`Iris — MCP-Native Agent Eval Server v${PKG_VERSION}`);
    expect(stderr).toContain('--version');
    expect(stderr).toContain('--purge');
  }, 30_000);
});

describe('--purge', () => {
  const SENTINEL = 'PURGE-SENTINEL-536-22-8145';

  it('deletes every stored trace and evaluation, compacts the file, and leaves no copy of the text on disk', async () => {
    // Seed the CONFIGURED database the way a previous server run would.
    const dbPath = join(home, 'iris.db');
    const seed = new SqliteAdapter(dbPath);
    await seed.initialize();
    await seed.insertTrace(LOCAL_TENANT, {
      trace_id: 'a'.repeat(32),
      agent_name: 'purge-agent',
      output: SENTINEL,
      timestamp: new Date().toISOString(),
    });
    await seed.insertEvalResult(LOCAL_TENANT, {
      id: generateEvalId(),
      trace_id: 'a'.repeat(32),
      eval_type: 'safety',
      output_text: SENTINEL,
      score: 0,
      passed: false,
      rule_results: [],
      suggestions: [],
    });
    await seed.close();
    // Anti-theater: the text is on disk before the purge.
    expect(readFileSync(dbPath).includes(SENTINEL)).toBe(true);

    const { code, stderr } = await runCli(['--purge']);
    expect(code).toBe(0);
    expect(stderr).toContain('purged 1 trace(s) and 1 evaluation(s)');
    expect(stderr).toContain(dbPath);
    expect(stderr).toContain('Deployed rules, audit log and preferences were kept');

    expect(readFileSync(dbPath).includes(SENTINEL)).toBe(false);
    const wal = `${dbPath}-wal`;
    expect(!existsSync(wal) || !readFileSync(wal).includes(SENTINEL)).toBe(true);

    const check = new SqliteAdapter(dbPath);
    await check.initialize();
    try {
      expect((await check.queryTraces(LOCAL_TENANT, {})).total).toBe(0);
      expect((await check.queryEvalResults(LOCAL_TENANT, {})).total).toBe(0);
    } finally {
      await check.close();
    }
  }, 60_000);

  it('exits 0 with zero counts on an empty database', async () => {
    const { code, stderr } = await runCli(['--purge']);
    expect(code).toBe(0);
    expect(stderr).toContain('purged 0 trace(s) and 0 evaluation(s)');
  }, 30_000);
});

describe('mode flags are mutually exclusive', () => {
  it.each([
    ['--purge', '--demo'],
    ['--purge', '--self-test'],
    ['--demo', '--demo-clear'],
    ['--purge', '--demo-clear'],
  ])('%s with %s exits 2 naming both flags', async (a, b) => {
    const { code, stderr } = await runCli([a, b]);
    expect(code).toBe(2);
    expect(stderr).toContain(a);
    expect(stderr).toContain(b);
    expect(stderr).toContain('cannot be combined');
    // Refused before anything touched the filesystem.
    expect(existsSync(join(home, 'iris.db'))).toBe(false);
    expect(existsSync(join(home, 'demo.db'))).toBe(false);
  }, 30_000);

  it('--purge with --dashboard exits 2 instead of purging and silently dropping the dashboard flag', async () => {
    const { code, stderr } = await runCli(['--purge', '--dashboard']);
    expect(code).toBe(2);
    expect(stderr).toContain('--purge');
    expect(stderr).toContain('--dashboard');
    expect(stderr).toContain('cannot be combined');
    expect(existsSync(join(home, 'iris.db'))).toBe(false);
  }, 30_000);
});
