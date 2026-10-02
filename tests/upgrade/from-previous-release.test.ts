/*
 * Upgrading from the released 0.19.0, end to end (#704).
 *
 * 0.19.0 is the first release whose `install` pins each MCP client to its
 * own version, and 0.20.0 the first to add a migration after it: every
 * client shares one database, so the first 0.20.0 process to open it locks
 * out the clients still pinned to 0.19.0. This drives the whole path a
 * user takes, with the real 0.19.0 package from npm and this checkout, in
 * a scratch home — the client configs, IRIS_HOME and the database are all
 * under it, never the machine's own:
 *
 *   0.19.0 installs three clients and stores traces
 *   → this version's self-test reads the file without changing it and says what the next start will do
 *   → this version stores a trace: it copies the file, migrates it, and names the clients that can no longer open it
 *   → 0.19.0 now refuses the file (its guard cannot change)
 *   → the self-test fails on the stranded clients; `install --upgrade` moves them; the self-test passes
 *   → the downgrade drill from the README: restoring the copy lets 0.19.0 open its file again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PKG_VERSION } from '../../src/config/defaults.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import { SELF_TEST_STEPS, SELF_TEST_PASS_VERDICT } from '../../src/self-test.js';
import { runInstall } from '../../src/cli/install/command.js';
import { compareVersions } from '../../src/utils/versions.js';
import { resolveTraceCost } from '../../src/cost/trace-cost.js';
import type { Trace } from '../../src/types/trace.js';
import { KNOWN_MIGRATION_IDS } from '../../src/storage/migrations/index.js';

const N = KNOWN_MIGRATION_IDS.length;
/** The migrations after the fourteen 0.19.0 knows. */
const AFTER = KNOWN_MIGRATION_IDS.slice(14).join(', ');

const PREVIOUS = '0.19.0';
/*
 * The release `install` moves the clients to. A checkout before the release
 * bump still calls itself the last release, so `install` is also run in
 * process with the version it will have; from the bump on, that is this
 * package's own.
 */
const RELEASE = compareVersions(PKG_VERSION, '0.20.0') >= 0 ? PKG_VERSION : '0.20.0';
const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const repoRoot = resolve(import.meta.dirname, '../..');
const entryPoint = join(repoRoot, 'src', 'index.ts');

let root: string;
let home: string;
let irisHome: string;
let dbPath: string;
let previousBin: string;

