/*
 * Migration 012 — datasets.
 *
 * The schema it adds, applied once on a cold file beside 001–011 and
 * idempotent on re-open; the storage methods the routes and the CLI
 * gate read through; labels unique per tenant; the expected answer
 * carried as JSON and read back as the value it was.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter, DatasetExistsError } from '../../../src/storage/sqlite-adapter.js';
import { KNOWN_MIGRATION_IDS } from '../../../src/storage/migrations/index.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-mig012-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
}

describe('migration 012 — the schema it adds', () => {
  it('is the twelfth known migration', () => {
    // The newest migration's test owns the count; this one owns the position.
    expect(KNOWN_MIGRATION_IDS[11]).toBe('012-datasets');
    expect(KNOWN_MIGRATION_IDS[10]).toBe('011-verdict-labels');
  });

  it('creates datasets and dataset_cases on a cold file beside 001–011, once, and re-opens unchanged', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    await store.close();
    const db = new Database(path, { readonly: true });
    const datasets = (db.prepare('PRAGMA table_info(datasets)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(datasets).toEqual(['id', 'tenant_id', 'label', 'version', 'created_at']);
    const cases = (db.prepare('PRAGMA table_info(dataset_cases)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cases).toEqual(['dataset_id', 'case_key', 'expected_json']);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toContain('idx_datasets_tenant_label');
    const applied = (db.prepare('SELECT id FROM _iris_migrations ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
    expect(applied).toEqual([...KNOWN_MIGRATION_IDS]);
    expect(applied.filter((id) => id === '012-datasets')).toHaveLength(1);
    db.close();
    const again = new SqliteAdapter(path);
    await again.initialize();
    expect((await again.migrations()).pending).toEqual([]);
    expect(await again.listDatasets(LOCAL_TENANT)).toEqual([]);
    await again.close();
  });
});

describe('datasets — the storage methods', () => {
  it('creates a dataset from cases, reads it by id and by label, lists it with its count, and round-trips the expected answer', async () => {
    const store = new SqliteAdapter(':memory:');
    await store.initialize();
    try {
      const created = await store.createDataset(LOCAL_TENANT, {
        label: 'release-gate',
        cases: [
          { caseKey: 'refund-policy', expected: null },
          { caseKey: 'vat-rate', expected: { answer: '20%', tolerance: 0 } },
        ],
      });
      expect(created.id).toMatch(/^ds_[0-9a-f]{16}$/);
      expect(created.label).toBe('release-gate');
      expect(created.version).toBe(1);
      expect(created.cases).toBe(2);
      expect(created.caseKeys).toEqual([
        { caseKey: 'refund-policy', expected: null },
        { caseKey: 'vat-rate', expected: { answer: '20%', tolerance: 0 } },
      ]);
      expect((await store.getDataset(LOCAL_TENANT, created.id))?.label).toBe('release-gate');
      expect((await store.getDataset(LOCAL_TENANT, 'release-gate'))?.id).toBe(created.id);
      expect(await store.getDataset(LOCAL_TENANT, 'nope')).toBeNull();
      const listed = await store.listDatasets(LOCAL_TENANT);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: created.id, label: 'release-gate', version: 1, cases: 2 });
      expect(listed[0]).not.toHaveProperty('caseKeys');
    } finally {
      await store.close();
    }
  });

  it('a label is unique: the second create is refused with the 409 sentence, and the first is untouched', async () => {
    const store = new SqliteAdapter(':memory:');
    await store.initialize();
    try {
      await store.createDataset(LOCAL_TENANT, { label: 'gate', cases: [{ caseKey: 'a', expected: null }] });
      await expect(store.createDataset(LOCAL_TENANT, { label: 'gate', cases: [{ caseKey: 'b', expected: null }] })).rejects.toBeInstanceOf(DatasetExistsError);
      await expect(store.createDataset(LOCAL_TENANT, { label: 'gate', cases: [] })).rejects.toThrow(/A dataset labelled "gate" already exists/);
      expect((await store.getDataset(LOCAL_TENANT, 'gate'))?.caseKeys.map((c) => c.caseKey)).toEqual(['a']);
    } finally {
      await store.close();
    }
  });

  it('caseKeysInRun is the distinct keys the run’s traces carry — supplied or derived — and nothing from another run', async () => {
    const store = new SqliteAdapter(':memory:');
    await store.initialize();
    try {
      const trace = (id: string, run: string, caseKey?: string, input = `ask ${id}`) => ({
        trace_id: id,
        agent_name: 'a',
        input,
        output: 'o',
        timestamp: '2026-09-01T10:00:00Z',
        run_id: run,
        ...(caseKey ? { case_key: caseKey } : {}),
      });
      await store.insertTrace(LOCAL_TENANT, trace('t1', 'nightly-1', 'refund-policy'));
      await store.insertTrace(LOCAL_TENANT, trace('t2', 'nightly-1', 'refund-policy'));
      await store.insertTrace(LOCAL_TENANT, trace('t3', 'nightly-1', undefined, 'What is the VAT rate?'));
      await store.insertTrace(LOCAL_TENANT, trace('t4', 'nightly-2', 'elsewhere'));
      const keys = await store.caseKeysInRun(LOCAL_TENANT, 'nightly-1');
      expect(keys).toHaveLength(2);
      expect(keys).toContain('refund-policy');
      expect(keys.some((k) => /^[0-9a-f]{16}$/.test(k))).toBe(true); // the derived key of t3
      expect(await store.caseKeysInRun(LOCAL_TENANT, 'nightly-3')).toEqual([]);
    } finally {
      await store.close();
    }
  });
});
