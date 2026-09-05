/*
 * Deleting a trace erases the text of every evaluation linked to it.
 *
 * eval_results.trace_id is ON DELETE SET NULL, so a deleted trace used to
 * leave its evaluations behind with output_text verbatim — including the
 * SSN no_pii had flagged — orphaned and readable by every query (arc zero,
 * G15). Now delete_trace and the retention sweep blank the text, the
 * expected text, the suggestions and the rule messages, stamp erased_at,
 * and keep the scores and the evidence offsets.
 */
import { describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { generateTraceId } from '../../../src/utils/ids.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const SSN_OUTPUT = 'Done. For the record, the customer SSN is 536-22-8145 and the invoice is settled.';

async function storeLinked(storage: SqliteAdapter, timestamp = new Date().toISOString()) {
  const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds);
  const traceId = generateTraceId();
  await storage.insertTrace(LOCAL_TENANT, { trace_id: traceId, agent_name: 'erasure', input: 'q', output: SSN_OUTPUT, timestamp });
  const result = engine.evaluate('safety', { output: SSN_OUTPUT, expected: 'the invoice is settled' });
  result.trace_id = traceId;
  result.expected_text = 'the invoice is settled';
  await storage.insertEvalResult(LOCAL_TENANT, result);
  return { traceId, evalId: result.id, before: result };
}

describe('erasure', () => {
  it('delete_trace leaves no text from the trace in its evaluations, and keeps the verdict and the evidence offsets', async () => {
    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const { traceId, evalId, before } = await storeLinked(storage);
    const pii = before.rule_results.find((r) => r.ruleName === 'no_pii')!;
    expect(pii.passed).toBe(false);
    expect(pii.evidence?.some((e) => e.type === 'span')).toBe(true);

    expect(await storage.deleteTrace(LOCAL_TENANT, traceId)).toBe(true);

    const after = (await storage.getEvalById(LOCAL_TENANT, evalId))!;
    expect(after.output_text).toBe('');
    expect(after.expected_text).toBeUndefined();
    expect(after.suggestions).toEqual([]);
    expect(after.erased_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(after.trace_id ?? undefined).toBeUndefined();
    expect(after.score).toBe(before.score);
    expect(after.passed).toBe(before.passed);
    expect(after.critical_failures).toEqual(before.critical_failures);
    const piiAfter = after.rule_results.find((r) => r.ruleName === 'no_pii')!;
    expect(piiAfter.passed).toBe(false);
    expect(piiAfter.message).toBe('erased with the trace');
    expect(piiAfter.evidence).toEqual(pii.evidence);
    expect(JSON.stringify(after)).not.toContain('536-22-8145');
    expect(JSON.stringify(after)).not.toContain('invoice');
    await storage.close();
  });

  it('the retention sweep erases the evaluations of the traces it deletes, even when the evaluation itself is young', async () => {
    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const { evalId } = await storeLinked(storage, old);
    const { evalId: youngEval, traceId: youngTrace } = await storeLinked(storage);

    expect(await storage.deleteTracesOlderThan(LOCAL_TENANT, 30)).toBe(1);

    const swept = (await storage.getEvalById(LOCAL_TENANT, evalId))!;
    expect(swept.output_text).toBe('');
    expect(swept.erased_at).toBeDefined();
    const kept = (await storage.getEvalById(LOCAL_TENANT, youngEval))!;
    expect(kept.output_text).toBe(SSN_OUTPUT);
    expect(kept.erased_at).toBeUndefined();
    expect(kept.trace_id).toBe(youngTrace);
    await storage.close();
  });

  it('deleting an unknown trace erases nothing and reports false', async () => {
    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const { evalId } = await storeLinked(storage);
    expect(await storage.deleteTrace(LOCAL_TENANT, 'f'.repeat(32))).toBe(false);
    expect((await storage.getEvalById(LOCAL_TENANT, evalId))!.output_text).toBe(SSN_OUTPUT);
    await storage.close();
  });
});
