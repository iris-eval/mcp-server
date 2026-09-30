/*
 * The upgrade after the start (sqlite-adapter.ts, upgradeAfterStart;
 * storage/ready.ts): on a file with migrations pending, the server answers
 * its client first, and the copy and the migrations run after, on the
 * checkpoint worker's connection. What this file holds to:
 *
 *   - initialize() returns before the copy and the migrations, and
 *     whenReady() resolves once both are done, the copy first: the copy
 *     holds the file as the older release left it;
 *   - both run on the worker's connection, not the adapter's;
 *   - a request waits at the gate and is answered once the store serves;
 *     one that waits longer than the gate allows is refused with what the
 *     store is doing, retryable; the server's own work waits without a
 *     bound;
 *   - health answers at once while the store is upgraded, and says so;
 *   - an upgrade that fails refuses every request with its reason, and
 *     health says that too;
 *   - an MCP tool call and an HTTP request both wait at the same gate;
 *   - a store closed mid-upgrade leaves a file the next start migrates.
 * Run on this cell's driver, so the CI matrix covers both.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { Checkpointer } from '../../../src/storage/checkpointer.js';
import { storeGate, StoreNotReadyError } from '../../../src/storage/ready.js';
import { KNOWN_MIGRATION_IDS } from '../../../src/storage/migrations/index.js';
import { storeReadyMiddleware } from '../../../src/middleware/store-ready.js';
import { toIrisError } from '../../../src/tools/errors.js';
import { buildHealth } from '../../../src/health.js';
import { createIrisServer } from '../../../src/server.js';
import { createCustomRuleStore } from '../../../src/custom-rule-store.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import { CELL_DRIVER } from './fts5-here.js';

vi.setConfig({ testTimeout: 30_000 });

const FIXTURE_019 = resolve(import.meta.dirname, '../../fixtures/db/iris-0.19.0.db');
/** The migrations after the ones 0.19.0 knows. */
const AFTER_019 = KNOWN_MIGRATION_IDS.slice(14);

