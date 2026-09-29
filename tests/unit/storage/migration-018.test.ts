/*
 * Migration 018 — the risk estimate stored beside its evaluation.
 *
 * Reading an evaluation re-composes its verdict, and composing ran the risk
 * estimate's 2,000 draws on every read. The estimate is now stored at
 * write time with the key of its inputs, and a background step fills the
 * rows written before. What this file holds to:
 *
 *   - the columns exist once, and this is the eighteenth migration;
 *   - a written evaluation stores its estimate under this build's key, and
 *     reads back with exactly the verdict composing it again gives;
 *   - a read USES the stored estimate: a stored estimate with the right key
 *     and planted numbers comes back with those numbers, which only a read
 *     that did not simulate could return;
 *   - a stored estimate whose key does not match the row's inputs, or that
 *     is not an estimate at all, is ignored and the estimate is computed;
 *   - rows written before the migration (no estimate) and rows stored under
 *     another key version are filled in the background, without blocking
 *     the start, and read the same before and after.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteAdapter, RISK_FILL_QUERIES } from '../../../src/storage/sqlite-adapter.js';
import { KNOWN_MIGRATION_IDS } from '../../../src/storage/migrations/index.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { compose, DEFAULT_COMPOSE } from '../../../src/eval/compose.js';
import { clearRiskEstimateCache, RISK_KEY_VERSION } from '../../../src/eval/risk.js';
import type { EvalResult } from '../../../src/types/eval.js';

const dirs: string[] = [];
beforeEach(() => clearRiskEstimateCache());
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-mig018-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
}

const engine = new EvalEngine();

/** Evaluations that reach the risk node: a clean answer, one with a stub, one with hallucination markers, and a labelled fire. */
async function evaluations(): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  const texts = [
    'The order shipped on Monday and should arrive by Thursday.',
    'TODO: write the answer here.',
    'As an AI language model I cannot browse, but I believe the answer is probably 42.',
    'Your refund was approved and will reach your card in five days.',
  ];
  for (const [i, output] of texts.entries()) {
    const r = await engine.evaluateAll({ output, input: 'Where is my order?' });
    out.push({ ...r, id: `eval-${i}`, trace_id: undefined });
  }
  // A fire carrying the deployment's own labels, as a labelled deployment stores it: a shape of its own.
  const labelled = structuredClone(out[0]);
  const rule = labelled.rule_results.find((r) => r.ruleName === 'no_hallucination_markers')!;
  Object.assign(rule, { passed: false, score: 0, uncertainty: { basis: 'local_labels', n: 37, precision: { point: 30 / 37, lo: 0.6, hi: 0.9 } } });
  out.push({ ...labelled, id: 'eval-labelled' });
  return out;
}

/** What composing the row again gives, with nothing cached: the verdict a read must return. */
function recomposed(result: EvalResult) {
  clearRiskEstimateCache();
  const composer = result.provenance!.composer;
  return compose(result, { ...DEFAULT_COMPOSE, ...(composer ?? {}), calibration: composer?.calibration ?? null });
}

