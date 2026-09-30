/*
 * The server answers its client before it upgrades the database.
 *
 * The copy taken before a migration and the migrations themselves used to
 * run before the MCP connection opened, so on a large file a stdio client
 * waited for both before `initialize` was answered (5.9 s from 0.19.0 at
 * 100,000 agent-loop traces, on the machine in the changelog). The server
 * now connects first and upgrades after, on the checkpoint worker's
 * connection, and every request waits for it at the gate
 * (src/storage/ready.ts). This starts the real server over stdio on a file
 * the released 0.19.0 wrote, and requires: the transport connected before
 * the upgrade was reported; a tool call sent at once is answered from the
 * upgraded file, with the traces 0.19.0 stored; and the copy holds the file
 * as 0.19.0 left it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { KNOWN_MIGRATION_IDS } from '../../src/storage/migrations/index.js';

const FIXTURE_019 = resolve(import.meta.dirname, '../fixtures/db/iris-0.19.0.db');

describe('the upgrade runs after the transport connects', () => {
  let irisHome: string;
  let dbPath: string;

  beforeAll(() => {
    irisHome = mkdtempSync(join(tmpdir(), 'iris-upgrade-after-connect-'));
    dbPath = join(irisHome, 'iris.db');
    copyFileSync(FIXTURE_019, dbPath);
    const db = new Database(dbPath);
    db.prepare("INSERT INTO traces (tenant_id, trace_id, agent_name, output, timestamp) VALUES ('local', 't-upgrade', 'a', 'walrus tusks', ?)").run(new Date().toISOString());
    db.close();
  });

  afterAll(() => {
    rmSync(irisHome, { recursive: true, force: true });
  });

  it('logs "Stdio transport connected" before the upgrade line, and a tool call sent at once reads the upgraded file', async () => {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', resolve(import.meta.dirname, '../../src/index.ts')],
      env: { ...getDefaultEnvironment(), IRIS_HOME: irisHome, IRIS_DB_PATH: dbPath, IRIS_LOG_LEVEL: 'info' },
      stderr: 'pipe',
    });
    let log = '';
    transport.stderr?.on('data', (b: Buffer) => (log += b.toString('utf8')));
    const client = new Client({ name: 'upgrade-after-connect', version: '0.1.0' });
    try {
      await client.connect(transport);
      const page = await client.callTool({ name: 'get_traces', arguments: { limit: 10 } });
      expect(page.isError, JSON.stringify(page)).toBeFalsy();
      expect(JSON.stringify(page.structuredContent)).toContain('walrus tusks');
      const connected = log.indexOf('Stdio transport connected');
      const upgraded = log.indexOf(`[iris.storage] Upgraded ${dbPath}`);
      expect(connected, log).toBeGreaterThan(-1);
      expect(upgraded, log).toBeGreaterThan(-1);
      expect(connected).toBeLessThan(upgraded);
      expect(log).toContain('Upgrading the database after the start; requests wait for it, at most 30 s each.');
    } finally {
      await client.close();
    }
    const migrated = new Database(dbPath, { readonly: true });
    expect((migrated.prepare('SELECT COUNT(*) AS n FROM _iris_migrations').get() as { n: number }).n).toBe(KNOWN_MIGRATION_IDS.length);
    migrated.close();
    const copies = readdirSync(irisHome).filter((n) => n.startsWith('iris.db.') && n.endsWith('.bak'));
    expect(copies).toHaveLength(1);
    const copy = new Database(join(irisHome, copies[0]), { readonly: true });
    expect((copy.prepare('SELECT COUNT(*) AS n FROM _iris_migrations').get() as { n: number }).n).toBe(14);
    copy.close();
  }, 120_000);
});