const dirs: string[] = [];
const open: SqliteAdapter[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A file the released 0.19.0 wrote, with one more trace. */
function fileFrom019(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-upgrade-after-start-'));
  dirs.push(dir);
  const path = join(dir, 'iris.db');
  copyFileSync(FIXTURE_019, path);
  const db = new Database(path);
  db.prepare("INSERT INTO traces (tenant_id, trace_id, agent_name, output, timestamp) VALUES ('local', 't-1', 'a', 'walrus tusks', ?)").run(new Date().toISOString());
  db.close();
  return path;
}

async function upgrading(path = fileFrom019()): Promise<{ s: SqliteAdapter; path: string }> {
  // The adapter's upgrade line goes to stderr; quiet it.
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
  const s = new SqliteAdapter(path, { driver: CELL_DRIVER, upgradeAfterStart: true });
  open.push(s);
  await s.initialize();
  return { s, path };
}

const applied = (path: string) => {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare('SELECT id FROM _iris_migrations ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
  } finally {
    db.close();
  }
};

describe('the upgrade after the start', () => {
  it('initialize() returns before the copy and the migrations; whenReady() resolves once they ran, the copy first', async () => {
    const migrate = vi.spyOn(Checkpointer.prototype, 'migrate');
    const { s, path } = await upgrading();
    // Nothing has been copied or migrated yet: the worker has not even started.
    expect(s.readiness().state).not.toBe('ready');
    expect(s.upgradeReport()).toBeUndefined();
    expect(applied(path)).toHaveLength(14);

    await s.whenReady();
    expect(s.readiness().state).toBe('ready');
    expect(applied(path)).toHaveLength(KNOWN_MIGRATION_IDS.length);
    // On the worker's connection.
    expect(migrate).toHaveBeenCalledTimes(1);
    const report = s.upgradeReport()!;
    expect(report.applied).toEqual(AFTER_019);
    expect(report.backup.taken).toBe(true);
    // The copy is the file as 0.19.0 left it: taken before the first migration wrote.
    const copy = (report.backup as { path: string }).path;
    expect(applied(copy)).toHaveLength(14);
    const db = new Database(copy, { readonly: true });
    expect((db.prepare("SELECT output FROM traces WHERE trace_id = 't-1'").get() as { output: string }).output).toBe('walrus tusks');
    db.close();
    // And the store serves what was in the file.
    expect((await s.getTrace(LOCAL_TENANT, 't-1'))?.output).toBe('walrus tusks');
  });

  it('a request waits at the gate and is answered once the store serves; the server’s own work waits through the store', async () => {
    const { s } = await upgrading();
    const gate = storeGate(s);
    expect(gate.open).toBe(false);
    const exported: string[] = [];
    const [trace] = await Promise.all([
      gate.storage.getTrace(LOCAL_TENANT, 't-1'),
      gate.wait(),
      // An export is a stream: it waits before its first batch, and is still a stream.
      (async () => {
        for await (const batch of gate.storage.exportTraces(LOCAL_TENANT, {})) exported.push(...batch.map((r) => r.trace.trace_id));
      })(),
    ]);
    expect(trace?.output).toBe('walrus tusks');
    expect(exported).toContain('t-1');
    expect(gate.open).toBe(true);
    expect(s.readiness().state).toBe('ready');
  });

  it('a request that waits longer than the gate allows is refused with what the store is doing, and may retry', async () => {
    const { s } = await upgrading();
    const gate = storeGate(s, { waitMs: 1 });
    const refused = await gate.wait().catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(StoreNotReadyError);
    expect((refused as Error).message).toMatch(/^Iris is still (opening its database|copying its database before migrating it|applying its database migrations) after an upgrade, and this request waited 0 s for it\./);
    const envelope = toIrisError(refused).envelope;
    expect(envelope).toMatchObject({ code: 'IRIS_STORAGE_ERROR', retryable: true });
    // The same gate lets requests through once the store is done.
    await s.whenReady();
    await expect(gate.wait()).resolves.toBeUndefined();
  });

  it('health answers at once while the store is upgraded, and says what it is doing', async () => {
    const { s } = await upgrading();
    const gate = storeGate(s);
    const { status, body } = await buildHealth({ storage: gate.storage, version: 'test' });
    expect(gate.open).toBe(false);
    expect(status).toBe(503);
    expect(body.upgrade?.state).toMatch(/^(opening|copying|migrating)$/);
    expect(body.checks.storage).toBe('fail');
    expect(body.search).toBeNull();
    // A plain value through the gate, never a promise (it read {} once, the gate having wrapped it).
    expect(body.indexes).toBe('building');
    await s.whenReady();
    const after = await buildHealth({ storage: gate.storage, version: 'test' });
    expect(after.body.upgrade).toBeNull();
    expect(after.body.checks.storage).toBe('ok');
    expect(after.status).toBe(200);
    expect(['ready', 'building']).toContain(after.body.indexes);
  });

  it('an upgrade that fails refuses every request with its reason, and health says so', async () => {
    vi.spyOn(Checkpointer.prototype, 'migrate').mockRejectedValue(new Error('the disk said no'));
    const { s } = await upgrading();
    const gate = storeGate(s);
    await expect(s.whenReady()).rejects.toThrow('the disk said no');
    expect(s.readiness()).toMatchObject({ state: 'failed', detail: 'the disk said no' });
    const refused = await gate.wait().catch((err: unknown) => err);
    expect((refused as Error).message).toBe('Iris could not get its database ready, so it cannot read or store anything: the disk said no');
    expect(toIrisError(refused).envelope).toMatchObject({ code: 'IRIS_STORAGE_ERROR', retryable: false });
    const { status, body } = await buildHealth({ storage: gate.storage, version: 'test' });
    expect(status).toBe(503);
    expect(body.upgrade).toMatchObject({ state: 'failed', reason: 'the disk said no' });
    expect(typeof body.indexes).toBe('string');
  });

  it('an MCP tool call waits at the gate, and is refused with the envelope when it waits too long', async () => {
    const ruleDir = mkdtempSync(join(tmpdir(), 'iris-upgrade-rules-'));
    dirs.push(ruleDir);
    const ruleStore = createCustomRuleStore({ pathFor: () => join(ruleDir, 'custom-rules.json'), auditPath: join(ruleDir, 'audit.log') });
    const call = async (waitMs: number) => {
      const { s } = await upgrading();
      const gate = storeGate(s, { waitMs });
      const { mcpServer } = createIrisServer(defaultConfig, gate.storage, ruleStore, { gate, warn: () => undefined });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await mcpServer.connect(serverTransport);
      const client = new Client({ name: 'upgrade', version: '0.1.0' });
      await client.connect(clientTransport);
      try {
        return await client.callTool({ name: 'get_traces', arguments: { limit: 5 } });
      } finally {
        await client.close();
        await s.whenReady().catch(() => undefined);
      }
    };
    const answered = await call(30_000);
    expect(answered.isError).toBeFalsy();
    expect(JSON.stringify(answered.structuredContent)).toContain('walrus tusks');
    const refused = await call(1);
    expect(refused.isError).toBe(true);
    expect((refused.structuredContent as { error: { code: string; retryable: boolean; message: string } }).error).toMatchObject({ code: 'IRIS_STORAGE_ERROR', retryable: true });
  });

  it('an HTTP request waits at the same gate, and is answered 503 with Retry-After when it waits too long', async () => {
    const serve = async (waitMs: number) => {
      const { s } = await upgrading();
      const gate = storeGate(s, { waitMs });
      const app = express();
      app.use(storeReadyMiddleware(gate));
      app.get('/api/v1/traces/:id', async (req, res) => res.json(await gate.storage.getTrace(LOCAL_TENANT, req.params.id)));
      const server = app.listen(0, '127.0.0.1');
      await new Promise((r) => server.once('listening', r));
      try {
        return await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/traces/t-1`);
      } finally {
        server.close();
        await s.whenReady().catch(() => undefined);
      }
    };
    const answered = await serve(30_000);
    expect(answered.status).toBe(200);
    expect(((await answered.json()) as { output: string }).output).toBe('walrus tusks');
    const refused = await serve(1);
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('5');
    expect(await refused.json()).toMatchObject({ code: 'IRIS_STORAGE_ERROR', retryable: true });
  });

  it('a store closed mid-upgrade leaves a file the next start migrates', async () => {
    const { s, path } = await upgrading();
    await s.close();
    const next = new SqliteAdapter(path, { driver: CELL_DRIVER });
    open.push(next);
    await next.initialize();
    expect(applied(path)).toHaveLength(KNOWN_MIGRATION_IDS.length);
    expect((await next.getTrace(LOCAL_TENANT, 't-1'))?.output).toBe('walrus tusks');
  });
});