/** Every client path, IRIS_HOME and the database resolve inside the scratch home; no IRIS_* from the caller's shell leaks in. */
function env(): NodeJS.ProcessEnv {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('IRIS_')));
  return {
    ...base,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'),
    CLAUDE_CONFIG_DIR: '',
    CODEX_HOME: '',
    CONTINUE_GLOBAL_DIR: '',
    CLINE_DIR: '',
    CLINE_DATA_DIR: '',
    GEMINI_CLI_HOME: '',
    IRIS_HOME: irisHome,
    IRIS_NO_AUTO_LAUNCH: '1',
  };
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(argv: string[], stdin?: string): Promise<Run> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, argv, { cwd: repoRoot, env: env(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.once('error', rejectPromise);
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

/** `install` in process, against the scratch home, as RELEASE. */
async function install(args: string[]): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const code = await runInstall(args, {
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
    environment: { platform: process.platform, home, env: env() },
    version: RELEASE,
  });
  return { code, stdout, stderr };
}

/** The released 0.19.0. */
const previous = (args: string[], stdin?: string) => run([previousBin, ...args], stdin);
/** This checkout. */
const current = (args: string[], stdin?: string) => run(['--import', 'tsx', entryPoint, ...args], stdin);

const trace = (words: string) => JSON.stringify({ agent_name: 'upgrade', input: `What about ${words}?`, output: `The answer mentions ${words}.` });

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function backups(): string[] {
  return readdirSync(irisHome).filter((n) => n.startsWith('iris.db.') && n.endsWith('.bak'));
}

const configs = () => ({
  'claude-code': join(home, '.claude.json'),
  cursor: join(home, '.cursor', 'mcp.json'),
  codex: join(home, '.codex', 'config.toml'),
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'iris-upgrade-'));
  home = join(root, 'home');
  irisHome = join(home, '.iris');
  dbPath = join(irisHome, 'iris.db');
  mkdirSync(home, { recursive: true });
  const prefix = join(root, 'previous');
  mkdirSync(prefix);
  /*
   * The released package: from the tarball the caller names, or from the
   * registry. CI names one it keeps in a cache (IRIS_PREVIOUS_TARBALL), so a
   * run downloads this project's own release from the registry zero times.
   * Until then every run did, on three operating systems, and those installs
   * were most of what the package's public download count measured. A named
   * tarball that is missing is an error, never a quiet return to the registry.
   */
  const tarball = process.env.IRIS_PREVIOUS_TARBALL;
  if (tarball && !existsSync(tarball)) throw new Error(`IRIS_PREVIOUS_TARBALL names ${tarball}, which does not exist`);
  const spec = tarball ? resolve(tarball) : `@iris-eval/mcp-server@${PREVIOUS}`;
  // npm is a batch file on Windows; the shell runs it. The install uses the caller's own npm cache and registry settings.
  const npm = spawnSync('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', `"${spec}"`], { encoding: 'utf-8', shell: true });
  if (npm.status !== 0) throw new Error(`npm install ${spec} failed:\n${npm.stderr}`);
  const installed = JSON.parse(readFileSync(join(prefix, 'node_modules', '@iris-eval', 'mcp-server', 'package.json'), 'utf-8')) as { version: string };
  if (installed.version !== PREVIOUS) throw new Error(`${spec} is @iris-eval/mcp-server ${installed.version}, not the ${PREVIOUS} this test upgrades from`);
  previousBin = join(prefix, 'node_modules', '@iris-eval', 'mcp-server', 'dist', 'index.js');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe(`upgrading from the released ${PREVIOUS}`, () => {
  it(`${PREVIOUS} installs three clients, pinned to itself, and stores traces`, async () => {
    for (const client of ['claude-code', 'cursor', 'codex']) {
      const r = await previous(['install', client]);
      expect(r.code, r.stderr).toBe(0);
    }
    for (const path of Object.values(configs())) expect(readFileSync(path, 'utf-8')).toContain(`@iris-eval/mcp-server@${PREVIOUS}`);
    for (const words of ['walrus tusks', 'narwhal horns']) {
      const r = await previous(['ingest'], trace(words));
      expect(r.code, r.stderr).toBe(0);
    }
    expect(existsSync(dbPath)).toBe(true);
    const list = await install(['--list']);
    expect(list.stdout).toMatch(new RegExp(`claude-code +Iris ${esc(PREVIOUS)} `));
    expect(list.stdout).toContain(`claude-code, cursor, codex run another Iris than this one (${RELEASE}): \`npx -y @iris-eval/mcp-server@${RELEASE} install --upgrade\``);
  });

  it('the self-test reads the file without changing it, and says what the next start will do', async () => {
    const before = sha256(dbPath);
    const r = await current(['--self-test']);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain(`✓ ${SELF_TEST_STEPS.database} — schema 14 of ${N}: the next start applies ${AFTER}, after copying the file next to it; from then on Iris before 0.20.0 cannot open it`);
    expect(r.stdout).toMatch(new RegExp(`✓ ${SELF_TEST_STEPS.clients} — .*will not open it once this version upgrades it .*install --upgrade`));
    expect(r.stdout).toContain(`Claude Code (Iris ${PREVIOUS})`);
    expect(sha256(dbPath)).toBe(before);
    expect(backups()).toEqual([]);
  });

  it('the first start of this version copies the file, migrates it, and names the clients it strands', async () => {
    const before = sha256(dbPath);
    const r = await current(['ingest'], trace('platypus bills'));
    expect(r.code, r.stderr).toBe(0);
    const copies = backups();
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(new RegExp(`^iris\\.db\\.${esc(PREVIOUS)}-to-${esc(PKG_VERSION)}\\.\\d{8}T\\d{6}Z\\.bak$`));
    const copy = join(irisHome, copies[0]);
    expect(r.stderr).toContain(`[iris.storage] Upgraded ${dbPath} for Iris ${PKG_VERSION} (${AFTER}). Iris releases before 0.20.0 cannot open it now. The file as it was is at ${copy}`);
    expect(r.stderr).toContain(`[iris] Claude Code (Iris ${PREVIOUS}), Cursor (Iris ${PREVIOUS}) and OpenAI Codex CLI (Iris ${PREVIOUS}) cannot open ${dbPath} now that it is upgraded. Move every client to Iris ${PKG_VERSION} with: npx -y @iris-eval/mcp-server@${PKG_VERSION} install --upgrade`);
    // The copy is the file as 0.19.0 left it: its two traces, its fourteen migrations.
    expect(sha256(dbPath)).not.toBe(before);
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(copy, { readonly: true });
    expect((db.prepare('SELECT COUNT(*) AS n FROM traces').get() as { n: number }).n).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM _iris_migrations').get() as { n: number }).n).toBe(14);
    db.close();
    // Search finds what 0.19.0 wrote.
    const s = new SqliteAdapter(dbPath);
    await s.initialize();
    await s.whenSearchIndexReady();
    const found = await s.queryTraces(LOCAL_TENANT, { search: 'narwhal' });
    expect(found.traces).toHaveLength(1);
    expect(s.upgradeReport()).toBeUndefined();
    await s.close();
  });

  it(`${PREVIOUS} now refuses the file, as its guard always will`, async () => {
    const r = await previous(['ingest'], trace('refused'));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/newer Iris .*015-trace-search.* are unknown to v0\.19\.0/);
  });

  it('the self-test fails on the stranded clients and names the command, without changing the file', async () => {
    const before = sha256(dbPath);
    const r = await current(['--self-test']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`✓ ${SELF_TEST_STEPS.database} — up to date (schema ${N} of ${N}); Iris 0.20.0 and later can open it`);
    expect(r.stdout).toContain(`✗ ${SELF_TEST_STEPS.clients} — Claude Code (Iris ${PREVIOUS}), Cursor (Iris ${PREVIOUS}) and OpenAI Codex CLI (Iris ${PREVIOUS}) cannot open this database`);
    expect(r.stdout).toContain(`npx -y @iris-eval/mcp-server@${PKG_VERSION} install --upgrade`);
    expect(sha256(dbPath)).toBe(before);
  });

  it('install --upgrade moves every client in one step, and the self-test passes', async () => {
    const r = await install(['--upgrade']);
    expect(r.code, r.stderr).toBe(0);
    for (const id of ['claude-code', 'cursor', 'codex']) expect(r.stdout).toMatch(new RegExp(`${id} +${esc(PREVIOUS)} -> ${esc(RELEASE)} `));
    for (const path of Object.values(configs())) {
      const text = readFileSync(path, 'utf-8');
      expect(text).toContain(`@iris-eval/mcp-server@${RELEASE}`);
      expect(text).not.toContain(`@iris-eval/mcp-server@${PREVIOUS}`);
    }
    const again = await install(['--upgrade']);
    expect(again.stdout).toContain(`already on ${RELEASE}`);
    // Through the real entry point too: it answers, and moves nothing back.
    const cli = await current(['install', '--upgrade']);
    expect(cli.code, cli.stderr).toBe(0);
    expect(cli.stdout).toContain(`Moving every MCP client that runs Iris to ${PKG_VERSION}:`);
    for (const path of Object.values(configs())) expect(readFileSync(path, 'utf-8')).toContain(`@iris-eval/mcp-server@${RELEASE}`);
    const test = await current(['--self-test']);
    expect(test.code, test.stdout).toBe(0);
    expect(test.stdout).toContain(SELF_TEST_PASS_VERDICT);
  });

  it(`${PREVIOUS} reads and writes a ledger with the compat_floor column: only the migration it does not know stops it`, async () => {
    // The upgraded file, with the ledger rows 0.19.0 does not know taken out: what is left for it to trip on is the new column.
    const probe = join(root, 'ledger-probe.db');
    const Database = (await import('better-sqlite3')).default;
    const src = new Database(dbPath);
    src.pragma('wal_checkpoint(TRUNCATE)');
    src.close();
    copyFileSync(dbPath, probe);
    const db = new Database(probe);
    expect((db.prepare("SELECT compat_floor FROM _iris_migrations WHERE id = '014-trace-session'").get() as { compat_floor: string }).compat_floor).toBe('0.16.0');
    db.prepare("DELETE FROM _iris_migrations WHERE id > '014-trace-session'").run();
    db.close();
    const r = await new Promise<Run>((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [previousBin, 'ingest'], { cwd: repoRoot, env: { ...env(), IRIS_DB_PATH: probe }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      child.once('error', rejectPromise);
      child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
      child.stdin.end(trace('ledger column'));
    });
    expect(r.code, r.stderr).toBe(0);
    const after = new Database(probe, { readonly: true });
    expect((after.prepare("SELECT COUNT(*) AS n FROM traces WHERE output LIKE '%ledger column%'").get() as { n: number }).n).toBe(1);
    expect((after.prepare("SELECT compat_floor FROM _iris_migrations WHERE id = '014-trace-session'").get() as { compat_floor: string }).compat_floor).toBe('0.16.0');
    after.close();
  });

  it(`the downgrade drill: restoring the copy lets ${PREVIOUS} open its file again`, async () => {
    const [copy] = backups();
    for (const side of ['-wal', '-shm']) rmSync(`${dbPath}${side}`, { force: true });
    copyFileSync(join(irisHome, copy), dbPath);
    const r = await previous(['ingest'], trace('back again'));
    expect(r.code, r.stderr).toBe(0);
  });
});

