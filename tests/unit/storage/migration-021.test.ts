/*
 * Migration 021 — which of the three states a stored verdict had.
 *
 * `passed` holds two of them, so every count and every list that read the
 * column drew a verdict that was not checked as a failure. What this file
 * holds to:
 *
 *   - the column and its index exist, and this is the last migration;
 *   - a written evaluation stores the state its caller was given, and the
 *     state never contradicts `passed`;
 *   - a run's rows, a run's summary, a case's attempts, the headline
 *     figures and a drift window each say how many verdicts were not
 *     checked, and none of them counts one as a pass;
 *   - a row written before the column reads as it always did until the
 *     background fill reaches it, and exactly afterwards;
 *   - the count of not-checked verdicts reads the index that holds only
 *     those rows.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteAdapter, storedState } from '../../../src/storage/sqlite-adapter.js';
import { KNOWN_MIGRATION_IDS } from '../../../src/storage/migrations/index.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { clearRiskEstimateCache } from '../../../src/eval/risk.js';
import type { EvalResult } from '../../../src/types/eval.js';

const dirs: string[] = [];
beforeEach(() => clearRiskEstimateCache());
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-mig021-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
}

/** A deployment that set a cost ceiling: a call without a cost is then not checked. */
const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, { ...defaultConfig.eval.ruleThresholds, cost_threshold: 0.05 } as never, {
  ...defaultConfig.eval,
  configuredThresholdKeys: ['cost_threshold'],
} as never);

const ASK = 'Summarise the refund policy for the customer in two sentences.';
const ANSWER = 'Refunds are available within 30 days of purchase for unused items. Opened items can be exchanged but not refunded, and the customer was told so.';
const LEAK = 'The reporter is Marisol Quintero, SSN 123-45-6789, and her card was charged twice.';

/** Four traces in one run: a pass, a failure, and two verdicts that were not checked (one for a missing cost, one with nothing to judge). */
async function seed(store: SqliteAdapter): Promise<Record<string, EvalResult>> {
  const cases: Array<[string, Parameters<EvalEngine['evaluateAll']>[0]]> = [
    ['pass', { input: ASK, output: ANSWER, costUsd: 0.01 }],
    ['fail', { input: ASK, output: LEAK, costUsd: 0.01 }],
    ['unsent', { input: ASK, output: ANSWER }],
  ];
  const out: Record<string, EvalResult> = {};
  for (const [i, [name, context]] of cases.entries()) {
    const timestamp = `2026-10-02T10:00:0${i}.000Z`;
    await store.insertTrace(LOCAL_TENANT, { trace_id: `t-${name}`, agent_name: 'a', input: ASK, output: context.output, timestamp, run_id: 'run-1', case_key: `case-${name}` });
    const r = await engine.evaluateAll(context);
    out[name] = { ...r, id: `e-${name}`, trace_id: `t-${name}`, created_at: new Date().toISOString() };
    await store.insertEvalResult(LOCAL_TENANT, out[name]);
  }
  return out;
}

const raw = (store: SqliteAdapter) => (store as unknown as { db: { prepare(sql: string): { all(...p: unknown[]): Array<Record<string, unknown>>; get(...p: unknown[]): Record<string, unknown> } } }).db;

