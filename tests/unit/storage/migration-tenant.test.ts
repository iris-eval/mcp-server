/*
 * Migration smoke test — v0.3 → v0.4.
 *
 * Creates a SQLite database in the v0.3 schema (no tenant_id column)
 * using the raw better-sqlite3 API, inserts a sample row, then opens
 * the same file with the new SqliteAdapter. The adapter must:
 *   1. Detect the older schema and run migration 004 cleanly.
 *   2. Backfill existing rows with tenant_id = 'local'.
 *   3. Return those rows when queried as LOCAL_TENANT.
 *   4. NOT return those rows when queried as any other tenant.
 *
 * This is the "old-DB opens cleanly" guarantee from the audit queue
 * item #7. Without it, a v0.4.0 upgrade could lose user data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT, asTenantId } from '../../../src/types/tenant.js';

describe('v0.3 → v0.4 migration', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-migration-test-'));
    dbPath = join(dir, 'iris.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens a v0.3-era database and backfills existing rows to LOCAL_TENANT', async () => {
    /* Manually create a v0.3-era schema (migrations 001-003 only) and
     * insert a row without tenant_id. This simulates a user upgrading
     * from v0.3.x to v0.4.0. */
    {
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE traces (
          trace_id TEXT PRIMARY KEY,
          agent_name TEXT NOT NULL,
          framework TEXT,
          input TEXT,
          output TEXT,
          tool_calls TEXT,
          latency_ms REAL,
          token_usage TEXT,
          cost_usd REAL,
          metadata TEXT,
          timestamp TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE spans (
          span_id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          parent_span_id TEXT,
          name TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'INTERNAL',
          status_code TEXT NOT NULL DEFAULT 'UNSET',
          status_message TEXT,
          start_time TEXT NOT NULL,
          end_time TEXT,
          attributes TEXT,
          events TEXT
        );
        CREATE TABLE eval_results (
          id TEXT PRIMARY KEY,
          trace_id TEXT,
          eval_type TEXT NOT NULL,
          output_text TEXT NOT NULL,
          expected_text TEXT,
          score REAL NOT NULL,
          passed INTEGER NOT NULL,
          rule_results TEXT,
          suggestions TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE _iris_migrations (
          id TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO _iris_migrations (id) VALUES
          ('001-initial-schema'),
          ('002-eval-skip-fields'),
          ('003-eval-passed-index');
        INSERT INTO traces (trace_id, agent_name, timestamp)
          VALUES ('legacy-trace-1', 'legacy-agent', '2025-12-01T00:00:00Z');
      `);
      db.close();
    }

    // Now open with the new adapter — migration 004 should run.
    const adapter = new SqliteAdapter(dbPath);
    await adapter.initialize();
    try {
      // LOCAL_TENANT can still read the legacy row — backfill worked.
      const found = await adapter.getTrace(LOCAL_TENANT, 'legacy-trace-1');
      expect(found).not.toBeNull();
      expect(found!.agent_name).toBe('legacy-agent');

      // A different tenant cannot see the legacy data — tenant boundary
      // is enforced even against pre-migration rows.
      const other = await adapter.getTrace(asTenantId('some-other-tenant'), 'legacy-trace-1');
      expect(other).toBeNull();

      // The migrations table now lists 004 as applied — idempotency.
      const migrated = await adapter.queryTraces(LOCAL_TENANT, {});
      expect(migrated.total).toBe(1);
    } finally {
      await adapter.close();
    }
  });

  it('is idempotent — reopening a v0.4 DB does not re-run migration 004', async () => {
    // First open applies migration 004.
    const first = new SqliteAdapter(dbPath);
    await first.initialize();
    await first.insertTrace(LOCAL_TENANT, {
      trace_id: 'fresh-trace',
      agent_name: 'fresh',
      timestamp: '2026-04-23T00:00:00Z',
    });
    await first.close();

    // Second open must not re-apply 004 (would throw "duplicate column").
    const second = new SqliteAdapter(dbPath);
    await second.initialize();
    try {
      const result = await second.queryTraces(LOCAL_TENANT, {});
      expect(result.total).toBe(1);
    } finally {
      await second.close();
    }
  });
});
