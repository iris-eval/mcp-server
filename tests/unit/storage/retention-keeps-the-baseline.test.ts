/*
 * The retention sweep keeps the pinned baseline run.
 *
 * A baseline is the `before` every later run is compared against. The sweep
 * deleted it at the window like any other trace, so a run pinned 31 days
 * ago compared against nothing. It is now kept with its evaluations, and
 * the sweep reports what it kept. Unpinning the run, `delete_trace` and
 * `--purge` still remove it. Dataset cases and labels are not traces or
 * evaluations: the sweep never touched them, and this holds that too.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { runRetentionSweep } from '../../../src/retention.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { LOCAL_TENANT, asTenantId } from '../../../src/types/tenant.js';
import type { Trace } from '../../../src/types/trace.js';
import type { EvalResult } from '../../../src/types/eval.js';

const OLD = '2020-01-01T00:00:00.000Z';
const trace = (id: string, timestamp: string, run?: string, caseKey?: string): Trace =>
  ({ trace_id: id, agent_name: 'agent', output: `output of ${id}`, timestamp, ...(run ? { run_id: run } : {}), ...(caseKey ? { case_key: caseKey } : {}) }) as Trace;
const evaluation = (id: string, over: Partial<EvalResult>): EvalResult =>
  ({ id, eval_type: 'all', output_text: 'text', score: 1, passed: true, rule_results: [{ ruleName: 'non_empty_output', passed: true, score: 1, message: 'ok' }], ...over }) as EvalResult;

describe('the retention sweep keeps the pinned baseline run', () => {
  let s: SqliteAdapter;
  const db = () => (s as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): Record<string, unknown> } } }).db;
  const age = (evalId: string, at = OLD) => db().prepare('UPDATE eval_results SET created_at = ? WHERE id = ?').run(at, evalId);
  const traceIds = async (): Promise<string[]> => (await s.queryTraces(LOCAL_TENANT, { limit: 1000 })).traces.map((t) => t.trace_id).sort();
  const evalIds = async (): Promise<string[]> => (await s.queryEvalResults(LOCAL_TENANT, { limit: 1000 })).results.map((e) => e.id).sort();

  beforeEach(async () => {
    s = new SqliteAdapter(':memory:');
    await s.initialize();
    // Two old runs and one old trace in no run, each trace with one old evaluation.
    for (const [id, run] of [['b1', 'baseline'], ['b2', 'baseline'], ['o1', 'other'], ['loose', undefined]] as const) {
      await s.insertTrace(LOCAL_TENANT, trace(id, OLD, run, `case-${id}`));
      await s.insertEvalResult(LOCAL_TENANT, evaluation(`e-${id}`, { trace_id: id }));
      age(`e-${id}`);
    }
  });
  afterEach(async () => {
    await s.close();
  });

  it('with no run pinned, everything past the window goes, as before', async () => {
    expect(await s.deleteTracesOlderThan(LOCAL_TENANT, 30)).toBe(4);
    expect(await s.deleteEvalResultsOlderThan(LOCAL_TENANT, 30)).toBe(4);
    expect(await traceIds()).toEqual([]);
    expect(await s.keptPastRetention(LOCAL_TENANT, 30)).toBeNull();
  });

  it('the pinned run\'s traces and evaluations stay, with their text; everything else past the window goes', async () => {
    await s.setRunBaseline(LOCAL_TENANT, 'baseline', true);
    expect(await s.deleteTracesOlderThan(LOCAL_TENANT, 30)).toBe(2);
    expect(await s.deleteEvalResultsOlderThan(LOCAL_TENANT, 30)).toBe(2);
    expect(await traceIds()).toEqual(['b1', 'b2']);
    expect(await evalIds()).toEqual(['e-b1', 'e-b2']);
    // Kept whole: the evaluation still carries its text and its trace.
    const kept = (await s.queryEvalResults(LOCAL_TENANT, { limit: 10 })).results.find((e) => e.id === 'e-b1');
    expect(kept).toMatchObject({ trace_id: 'b1', output_text: 'text' });
    expect(kept?.erased_at).toBeUndefined();
    expect(await s.keptPastRetention(LOCAL_TENANT, 30)).toEqual({ runId: 'baseline', traces: 2, evaluations: 2 });
    // A second sweep finds nothing more to delete and keeps the same.
    expect(await s.deleteTracesOlderThan(LOCAL_TENANT, 30)).toBe(0);
    expect(await s.deleteEvalResultsOlderThan(LOCAL_TENANT, 30)).toBe(0);
    expect(await traceIds()).toEqual(['b1', 'b2']);
  });

  it('an evaluation that names the baseline run itself is kept, and a re-evaluation of the baseline under another run id is not', async () => {
    await s.setRunBaseline(LOCAL_TENANT, 'baseline', true);
    await s.insertEvalResult(LOCAL_TENANT, evaluation('e-own-run', { run_id: 'baseline' }));
    await s.insertEvalResult(LOCAL_TENANT, evaluation('e-reeval', { trace_id: 'b1', run_id: 'baseline-reevaluated' }));
    age('e-own-run');
    age('e-reeval');
    await s.deleteEvalResultsOlderThan(LOCAL_TENANT, 30);
    expect(await evalIds()).toEqual(['e-b1', 'e-b2', 'e-own-run']);
  });

  it('unpinning the run, or pinning another, lets the next sweep delete it', async () => {
    await s.setRunBaseline(LOCAL_TENANT, 'baseline', true);
    await s.deleteTracesOlderThan(LOCAL_TENANT, 30);
    await s.deleteEvalResultsOlderThan(LOCAL_TENANT, 30);
    await s.setRunBaseline(LOCAL_TENANT, 'baseline', false);
    expect(await s.keptPastRetention(LOCAL_TENANT, 30)).toBeNull();
    expect(await s.deleteTracesOlderThan(LOCAL_TENANT, 30)).toBe(2);
    expect(await s.deleteEvalResultsOlderThan(LOCAL_TENANT, 30)).toBe(2);
    expect(await traceIds()).toEqual([]);
  });

  it('pinning the other run keeps that one instead', async () => {
    await s.setRunBaseline(LOCAL_TENANT, 'baseline', true);
    await s.setRunBaseline(LOCAL_TENANT, 'other', true);
    await s.deleteTracesOlderThan(LOCAL_TENANT, 30);
    await s.deleteEvalResultsOlderThan(LOCAL_TENANT, 30);
    expect(await traceIds()).toEqual(['o1']);
    expect(await evalIds()).toEqual(['e-o1']);
  });

  it('a baseline pinned by another tenant keeps nothing of this one', async () => {
    const other = asTenantId('tenant-b');
    await s.insertTrace(other, trace('theirs', OLD, 'baseline'));
    await s.setRunBaseline(other, 'baseline', true);
    expect(await s.deleteTracesOlderThan(LOCAL_TENANT, 30)).toBe(4);
    expect(await s.deleteTracesOlderThan(other, 30)).toBe(0);
    expect((await s.queryTraces(other, { limit: 10 })).traces.map((t) => t.trace_id)).toEqual(['theirs']);
  });

  it('delete_trace and --purge still remove a pinned run\'s traces', async () => {
    await s.setRunBaseline(LOCAL_TENANT, 'baseline', true);
    expect(await s.deleteTrace(LOCAL_TENANT, 'b1')).toBe(true);
    expect(await traceIds()).toEqual(['b2', 'loose', 'o1']);
    await s.purge(LOCAL_TENANT);
    expect(await traceIds()).toEqual([]);
  });

  it('a sweep of many traces around a kept run deletes every one that is due, in steps', async () => {
    await s.setRunBaseline(LOCAL_TENANT, 'baseline', true);
    // Kept traces at the old end, due traces before, among and after them, some sharing a timestamp.
    const due: Trace[] = [];
    for (let i = 0; i < 300; i++) due.push(trace(`due-${i}`, new Date(Date.UTC(2019, 0, 1) + Math.floor(i / 7) * 86_400_000).toISOString(), i % 3 === 0 ? 'other' : undefined));
    const kept: Trace[] = [];
    for (let i = 0; i < 60; i++) kept.push(trace(`kept-${i}`, new Date(Date.UTC(2019, 0, 1) + i * 86_400_000).toISOString(), 'baseline'));
    await s.insertTraces(LOCAL_TENANT, [...due, ...kept]);
    await s.insertTrace(LOCAL_TENANT, trace('recent', new Date().toISOString()));
    expect(await s.deleteTracesOlderThan(LOCAL_TENANT, 30)).toBe(302);
    const left = await traceIds();
    expect(left).toHaveLength(63);
    expect(left.filter((id) => id.startsWith('due-'))).toEqual([]);
    expect(left).toContain('recent');
  });

  it('dataset cases and labels are not swept: they outlive the traces and evaluations they were made from', async () => {
    const dataset = await s.createDataset(LOCAL_TENANT, { label: 'release-gate', cases: [{ caseKey: 'case-o1', expected: 'the expected answer' }, { caseKey: 'case-loose', expected: null }] });
    await s.insertVerdictLabel(LOCAL_TENANT, { id: 'l1', evalId: 'e-o1', ruleName: 'non_empty_output', label: 'wrong', note: null });
    await s.deleteTracesOlderThan(LOCAL_TENANT, 30);
    await s.deleteEvalResultsOlderThan(LOCAL_TENANT, 30);
    expect(await traceIds()).toEqual([]);
    const cases = (await s.getDataset(LOCAL_TENANT, dataset.id))?.caseKeys ?? [];
    expect(cases.map((c) => c.caseKey).sort()).toEqual(['case-loose', 'case-o1']);
    expect(cases.find((c) => c.caseKey === 'case-o1')?.expected).toBe('the expected answer');
    expect(await s.labelTallies(LOCAL_TENANT)).toEqual([{ ruleName: 'non_empty_output', right: 0, wrong: 1 }]);
  });

  it('the server\'s sweep reports what it kept', async () => {
    await s.setRunBaseline(LOCAL_TENANT, 'baseline', true);
    const lines: string[] = [];
    const config = structuredClone(defaultConfig);
    config.storage.path = ':memory:';
    const out = await runRetentionSweep(s, config, { info: (m) => lines.push(m), warn: (m) => lines.push(m) });
    expect(out).toMatchObject({ deletedTraces: 2, deletedEvals: 2, kept: { runId: 'baseline', traces: 2, evaluations: 2 } });
    expect(lines.join('\n')).toMatch(/kept 2 trace\(s\) and 2 evaluation\(s\) older than 30 days: they belong to the pinned baseline run baseline\. Unpin the run and the next sweep deletes them\./);
  });
});
