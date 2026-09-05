/*
 * Migration 007 — provenance persisted, the rest derived on read, and a
 * downgrade that refuses instead of reading half a schema.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { PKG_VERSION } from '../../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-mig007-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
}

describe('migration 007 — provenance', () => {
  it('a new evaluation stores its provenance and reads back with verdict, coverage and critical_skipped derived', async () => {
    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds);
    const traceId = await storage.insertTrace(LOCAL_TENANT, { trace_id: 'a'.repeat(32), agent_name: 't', input: 'q', output: 'o', timestamp: new Date().toISOString() } as never);
    const result = engine.evaluateAll({ output: 'The sweep runs at boot. It removes old traces. That is all.', input: 'What does the sweep do?' });
    result.trace_id = typeof traceId === 'string' ? traceId : 'a'.repeat(32);
    await storage.insertEvalResult(LOCAL_TENANT, result);
    const [stored] = await storage.getEvalsByTraceId(LOCAL_TENANT, result.trace_id);
    expect(stored.provenance).toEqual(result.provenance);
    expect(stored.verdict).toEqual(result.verdict);
    expect(stored.coverage?.questions).toEqual(result.coverage?.questions);
    expect(stored.critical_skipped).toBeUndefined(); // nothing critical skipped on this call
    await storage.close();
  });

  it('a row written before 007 (no provenance) reads back without a verdict — absent, never fabricated', async () => {
    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const db = (storage as unknown as { db: Database.Database }).db;
    db.prepare(
      `INSERT INTO eval_results (tenant_id, id, trace_id, eval_type, output_text, expected_text, score, passed, rule_results, suggestions, rules_evaluated, rules_skipped, insufficient_data, critical_failures, created_at)
       VALUES (?, ?, NULL, 'safety', 'old', NULL, 0.9, 1, ?, '[]', 5, 1, 0, NULL, ?)`,
    ).run(LOCAL_TENANT, 'e'.repeat(32), JSON.stringify([
      { ruleName: 'no_pii', passed: true, score: 1, message: 'No PII detected', critical: true, criticalSource: 'default' },
      { ruleName: 'no_blocklist_words', passed: false, score: 0, message: 'x', critical: true, criticalSource: 'default', skipped: true, skipReason: 'budget', budgetExceeded: true },
    ]), new Date().toISOString());
    const { results } = await storage.queryEvalResults(LOCAL_TENANT, {});
    const old = results.find((r) => r.id === 'e'.repeat(32))!;
    expect(old.provenance).toBeUndefined();
    expect(old.verdict).toBeUndefined();
    expect(old.coverage).toBeUndefined(); // no question stamps on those rows
    expect(old.critical_skipped).toEqual(['no_blocklist_words']); // derivable from the stamped flags, so it is
    await storage.close();
  });

  it('the migration ledger records the writer version, and a newer ledger refuses this binary', async () => {
    const path = tempDb();
    const storage = new SqliteAdapter(path);
    await storage.initialize();
    await storage.close();
    const db = new Database(path);
    const rows = db.prepare('SELECT id, writer_version FROM _iris_migrations ORDER BY id').all() as Array<{ id: string; writer_version: string | null }>;
    expect(rows.map((r) => r.id)).toContain('007-eval-provenance');
    expect(rows.every((r) => r.writer_version === PKG_VERSION)).toBe(true);
    db.prepare("INSERT INTO _iris_migrations (id, writer_version) VALUES ('999-from-the-future', '99.0.0')").run();
    db.close();
    const downgraded = new SqliteAdapter(path);
    await expect(downgraded.initialize()).rejects.toThrow(/newer Iris \(99\.0\.0\).*999-from-the-future.*Upgrade Iris/);
  });
});
