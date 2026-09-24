/*
 * A case's rate for ONE question.
 *
 * The composed verdict of an evaluation can pass while the task-completed
 * question failed, or fail on a safety veto while the task was done.
 * With `question`, getCaseResults keeps only the evaluations that judged
 * that question and answers `passed` as the question's own answer — every
 * rule answering it passed — and compare_traces reads a case's rate for
 * the question rather than for the verdict.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { registerCompareTracesTool } from '../../../src/tools/compare-traces.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { EvalResult, EvalRuleResult } from '../../../src/types/eval.js';

const stores: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

const rr = (ruleName: string, passed: boolean, question?: EvalRuleResult['question'], skipped = false): EvalRuleResult =>
  ({ ruleName, passed, score: passed ? 1 : 0, message: 'm', ...(question ? { question } : {}), ...(skipped ? { skipped: true } : {}) }) as EvalRuleResult;

async function seeded(): Promise<SqliteAdapter> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  stores.push(storage);
  // Case k1 asked three times. Composed verdict: pass, fail, pass. task_completed's own answer: fail, fail, pass.
  const attempts: Array<{ id: string; verdict: boolean; rules: EvalRuleResult[] }> = [
    { id: 'a1', verdict: true, rules: [rr('ask_coverage', false, 'task_completed'), rr('no_pii', true, 'safe_output')] },
    { id: 'a2', verdict: false, rules: [rr('ask_coverage', false, 'task_completed'), rr('no_pii', false, 'safe_output')] },
    { id: 'a3', verdict: true, rules: [rr('ask_coverage', true, 'task_completed'), rr('no_pii', true, 'safe_output')] },
    // A fourth attempt never judged the question (the rule skipped): it counts for the verdict, not for the question.
    { id: 'a4', verdict: true, rules: [rr('ask_coverage', false, 'task_completed', true), rr('no_pii', true, 'safe_output')] },
  ];
  for (const a of attempts) {
    await storage.insertTrace(LOCAL_TENANT, { trace_id: `t-${a.id}`, agent_name: 'bot', input: 'do the three things', output: 'did some', timestamp: '2026-09-01T10:00:00Z', run_id: 'nightly-1', case_key: 'k1' });
    const result: EvalResult = { id: `e-${a.id}`, trace_id: `t-${a.id}`, eval_type: 'all', output_text: 'did some', score: 0.5, passed: a.verdict, rule_results: a.rules, run_id: 'nightly-1' };
    await storage.insertEvalResult(LOCAL_TENANT, result);
  }
  return storage;
}

describe('getCaseResults with question', () => {
  it('without a question every attempt counts and passed is the composed verdict; with one, only judged attempts count and passed is the question’s answer', async () => {
    const storage = await seeded();
    const all = await storage.getCaseResults(LOCAL_TENANT, { caseKey: 'k1' });
    expect(all.map((r) => r.passed)).toEqual([true, false, true, true]);
    const task = await storage.getCaseResults(LOCAL_TENANT, { caseKey: 'k1', question: 'task_completed' });
    expect(task.map((r) => [r.evalId, r.passed])).toEqual([
      ['e-a1', false],
      ['e-a2', false],
      ['e-a3', true],
    ]);
    const safe = await storage.getCaseResults(LOCAL_TENANT, { caseKey: 'k1', question: 'safe_output' });
    expect(safe.map((r) => r.passed)).toEqual([true, false, true, true]);
    expect(await storage.getCaseResults(LOCAL_TENANT, { caseKey: 'k1', question: 'within_budget' })).toEqual([]);
  });
});

describe('compare_traces with question', () => {
  it('reads the case’s rate for the question, not the verdict, and echoes the question', async () => {
    const storage = await seeded();
    let handler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
    registerCompareTracesTool({ registerTool: (_n: string, _c: unknown, fn: typeof handler) => { handler = fn; } } as never, storage as never);
    if (!handler) throw new Error('compare_traces did not register');
    const verdict = (await handler({})) as { structuredContent: { question: string | null; cases: number; flaky_cases: Array<{ case_key: string; attempts: number; passed: number }> } };
    expect(verdict.structuredContent.question).toBeNull();
    expect(verdict.structuredContent.flaky_cases[0]).toMatchObject({ case_key: 'k1', attempts: 4, passed: 3 });
    const task = (await handler({ question: 'task_completed' })) as { structuredContent: { question: string | null; flaky_cases: Array<{ case_key: string; attempts: number; passed: number; rate: number }> } };
    expect(task.structuredContent.question).toBe('task_completed');
    expect(task.structuredContent.flaky_cases[0]).toMatchObject({ case_key: 'k1', attempts: 3, passed: 1 });
    expect(task.structuredContent.flaky_cases[0].rate).toBeCloseTo(1 / 3, 6);
  });
});
