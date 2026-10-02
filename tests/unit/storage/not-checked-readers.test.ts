/*
 * Every reader of a stored verdict treats "not checked" as neither a pass
 * nor a failure.
 *
 * A verdict that was not checked is stored with passed = 0, so every
 * reader that asked only "did it pass" read it as a failure: a case with
 * one pass and one unreached verdict was "answered both ways", ten
 * unreached verdicts were "a regression", the failures list named a rule
 * that had only skipped, and the count of leaks counted a rule that never
 * ran. Each reader here is given a pass, a failure and a verdict that was
 * not checked, and asked what it says about the third.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteAdapter, storedState } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { clearRiskEstimateCache } from '../../../src/eval/risk.js';
import { compareRuns } from '../../../src/eval/compare.js';
import { deriveMoment } from '../../../src/eval/decision-moment.js';
import { momentsOf } from '../../../src/notify/events.js';
import { WEBHOOK_EVENTS, type WebhookEventName } from '../../../src/notify/event-names.js';
import type { EvalContext, EvalResult } from '../../../src/types/eval.js';

const dirs: string[] = [];
const stores: SqliteAdapter[] = [];
beforeEach(() => clearRiskEstimateCache());
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
async function memory(): Promise<SqliteAdapter> {
  const s = new SqliteAdapter(':memory:');
  await s.initialize();
  stores.push(s);
  return s;
}
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-not-checked-'));
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
const CONTEXTS: Record<'pass' | 'fail' | 'unsent', EvalContext> = {
  pass: { input: ASK, output: ANSWER, costUsd: 0.01 },
  fail: { input: ASK, output: LEAK, costUsd: 0.01 },
  unsent: { input: ASK, output: ANSWER },
};

let seq = 0;
async function put(store: SqliteAdapter, kind: keyof typeof CONTEXTS, at: { run: string; caseKey: string }): Promise<EvalResult> {
  seq += 1;
  const id = `${kind}-${seq}`;
  const timestamp = new Date(Date.now() - 60_000 + seq * 1000).toISOString();
  await store.insertTrace(LOCAL_TENANT, { trace_id: `t-${id}`, agent_name: 'support-bot', input: ASK, output: CONTEXTS[kind].output, timestamp, run_id: at.run, case_key: at.caseKey });
  const r = await engine.evaluateAll(CONTEXTS[kind]);
  const result = { ...r, id: `e-${id}`, trace_id: `t-${id}`, created_at: timestamp };
  await store.insertEvalResult(LOCAL_TENANT, result);
  return result;
}

describe('a case answered both ways is a pass and a failure', () => {
  it('a pass and a verdict that was not checked is not flaky; a pass and a failure is', async () => {
    const store = await memory();
    await put(store, 'pass', { run: 'a', caseKey: 'case-unsent' });
    const unsent = await put(store, 'unsent', { run: 'b', caseKey: 'case-unsent' });
    await put(store, 'pass', { run: 'a', caseKey: 'case-fail' });
    const failed = await put(store, 'fail', { run: 'b', caseKey: 'case-fail' });

    const attempts = async (key: string) => (await store.getCaseResults(LOCAL_TENANT, { caseKey: key })).map((a) => a.state);
    expect(await attempts('case-unsent')).toEqual(['pass', 'unknown']);
    expect(await attempts('case-fail')).toEqual(['pass', 'fail']);

    // The webhook: the first attempt that disagrees with every earlier one.
    const ALL = new Set<WebhookEventName>(WEBHOOK_EVENTS);
    expect((await momentsOf(store, LOCAL_TENANT, unsent, ALL)).map((m) => m.event)).toEqual(['verdict_not_checked']);
    expect((await momentsOf(store, LOCAL_TENANT, failed, ALL)).map((m) => m.event)).toContain('flaky_case');
  });

  it('an earlier attempt that was not checked is no answer either: a first real failure after it is not "both ways"', async () => {
    const store = await memory();
    await put(store, 'unsent', { run: 'a', caseKey: 'case-x' });
    const failed = await put(store, 'fail', { run: 'b', caseKey: 'case-x' });
    expect((await momentsOf(store, LOCAL_TENANT, failed, new Set<WebhookEventName>(['flaky_case']))).map((m) => m.event)).toEqual([]);
  });
});

describe('the lists and counts of failures', () => {
  it('recent failures lists the failure and names the rule that fired, never a rule that skipped', async () => {
    const store = await memory();
    await put(store, 'unsent', { run: 'a', caseKey: 'c1' });
    await put(store, 'fail', { run: 'a', caseKey: 'c2' });
    await put(store, 'pass', { run: 'a', caseKey: 'c3' });
    const failures = await store.getEvalStatsFailures(LOCAL_TENANT, '24h', 10);
    expect(failures).toHaveLength(1);
    expect(failures[0].rule).toBe('no_pii');
  });

  it('the count of leaks does not count a rule that skipped', async () => {
    const store = await memory();
    const skippedPii = { id: 'e-skip', eval_type: 'safety', output_text: 'x', score: 0, passed: false, insufficient_data: true, rule_results: [{ ruleName: 'no_pii', passed: false, score: 0, message: 'skipped', skipped: true }] } as unknown as EvalResult;
    await store.insertEvalResult(LOCAL_TENANT, skippedPii);
    await put(store, 'fail', { run: 'a', caseKey: 'c2' });
    expect((await store.getEvalStats(LOCAL_TENANT, '24h')).safetyViolations.pii).toBe(1);
  });
});

describe('a comparison of two runs', () => {
  it('cases that stopped being checked are counted as not passing, and are not called failures or a regression in the answers', async () => {
    const store = await memory();
    for (let i = 0; i < 10; i += 1) {
      await put(store, 'pass', { run: 'before', caseKey: `case-${i}` });
      await put(store, 'unsent', { run: 'after', caseKey: `case-${i}` });
    }
    const c = compareRuns('before', await store.getRunResults(LOCAL_TENANT, 'before'), 'after', await store.getRunResults(LOCAL_TENANT, 'after'));
    expect(c.after).toMatchObject({ n: 10, passed: 0, notChecked: 10 });
    expect(c.paired).toMatchObject({ b: 10, c: 0, fellNotChecked: 10 });
    // Fewer passed, so the one word a gate reads is still "worse": a run that cannot be checked is not acceptable.
    expect(c.worse).toBe(true);
    expect(c.summary).toContain('passed 0 of 10 (0.0%, 10 not checked)');
    expect(c.summary).toContain('10 cases passed before and did not pass after (10 not checked, 0 failed)');
    expect(c.summary).toContain('None of the cases that fell was judged a failure: every one was not checked in the second run.');
    expect(c.summary).not.toContain('This is a regression');
    expect(c.summary).not.toContain('failed after');
  });

  it('real failures are still called a regression', async () => {
    const store = await memory();
    for (let i = 0; i < 10; i += 1) {
      await put(store, 'pass', { run: 'before', caseKey: `case-${i}` });
      await put(store, 'fail', { run: 'after', caseKey: `case-${i}` });
    }
    const c = compareRuns('before', await store.getRunResults(LOCAL_TENANT, 'before'), 'after', await store.getRunResults(LOCAL_TENANT, 'after'));
    expect(c.paired).toMatchObject({ b: 10, fellNotChecked: 0 });
    expect(c.summary).toContain('10 cases passed before and failed after');
    expect(c.summary).toContain('This is a regression');
  });
});

describe('a Decision Moment', () => {
  const trace = { trace_id: 't', agent_name: 'support-bot', input: ASK, output: ANSWER, timestamp: '2026-10-02T10:00:00.000Z' };
  it('a pass beside a verdict that was not checked is unevaluated: not a pass, and not a failure listed among the failures', async () => {
    const pass = await engine.evaluateAll(CONTEXTS.pass);
    const unsent = await engine.evaluateAll(CONTEXTS.unsent);
    const both = deriveMoment(trace as never, [{ ...pass, id: 'a' }, { ...unsent, id: 'b' }]);
    expect(both.verdict).toBe('unevaluated');
    expect(both.significance.kind).toBe('unevaluated');
    expect(both.significance.reason).toBe('An evaluation was recorded but reached no verdict: nothing was judged, a critical check could not answer, or evidence somebody asked for was not sent. Not checked, which is not a pass.');
    expect(deriveMoment(trace as never, [{ ...pass, id: 'a' }]).verdict).toBe('pass');
    expect(deriveMoment(trace as never, [{ ...unsent, id: 'b' }]).verdict).toBe('unevaluated');
  });
});

describe('rows from before the state was stored', () => {
  it('every count agrees before the background fill, and after it', async () => {
    const path = tempDb();
    const first = new SqliteAdapter(path);
    await first.initialize();
    await put(first, 'pass', { run: 'r', caseKey: 'c1' });
    await put(first, 'fail', { run: 'r', caseKey: 'c2' });
    await put(first, 'unsent', { run: 'r', caseKey: 'c3' });
    await first.close();
    const db = new Database(path);
    db.exec('UPDATE eval_results SET verdict_state = NULL, risk_estimate = NULL, risk_version = NULL');
    db.close();

    // A row with no state is counted as it always was: a failure when it did not pass. Whatever its other columns say.
    expect(storedState({ passed: 0, verdict_state: null })).toBe('fail');
    expect(storedState({ passed: 1, verdict_state: null })).toBe('pass');

    clearRiskEstimateCache();
    const reopened = new SqliteAdapter(path);
    await reopened.initialize();
    stores.push(reopened);
    await reopened.whenRiskEstimatesStored();
    const counts = {
      runs: (await reopened.listRuns(LOCAL_TENANT)).find((r) => r.runId === 'r')!.notChecked,
      stats: (await reopened.getEvalStats(LOCAL_TENANT, '24h')).notChecked,
      drift: (await reopened.getDriftWindow(LOCAL_TENANT, '2020-01-01T00:00:00.000Z', null, 'r')).notChecked,
      summary: (await reopened.getDashboardSummary(LOCAL_TENANT, 24)).eval_not_checked,
    };
    expect(counts).toEqual({ runs: 1, stats: 1, drift: 1, summary: 1 });
  });

  it('a row that did not pass and that this build composes as a pass is left unsettled, not written as a failure', async () => {
    const path = tempDb();
    const first = new SqliteAdapter(path);
    await first.initialize();
    // As 0.19.0 stored a verdict that was not checked for missing required evidence: passed 0, and nothing in the row that says why.
    const r = await new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval).evaluateAll(CONTEXTS.pass);
    const earlier = structuredClone({ ...r, id: 'e-earlier', passed: false }) as EvalResult;
    delete earlier.provenance!.composer!.rules;
    delete earlier.verdict;
    await first.insertEvalResult(LOCAL_TENANT, earlier);
    await first.close();
    const db = new Database(path);
    db.exec('UPDATE eval_results SET verdict_state = NULL, risk_estimate = NULL, risk_version = NULL');
    db.close();

    clearRiskEstimateCache();
    const reopened = new SqliteAdapter(path);
    await reopened.initialize();
    stores.push(reopened);
    await reopened.whenRiskEstimatesStored();
    const check = new Database(path, { readonly: true });
    const row = check.prepare('SELECT passed, verdict_state, risk_version FROM eval_results WHERE id = ?').get('e-earlier') as { passed: number; verdict_state: string | null; risk_version: string | null };
    check.close();
    expect(row.passed).toBe(0);
    expect(row.verdict_state).toBeNull();
    // Visited, so it is not read again at every start.
    expect(row.risk_version).not.toBeNull();
  });

  it('one row that cannot be read does not stop the fill for the rows after it', async () => {
    const path = tempDb();
    const first = new SqliteAdapter(path);
    await first.initialize();
    await put(first, 'pass', { run: 'r', caseKey: 'c1' });
    await put(first, 'unsent', { run: 'r', caseKey: 'c2' });
    await put(first, 'fail', { run: 'r', caseKey: 'c3' });
    await first.close();
    const db = new Database(path);
    db.exec('UPDATE eval_results SET verdict_state = NULL, risk_estimate = NULL, risk_version = NULL');
    db.exec("UPDATE eval_results SET provenance = '{not json' WHERE rowid = (SELECT MIN(rowid) FROM eval_results)");
    db.close();

    clearRiskEstimateCache();
    const logged: string[] = [];
    const reopened = new SqliteAdapter(path, { log: (_level, line) => void logged.push(line) });
    await reopened.initialize();
    stores.push(reopened);
    await reopened.whenRiskEstimatesStored();
    const check = new Database(path, { readonly: true });
    const rows = check.prepare('SELECT verdict_state, risk_version FROM eval_results ORDER BY rowid').all() as Array<{ verdict_state: string | null; risk_version: string | null }>;
    check.close();
    expect(rows.every((r) => r.risk_version !== null)).toBe(true);
    expect(rows.slice(1).map((r) => r.verdict_state)).toEqual(['unknown', 'fail']);
  });
});
