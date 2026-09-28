/*
 * Migration 016 — where a trace's cost came from (#702).
 *
 * The upgrade is proven on a database the 0.19.0 release wrote itself:
 * tests/fixtures/db/iris-0.19.0.db was made by the v0.19.0 tag's own
 * SqliteAdapter and OTLP mapper (migrations 001–014, writer_version 0.19.0),
 * holding three traces — one that reported a cost, one sent over OTLP with
 * gpt-4o-mini tokens and no cost, and one with neither. A copy is opened by
 * this build on both SQLite drivers.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { KNOWN_MIGRATION_IDS } from '../../../src/storage/migrations/index.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const FIXTURE = resolve(__dirname, '..', '..', 'fixtures', 'db', 'iris-0.19.0.db');
const REPORTED = '0190a000000000000000000000000001';
const OTEL_NO_COST = '0190a000000000000000000000000002';
const PLAIN = '0190a000000000000000000000000003';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function copyOf019(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-mig016-'));
  dirs.push(dir);
  const path = join(dir, 'iris.db');
  copyFileSync(FIXTURE, path);
  return path;
}

describe('migration 016 — the trace cost source', () => {
  it('is the sixteenth known migration, and the last', () => {
    expect(KNOWN_MIGRATION_IDS).toHaveLength(16);
    expect(KNOWN_MIGRATION_IDS[15]).toBe('016-trace-cost-source');
    expect(KNOWN_MIGRATION_IDS[14]).toBe('015-trace-search');
  });

  it('the fixture is what 0.19.0 wrote: migrations 001–014, no cost_source column', () => {
    const db = new Database(FIXTURE, { readonly: true });
    try {
      const applied = db.prepare('SELECT id, writer_version FROM _iris_migrations ORDER BY id').all() as Array<{ id: string; writer_version: string }>;
      expect(applied.map((r) => r.id)).toEqual(KNOWN_MIGRATION_IDS.slice(0, 14));
      expect(new Set(applied.map((r) => r.writer_version))).toEqual(new Set(['0.19.0']));
      const columns = (db.prepare('PRAGMA table_info(traces)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns).not.toContain('cost_source');
      expect(columns).not.toContain('cost_estimate');
      const costs = db.prepare('SELECT trace_id, cost_usd FROM traces ORDER BY trace_id').all();
      expect(costs).toEqual([
        { trace_id: REPORTED, cost_usd: 0.0123 },
        { trace_id: OTEL_NO_COST, cost_usd: null },
        { trace_id: PLAIN, cost_usd: null },
      ]);
    } finally {
      db.close();
    }
  });

  for (const driver of ['native', 'node'] as const) {
    it(`[${driver}] upgrades a 0.19.0 database without rewriting it: the reported cost reads as reported and is kept, past traces without one stay without one, and new traces are priced`, async () => {
      const path = copyOf019();
      const store = new SqliteAdapter(path, { driver });
      await store.initialize();
      try {
        expect(await store.migrations()).toEqual({ applied: KNOWN_MIGRATION_IDS.length, known: KNOWN_MIGRATION_IDS.length, pending: [] });

        const reported = await store.getTrace(LOCAL_TENANT, REPORTED);
        expect(reported).toMatchObject({ cost_usd: 0.0123, cost_source: 'reported' });
        expect(reported?.cost_estimate).toBeUndefined();

        // Not back-filled: an estimate at the table of the upgrade day would move the totals of past periods.
        for (const id of [OTEL_NO_COST, PLAIN]) {
          const t = await store.getTrace(LOCAL_TENANT, id);
          expect(t?.cost_usd ?? null).toBeNull();
          expect(t?.cost_source).toBeUndefined();
          expect(t?.cost_estimate).toBeUndefined();
        }
        expect((await store.getDashboardSummary(LOCAL_TENANT, 24 * 365 * 10)).total_cost_usd).toBe(0.0123);

        // The same trace as the fixture's OTLP one, sent after the upgrade, is priced.
        await store.insertTrace(LOCAL_TENANT, {
          trace_id: 'after-upgrade',
          agent_name: 'otel-bot',
          token_usage: { prompt_tokens: 150_000, completion_tokens: 10_000, total_tokens: 160_000 },
          metadata: { model: 'gpt-4o-mini' },
          timestamp: '2026-09-28T10:00:00.000Z',
        });
        expect(await store.getTrace(LOCAL_TENANT, 'after-upgrade')).toMatchObject({ cost_usd: 0.0285, cost_source: 'estimated', cost_estimate: { status: 'estimated', basis: 'token_usage' } });
      } finally {
        await store.close();
      }

      // Nothing was rewritten: the reported row's source is read, not stored (a rewrite held the start for 2.3 s at 100,000 traces).
      const raw = new Database(path, { readonly: true });
      expect(raw.prepare('SELECT cost_source, cost_estimate FROM traces WHERE trace_id = ?').get(REPORTED)).toEqual({ cost_source: null, cost_estimate: null });
      raw.close();

      // Re-opening applies nothing twice.
      const again = new SqliteAdapter(path, { driver });
      await again.initialize();
      expect((await again.migrations()).pending).toEqual([]);
      await again.close();
      const db = new Database(path, { readonly: true });
      expect((db.prepare("SELECT COUNT(*) AS n FROM _iris_migrations WHERE id = '016-trace-cost-source'").get() as { n: number }).n).toBe(1);
      db.close();
    });
  }

  it('a cold file gets both columns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-mig016-'));
    dirs.push(dir);
    const path = join(dir, 'iris.db');
    const store = new SqliteAdapter(path);
    await store.initialize();
    await store.close();
    const db = new Database(path, { readonly: true });
    const columns = (db.prepare('PRAGMA table_info(traces)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['cost_source', 'cost_estimate']));
    db.close();
  });
});