describe('migration 021 — the state of a stored verdict', () => {
  it('is the last known migration, after 020', () => {
    expect(KNOWN_MIGRATION_IDS[KNOWN_MIGRATION_IDS.length - 1]).toBe('021-eval-verdict-state');
    expect(KNOWN_MIGRATION_IDS[KNOWN_MIGRATION_IDS.length - 2]).toBe('020-eval-reference-trace');
  });

  it('adds the column and an index that holds only the rows that were not checked', async () => {
    const store = new SqliteAdapter(':memory:');
    await store.initialize();
    expect(raw(store).prepare('PRAGMA table_info(eval_results)').all().map((c) => c.name)).toContain('verdict_state');
    const index = raw(store).prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_eval_results_not_checked'").all();
    expect(String(index[0]?.sql)).toMatch(/WHERE verdict_state = 'unknown'/);
    await store.close();
  });

  it('stores the state the caller was given, and it never contradicts passed', async () => {
    const store = new SqliteAdapter(':memory:');
    await store.initialize();
    const written = await seed(store);
    expect(written.pass.verdict!.state).toBe('pass');
    expect(written.fail.verdict!.state).toBe('fail');
    expect(written.unsent.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing' });
    const rows = raw(store).prepare('SELECT id, passed, verdict_state FROM eval_results ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'e-fail', passed: 0, verdict_state: 'fail' },
      { id: 'e-pass', passed: 1, verdict_state: 'pass' },
      { id: 'e-unsent', passed: 0, verdict_state: 'unknown' },
    ]);
    // And what a read composes agrees with what was stored.
    for (const row of rows) expect((await store.getEvalById(LOCAL_TENANT, String(row.id)))!.verdict!.state, String(row.id)).toBe(row.verdict_state);
    await store.close();
  });

  it('an evaluation with no verdict to read stores pass only when it passed, and unknown when nothing was judged', async () => {
    const store = new SqliteAdapter(':memory:');
    await store.initialize();
    const bare = (id: string, over: Partial<EvalResult>): EvalResult => ({ id, eval_type: 'all', output_text: 'x', score: 1, passed: true, rule_results: [], ...over }) as EvalResult;
    await store.insertEvalResult(LOCAL_TENANT, bare('b-pass', {}));
    await store.insertEvalResult(LOCAL_TENANT, bare('b-none', { passed: false, insufficient_data: true }));
    await store.insertEvalResult(LOCAL_TENANT, bare('b-fail', { passed: false }));
    expect(raw(store).prepare('SELECT id, verdict_state FROM eval_results ORDER BY id').all()).toEqual([
      { id: 'b-fail', verdict_state: null },
      { id: 'b-none', verdict_state: 'unknown' },
      { id: 'b-pass', verdict_state: 'pass' },
    ]);
    await store.close();
  });

  it('a run, its summary, a case and the headline figures say how many were not checked, and count none as a pass', async () => {
    const store = new SqliteAdapter(':memory:');
    await store.initialize();
    await seed(store);

    const results = await store.getRunResults(LOCAL_TENANT, 'run-1');
    expect(Object.fromEntries(results.map((r) => [r.evalId, [r.passed, r.state]]))).toEqual({ 'e-pass': [true, 'pass'], 'e-fail': [false, 'fail'], 'e-unsent': [false, 'unknown'] });

    const run = (await store.listRuns(LOCAL_TENANT)).find((r) => r.runId === 'run-1')!;
    expect(run).toMatchObject({ evaluated: 3, passed: 1, notChecked: 1 });

    const attempts = await store.getCaseResults(LOCAL_TENANT, { caseKey: 'case-unsent' });
    expect(attempts.map((a) => [a.passed, a.state])).toEqual([[false, 'unknown']]);
    // Narrowed to one question, the answer is that question's own: it was judged, or the row is left out.
    const safe = await store.getCaseResults(LOCAL_TENANT, { caseKey: 'case-fail', question: 'safe_output' });
    expect(safe.map((a) => [a.passed, a.state])).toEqual([[false, 'fail']]);

    const stats = await store.getEvalStats(LOCAL_TENANT, '24h');
    expect(stats).toMatchObject({ totalEvals: 3, passed: 1, notChecked: 1 });
    // The rate keeps every evaluation in its denominator: leaving out what a check reads must not raise it.
    expect(stats.passRate).toBeCloseTo(1 / 3, 3);

    const window = await store.getDriftWindow(LOCAL_TENANT, '2020-01-01T00:00:00.000Z', null, 'run-1');
    expect(window).toMatchObject({ evaluated: 3, passed: 1, notChecked: 1 });
    expect((await store.getDashboardSummary(LOCAL_TENANT, 24)).eval_not_checked).toBe(1);
    await store.close();
  });

  it('a row from before the column reads as it did until the fill reaches it, and exactly afterwards', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    await seed(store);
    await store.close();
    // As 0.19.0 left them: no state and no risk estimate.
    const db = new Database(path);
    db.exec('UPDATE eval_results SET verdict_state = NULL, risk_estimate = NULL, risk_version = NULL');
    const before = db.prepare('SELECT id, passed, verdict_state, insufficient_data FROM eval_results ORDER BY id').all() as Array<Record<string, unknown>>;
    db.close();
    // Unfilled, a row is counted as it always was: it passed, or it did not.
    expect(before.map((r) => storedState(r))).toEqual(['fail', 'pass', 'fail']);

    clearRiskEstimateCache();
    const reopened = new SqliteAdapter(path);
    await reopened.initialize();
    await reopened.whenRiskEstimatesStored();
    const filled = raw(reopened).prepare('SELECT id, verdict_state FROM eval_results ORDER BY id').all();
    expect(filled).toEqual([
      { id: 'e-fail', verdict_state: 'fail' },
      { id: 'e-pass', verdict_state: 'pass' },
      { id: 'e-unsent', verdict_state: 'unknown' },
    ]);
    expect((await reopened.listRuns(LOCAL_TENANT)).find((r) => r.runId === 'run-1')).toMatchObject({ evaluated: 3, passed: 1, notChecked: 1 });
    await reopened.close();
  });

  it('storedState: pass exactly when the row passed, whatever the column says', () => {
    expect(storedState({ passed: 1, verdict_state: 'unknown' })).toBe('pass');
    expect(storedState({ passed: 0, verdict_state: 'pass' })).toBe('fail');
    expect(storedState({ passed: 0, verdict_state: 'unknown' })).toBe('unknown');
    expect(storedState({ passed: 0, verdict_state: null })).toBe('fail');
  });

  it('counts the not-checked verdicts of a window from the index that holds only them', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    await seed(store);
    await store.close();
    const db = new Database(path, { readonly: true });
    const plan = (
      db
        .prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM eval_results INDEXED BY idx_eval_results_not_checked WHERE tenant_id = ? AND created_at >= ? AND verdict_state = 'unknown'")
        .all(LOCAL_TENANT, '2020-01-01T00:00:00.000Z') as Array<{ detail: string }>
    ).map((r) => r.detail);
    db.close();
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatch(/^SEARCH eval_results USING COVERING INDEX idx_eval_results_not_checked \(tenant_id=\? AND created_at>\?\)/);
  });
});
