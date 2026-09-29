/*
 * The database's upgrade path through the real entry point (#704): a start
 * refused because a newer release migrated the file says so plain, not only
 * inside the structured log record, and changes nothing; `--purge` deletes
 * the copies taken before an upgrade along with the traces.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { backupPath } from '../../src/storage/backup.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const entryPoint = join(repoRoot, 'src', 'index.ts');
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'iris-refused-db-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function start(...args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entryPoint, ...args], {
      cwd: repoRoot,
      env: { ...process.env, IRIS_HOME: home, IRIS_DB_PATH: join(home, 'iris.db'), IRIS_NO_AUTO_LAUNCH: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.once('error', rejectPromise);
    child.once('close', (code) => resolvePromise({ code, stderr }));
  });
}

describe('a database a newer release migrated past this version', () => {
  it('refuses the start with the sentence on its own line, and leaves the file as it was', async () => {
    const path = join(home, 'iris.db');
    const s = new SqliteAdapter(path);
    await s.initialize();
    await s.close();
    const db = new Database(path);
    db.prepare("INSERT INTO _iris_migrations (id, writer_version, compat_floor) VALUES ('099-future', '99.0.0', '99.0.0')").run();
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    const before = createHash('sha256').update(readFileSync(path)).digest('hex');

    const { code, stderr } = await start();
    expect(code).toBe(1);
    const plain = stderr.split('\n').find((l) => l.startsWith('iris-eval: This database was migrated by a newer Iris (99.0.0)'));
    expect(plain, stderr).toBeDefined();
    expect(plain).toContain('npx -y @iris-eval/mcp-server@latest install --upgrade');
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(before);
    expect(readdirSync(home).filter((n) => n.endsWith('.bak'))).toEqual([]);
  }, 60_000);
});

describe('--purge', () => {
  it('deletes the copies taken before an upgrade, which hold the same traces, and says so', async () => {
    const path = join(home, 'iris.db');
    const s = new SqliteAdapter(path);
    await s.initialize();
    await s.close();
    const copy = backupPath(path, '0.19.0', '0.20.0', new Date());
    writeFileSync(copy, 'x');
    const { code, stderr } = await start('--purge');
    expect(code, stderr).toBe(0);
    expect(stderr).toContain('1 copy(ies) of it taken before an upgrade deleted');
    expect(existsSync(copy)).toBe(false);
  }, 60_000);
});
