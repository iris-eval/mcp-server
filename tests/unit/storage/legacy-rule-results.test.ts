/*
 * A stored rule result named `rule` instead of `ruleName` (the shape of
 * hand-seeded or externally written rows; no release writes it). A database that still held such a row could not start the
 * server: the local-label refresh at startup sorts rule names, and one
 * undefined name threw. Every reader now goes through parseRuleResults.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SqliteAdapter, parseRuleResults } from '../../../src/storage/sqlite-adapter.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { refreshLocalLabels } from '../../../src/eval/local-labels.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const LEGACY = [
  { rule: 'non_empty_output', category: 'completeness', passed: true, score: 1, weight: 2 },
  { rule: 'no_pii', category: 'safety', passed: false, score: 0, weight: 2 },
];

async function withLegacyRow(): Promise<SqliteAdapter> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const db = (storage as unknown as { db: Database.Database }).db;
  db.prepare(
    `INSERT INTO eval_results (tenant_id, id, trace_id, eval_type, output_text, expected_text, score, passed, rule_results, suggestions, rules_evaluated, rules_skipped, insufficient_data, critical_failures, created_at)
     VALUES (?, ?, NULL, 'comprehensive', 'old output', NULL, 0.5, 0, ?, '[]', 2, 0, 0, NULL, ?)`,
  ).run(LOCAL_TENANT, 'a'.repeat(32), JSON.stringify(LEGACY), new Date().toISOString());
  return storage;
}

describe('stored rule results without a ruleName', () => {
  it('parseRuleResults reads `rule` as `ruleName`, drops nameless entries, and treats a non-list as empty', () => {
    expect(parseRuleResults(JSON.stringify(LEGACY))[0]).toMatchObject({ ruleName: 'non_empty_output', message: '', score: 1 });
    expect(parseRuleResults(JSON.stringify(LEGACY)).map((r) => r.ruleName)).toEqual(['non_empty_output', 'no_pii']);
    expect(parseRuleResults(JSON.stringify([{ passed: true }, { ruleName: 'x', passed: true }])).map((r) => r.ruleName)).toEqual(['x']);
    expect(parseRuleResults('{"not":"a list"}')).toEqual([]);
    expect(parseRuleResults('not json')).toEqual([]);
    expect(parseRuleResults(null)).toEqual([]);
  });

  it('the startup label refresh runs against such a row instead of stopping the server', async () => {
    const storage = await withLegacyRow();
    await expect(refreshLocalLabels(new EvalEngine(), storage, LOCAL_TENANT)).resolves.toBeDefined();
    const stats = await storage.ruleFireStats(LOCAL_TENANT, 100);
    expect(stats.map((s) => s.ruleName)).toEqual(['no_pii', 'non_empty_output']);
    expect(stats.find((s) => s.ruleName === 'no_pii')?.fired).toBe(1);
  });

  it('every reader answers with the rule named', async () => {
    const storage = await withLegacyRow();
    const issues = await storage.listIssues(LOCAL_TENANT, 100);
    expect(issues.map((g) => g.ruleName)).toEqual(['no_pii']);
    const byId = await storage.getEvalById(LOCAL_TENANT, 'a'.repeat(32));
    expect(byId?.rule_results.map((r) => r.ruleName)).toEqual(['non_empty_output', 'no_pii']);
    const rules = await storage.getEvalStatsRules(LOCAL_TENANT, '30d');
    expect(rules.map((r) => r.rule).sort()).toEqual(['no_pii', 'non_empty_output']);
    await expect(storage.getEvalStatsFailures(LOCAL_TENANT, '30d', 10)).resolves.toBeDefined();
    await expect(storage.getDashboardSummary(LOCAL_TENANT, 24)).resolves.toBeDefined();
  });
});