/*
 * The floors of the migrations after 015 (src/storage/migrations): each is
 * lowered below the release that introduced it only on this evidence. The
 * released 0.19.0's own adapter writes into a file that carries them: every
 * ledger row 0.19.0 does not know is taken out first (its guard would
 * refuse them, 015's floor keeps it out in real use), so what is left to go
 * wrong is the schema those migrations added. This release then reads back
 * every row 0.19.0 touched.
 */
describe(`the later migrations are safe for ${PREVIOUS} to write through`, () => {
  it(`016 (a trace's cost source) and 017 (the judge's spend): ${PREVIOUS}'s inserts, patches, deletes and sweep read back with the right cost basis, and leave the spend as it was`, async () => {
    const file = join(root, 'floors.db');
    copyFileSync(join(repoRoot, 'tests', 'fixtures', 'db', 'iris-0.19.0.db'), file);
    const now = new Date().toISOString();
    const estimated = resolveTraceCost<Trace>({
      trace_id: 'e0000000000000000000000000000001', agent_name: 'estimated-bot', input: 'q', output: 'estimated platypus',
      token_usage: { prompt_tokens: 150_000, completion_tokens: 10_000, total_tokens: 160_000 }, metadata: { model: 'gpt-4o-mini' }, timestamp: now,
    });
    expect(estimated.cost_source).toBe('estimated');
    const s = new SqliteAdapter(file, { backup: false });
    await s.initialize();
    await s.insertTraces(LOCAL_TENANT, [estimated]);
    // A day of relevance-judge spend, as a judging release records it.
    const ledger = s.judgeSpendLedger();
    expect(ledger.reserve(LOCAL_TENANT, '2026-09-28', 1200, 1_000_000)).toBe(true);
    ledger.settle(LOCAL_TENANT, '2026-09-28', -200, true);
    const spend = ledger.read(LOCAL_TENANT, '2026-09-28');
    expect(spend).toMatchObject({ calls: 1 });
    await s.close();

    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(file);
    const later = raw.prepare("SELECT * FROM _iris_migrations WHERE id > '014-trace-session'").all() as Array<Record<string, unknown>>;
    expect(later.map((r) => r.id)).toEqual(expect.arrayContaining(['015-trace-search', '016-trace-cost-source', '017-relevance-judge-spend']));
    raw.prepare("DELETE FROM _iris_migrations WHERE id > '014-trace-session'").run();
    raw.close();

    const writer = await run([join(repoRoot, 'tests', 'upgrade', 'previous-writer.mjs'), join(root, 'previous', 'node_modules', '@iris-eval', 'mcp-server'), file, estimated.trace_id]);
    expect(writer.code, writer.stderr).toBe(0);
    // The patch and the delete found their rows; the sweep took the expired trace it stored and the fixture's trace from 2025.
    expect(JSON.parse(writer.stdout)).toEqual({ patched: true, deleted: true, swept: 2 });

    const back = new Database(file);
    const insert = back.prepare(`INSERT INTO _iris_migrations (${Object.keys(later[0]).join(', ')}) VALUES (${Object.keys(later[0]).map(() => '?').join(', ')})`);
    for (const row of later) insert.run(...Object.values(row));
    back.close();

    const now020 = new SqliteAdapter(file, { backup: false });
    await now020.initialize();
    const read = async (id: string) => now020.getTrace(LOCAL_TENANT, id);
    const e = await read(estimated.trace_id);
    expect(e).toMatchObject({ cost_source: 'estimated', cost_usd: estimated.cost_usd, metadata: { model: 'gpt-4o-mini', patched: 'by the previous release' } });
    expect(e?.cost_estimate).toEqual(estimated.cost_estimate);
    expect(await read('r0000000000000000000000000000001')).toMatchObject({ cost_source: 'reported', cost_usd: 0.5 });
    const costless = await read('n0000000000000000000000000000001');
    expect(costless?.cost_source).toBeUndefined();
    expect(costless?.cost_usd ?? null).toBeNull();
    expect(await read('x0000000000000000000000000000001')).toBeNull();
    expect(await read('0190a000000000000000000000000001')).toBeNull();
    expect(await read('0190a000000000000000000000000002')).toBeNull();
    // A fixture trace 0.19.0 left alone reads as it always did.
    expect(await read('0190a000000000000000000000000003')).not.toBeNull();
    // The search index takes in what 0.19.0 inserted without indexing.
    expect(await now020.whenSearchIndexReady()).toBe('ready');
    expect((await now020.queryTraces(LOCAL_TENANT, { search: 'narwhal' })).traces.map((t) => t.trace_id)).toEqual(['n0000000000000000000000000000001']);
    expect(now020.judgeSpendLedger().read(LOCAL_TENANT, '2026-09-28')).toEqual(spend);
    await now020.close();
  });
});
