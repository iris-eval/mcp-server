/*
 * --self-test's read of the configured database and of the clients that
 * share it (#704): read-only, and failing, with the fix, exactly when the
 * server or a pinned client would refuse the file.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeClientPins, probeDatabaseSchema } from '../../src/self-test.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { backupPath } from '../../src/storage/backup.js';
import { runInstall } from '../../src/cli/install/command.js';
import type { Environment } from '../../src/cli/install/clients.js';
import type { MigrationPlan } from '../../src/storage/migrations/index.js';
import { PKG_VERSION } from '../../src/config/defaults.js';
import { KNOWN_MIGRATION_IDS } from '../../src/storage/migrations/index.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';

const N = KNOWN_MIGRATION_IDS.length;
const FIXTURE_019 = resolve(import.meta.dirname, '../fixtures/db/iris-0.19.0.db');

let dir: string;
let e: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'iris-selftest-db-'));
  e = { platform: process.platform, home: join(dir, 'home'), env: { APPDATA: join(dir, 'home', 'AppData', 'Roaming') } };
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const escapeRegExp = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sha256 =(path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function currentFile(): Promise<string> {
  const path = join(dir, 'iris.db');
  const s = new SqliteAdapter(path);
  await s.initialize();
  await s.close();
  return path;
}

function edit(path: string, sql: string): void {
  const db = new Database(path);
  db.exec(sql);
  db.close();
}

const quiet = { stdout: { write: () => true }, stderr: { write: () => true } };

describe('the self-test reads the configured database', () => {
  it('a missing file is fine: the server creates it', () => {
    expect(probeDatabaseSchema(join(dir, 'none.db'))).toEqual({ detail: 'no database yet; this version creates it on first start', plan: null });
  });

  it('a file this version wrote is up to date, with the oldest release that can open it', async () => {
    const path = await currentFile();
    expect(probeDatabaseSchema(path).detail).toBe(`up to date (schema ${N} of ${N}); Iris 0.20.0 and later can open it`);
  });

  it('a file with a migration pending says what the next start does, and is not changed', async () => {
    const path = join(dir, 'iris.db');
    copyFileSync(FIXTURE_019, path);
    const before = sha256(path);
    expect(probeDatabaseSchema(path).detail).toBe(
      `schema 14 of ${N}: the next start applies ${KNOWN_MIGRATION_IDS.slice(14).join(', ')}, after copying the file next to it; from then on Iris before 0.20.0 cannot open it; indexes building: 4 of the indexes the dashboard and the failure log read are built in the background after the server starts, and those reads are slower until they are`,
    );
    expect(sha256(path)).toBe(before);
  });

  it('a file whose read indexes are not built yet says they are building', async () => {
    const path = join(dir, 'iris.db');
    const s = new SqliteAdapter(path);
    await s.initialize();
    await s.insertTraces(LOCAL_TENANT, [{ trace_id: 't1', agent_name: 'a', output: 'x', timestamp: new Date().toISOString() }]);
    await s.close();
    edit(path, 'DROP INDEX idx_traces_tenant_framework; DROP INDEX idx_spans_tenant_error; PRAGMA wal_checkpoint(TRUNCATE);');
    expect(probeDatabaseSchema(path).detail).toBe(
      `up to date (schema ${N} of ${N}); Iris 0.20.0 and later can open it; indexes building: 2 of the indexes the dashboard and the failure log read are built in the background after the server starts, and those reads are slower until they are`,
    );
  });

  it('a file a newer release migrated past this version fails, with both ways out and the newest copy, and is not changed', async () => {
    const path = await currentFile();
    edit(path, "INSERT INTO _iris_migrations (id, writer_version, compat_floor) VALUES ('099-future', '99.0.0', '99.0.0'); PRAGMA wal_checkpoint(TRUNCATE);");
    const copy = backupPath(path, PKG_VERSION, '99.0.0', new Date(Date.UTC(2026, 8, 28, 10, 15, 0)));
    writeFileSync(copy, 'x');
    const before = sha256(path);
    expect(() => probeDatabaseSchema(path)).toThrow(
      new RegExp(`migration\\(s\\) 099-future need Iris 99\\.0\\.0 or later.*install --upgrade.*The newest copy taken before an upgrade is .*\\.bak \\(from ${escapeRegExp(PKG_VERSION)}, taken 2026-09-28T10:15:00\\.000Z\\)\\. Nothing was changed\\.`),
    );
    expect(sha256(path)).toBe(before);
  });

  it('a file a newer release migrated within this version’s floor opens, and says so', async () => {
    const path = await currentFile();
    edit(path, `INSERT INTO _iris_migrations (id, writer_version, compat_floor) VALUES ('099-additive', '0.21.0', '0.1.0')`);
    expect(probeDatabaseSchema(path).detail).toBe(`up to date (schema ${N} of ${N}, with 099-additive from Iris 0.21.0, which this version can use); Iris 0.20.0 and later can open it`);
  });
});

describe('the self-test reads the clients that share it', () => {
  const plan = (floor: string, floorAfter = floor) => ({ floor, floorAfter }) as MigrationPlan;

  it('with no client running Iris, there is nothing to check', () => {
    expect(probeClientPins(plan('0.20.0'), e)).toBe('no MCP client config on this machine runs Iris');
  });

  it('fails on a client pinned below the file’s floor, naming the command', async () => {
    await runInstall(['cursor'], { ...quiet, environment: e, version: '0.19.0' });
    await runInstall(['gemini'], { ...quiet, environment: e, version: '0.20.0' });
    expect(() => probeClientPins(plan('0.20.0'), e)).toThrow(
      `Cursor (Iris 0.19.0) cannot open this database and will refuse to start. Move every client to this version: npx -y @iris-eval/mcp-server@${PKG_VERSION} install --upgrade`,
    );
  });

  it('warns, without failing, about a client the next start will strand, and lists the rest', async () => {
    await runInstall(['cursor'], { ...quiet, environment: e, version: '0.19.0' });
    expect(probeClientPins(plan('0.16.0', '0.20.0'), e)).toBe(
      `cursor 0.19.0; Cursor (Iris 0.19.0) will not open it once this version upgrades it — move every client first: npx -y @iris-eval/mcp-server@${PKG_VERSION} install --upgrade`,
    );
    expect(probeClientPins(null, e)).toBe('cursor 0.19.0');
  });
});