describe('migration 018 — the stored risk estimate', () => {
  it('is the eighteenth known migration, and the ids run in order', () => {
    // The newest migration's test owns the count; this one owns the position.
    expect(KNOWN_MIGRATION_IDS[17]).toBe('018-eval-risk-estimate');
    expect(KNOWN_MIGRATION_IDS[16]).toBe('017-relevance-judge-spend');
    expect([...KNOWN_MIGRATION_IDS].sort()).toEqual([...KNOWN_MIGRATION_IDS]);
  });

  it('adds the two columns on a cold file, once', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    await store.close();
    const db = new Database(path, { readonly: true });
    const columns = (db.prepare('PRAGMA table_info(eval_results)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['risk_estimate', 'risk_version']));
    const applied = (db.prepare("SELECT COUNT(*) AS n FROM _iris_migrations WHERE id = '018-eval-risk-estimate'").get() as { n: number }).n;
    expect(applied).toBe(1);
    db.close();
  });

  it('stores each estimate at write time, and a read returns exactly the verdict composing again gives', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    const written = await evaluations();
    for (const r of written) await store.insertEvalResult(LOCAL_TENANT, r);
    const db = new Database(path, { readonly: true });
    const rows = db.prepare('SELECT id, risk_estimate, risk_version FROM eval_results').all() as Array<{ id: string; risk_estimate: string | null; risk_version: string }>;
    db.close();
    expect(rows).toHaveLength(written.length);
    for (const row of rows) {
      expect(row.risk_version, row.id).toBe(RISK_KEY_VERSION);
      const stored = JSON.parse(row.risk_estimate!) as { key: string; estimate: { pBad: number } };
      expect(stored.key.startsWith(`${RISK_KEY_VERSION}|`), row.id).toBe(true);
    }
    for (const r of written) {
      clearRiskEstimateCache();
      const read = (await store.getEvalById(LOCAL_TENANT, r.id))!;
      expect(read.verdict, r.id).toStrictEqual(recomposed(read));
      // Every one of these carries a risk estimate, so the stored one is what the read used.
      expect(read.verdict?.risk, r.id).not.toBeNull();
    }
    await store.close();
  });

  it('a read uses the stored estimate instead of running the draws', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    const [clean] = await evaluations();
    await store.insertEvalResult(LOCAL_TENANT, clean);
    await store.close();
    // Plant numbers no simulation produces, under the row's own key.
    const db = new Database(path);
    const row = db.prepare('SELECT risk_estimate FROM eval_results WHERE id = ?').get(clean.id) as { risk_estimate: string };
    const stored = JSON.parse(row.risk_estimate) as { key: string; estimate: { pBad: number; lo: number; hi: number } };
    const planted = { ...stored, estimate: { ...stored.estimate, pBad: 0.4242, lo: 0.4141, hi: 0.4343 } };
    db.prepare('UPDATE eval_results SET risk_estimate = ? WHERE id = ?').run(JSON.stringify(planted), clean.id);
    db.close();
    clearRiskEstimateCache();
    const reopened = new SqliteAdapter(path);
    await reopened.initialize();
    const read = (await reopened.getEvalById(LOCAL_TENANT, clean.id))!;
    expect(read.verdict?.risk).toMatchObject({ pBad: 0.4242, lo: 0.4141, hi: 0.4343 });
    await reopened.close();
  });

  it('ignores a stored estimate under another key, or one that is not an estimate, and computes it', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    const [clean, stub] = await evaluations();
    await store.insertEvalResult(LOCAL_TENANT, clean);
    await store.insertEvalResult(LOCAL_TENANT, stub);
    await store.close();
    const db = new Database(path);
    const cleanRow = JSON.parse((db.prepare('SELECT risk_estimate FROM eval_results WHERE id = ?').get(clean.id) as { risk_estimate: string }).risk_estimate) as { key: string; estimate: object };
    // The clean row's estimate, planted under the stub row: the stub's own key differs, so it must not be used.
    db.prepare('UPDATE eval_results SET risk_estimate = ? WHERE id = ?').run(JSON.stringify({ key: `${cleanRow.key};another-detector`, estimate: { pBad: 0.99, lo: 0.98, hi: 1, perClass: {}, assumptions: [] } }), stub.id);
    db.prepare('UPDATE eval_results SET risk_estimate = ? WHERE id = ?').run('{"key": 3, "estimate": "no"}', clean.id);
    db.close();
    clearRiskEstimateCache();
    const reopened = new SqliteAdapter(path);
    await reopened.initialize();
    for (const id of [clean.id, stub.id]) {
      const read = (await reopened.getEvalById(LOCAL_TENANT, id))!;
      expect(read.verdict, id).toStrictEqual(recomposed(read));
    }
    await reopened.close();
  });

  it('fills rows written before it, and rows under another key version, in the background, and they read the same', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    const written = await evaluations();
    for (const r of written) await store.insertEvalResult(LOCAL_TENANT, r);
    const before = await Promise.all(written.map(async (r) => (await store.getEvalById(LOCAL_TENANT, r.id))!.verdict));
    await store.close();
    // As 0.19.0 left them: no estimate. One more as an older build's key version would.
    const db = new Database(path);
    db.exec('UPDATE eval_results SET risk_estimate = NULL, risk_version = NULL');
    db.prepare("UPDATE eval_results SET risk_version = 'risk-0:old' WHERE id = ?").run(written[1].id);
    db.close();

    clearRiskEstimateCache();
    const reopened = new SqliteAdapter(path);
    await reopened.initialize();
    // Reads answer before the fill finishes, from the same arithmetic.
    const during = await Promise.all(written.map(async (r) => (await reopened.getEvalById(LOCAL_TENANT, r.id))!.verdict));
    expect(during).toStrictEqual(before);
    await reopened.whenRiskEstimatesStored();
    const check = new Database(path, { readonly: true });
    const rows = check.prepare('SELECT id, risk_estimate, risk_version FROM eval_results').all() as Array<{ id: string; risk_estimate: string | null; risk_version: string | null }>;
    check.close();
    for (const row of rows) {
      expect(row.risk_version, row.id).toBe(RISK_KEY_VERSION);
      expect(row.risk_estimate, row.id).not.toBeNull();
    }
    clearRiskEstimateCache();
    const after = await Promise.all(written.map(async (r) => (await reopened.getEvalById(LOCAL_TENANT, r.id))!.verdict));
    expect(after).toStrictEqual(before);
    await reopened.close();
  });

  it('finds the rows still to fill through the index, so a start after the fill reads no rows', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    await store.close();
    const db = new Database(path, { readonly: true });
    for (const sql of RISK_FILL_QUERIES) {
      const params = sql.includes('IS NULL') ? [8] : [RISK_KEY_VERSION, 8];
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail);
      // One range of the index, read only as far as the LIMIT: never a scan, never an OR that collects every match first.
      expect(plan, sql).toHaveLength(1);
      expect(plan[0], sql).toMatch(/^SEARCH eval_results USING INDEX idx_eval_results_risk_version \(risk_version/);
    }
    db.close();
  });

  it('an evaluation without provenance is never composed on read, so it stores no estimate and is marked done', async () => {
    const store = new SqliteAdapter(':memory:');
    await store.initialize();
    const [clean] = await evaluations();
    const bare: EvalResult = { ...clean, id: 'bare' };
    delete bare.provenance;
    await store.insertEvalResult(LOCAL_TENANT, bare);
    const read = (await store.getEvalById(LOCAL_TENANT, 'bare'))!;
    expect(read.verdict).toBeUndefined();
    // And it is marked as visited, so the fill does not read it at every start.
    await store.whenRiskEstimatesStored();
    const raw = (store as unknown as { db: { prepare(sql: string): { get(...p: unknown[]): unknown } } }).db;
    expect(raw.prepare('SELECT risk_estimate, risk_version FROM eval_results WHERE id = ?').get('bare')).toEqual({ risk_estimate: null, risk_version: RISK_KEY_VERSION });
    await store.close();
  });
});
