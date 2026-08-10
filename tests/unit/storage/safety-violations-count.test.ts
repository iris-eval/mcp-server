import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { Trace } from '../../../src/types/trace.js';

/*
 * getEvalStats counted safety violations only inside evals that FAILED
 * overall (`AND passed = 0`). But a safety eval scores the average across
 * its rules, so one violation is routinely outvoted: a leaked SSN fails
 * no_pii while the three other safety rules pass, landing at 0.733 — over
 * the 0.7 threshold, so passed = 1 and the dashboard reported zero PII
 * violations for a trace that leaked a social security number.
 *
 * For a product whose whole job is catching PII, this erred in the
 * direction that hides problems.
 *
 * The eval is produced by the REAL EvalEngine here rather than a
 * hand-written rule_results fixture — the bug lives in the relationship
 * between per-rule outcomes and the aggregate verdict, which a fixture
 * would let us assert into existence rather than observe.
 */

let tmpDir: string;
let adapter: SqliteAdapter;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'iris-safety-'));
  adapter = new SqliteAdapter(join(tmpDir, 'iris.db'));
  await adapter.initialize();
});

afterEach(async () => {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const trace: Trace = {
  trace_id: 'trace-pii',
  agent_name: 'leaky-agent',
  framework: 'mcp',
  input: 'what is the customer record',
  output: 'Your SSN is 123-45-6789',
  cost_usd: 0.001,
  latency_ms: 100,
  timestamp: new Date().toISOString(),
};

describe('safety violation counting', () => {
  it('counts a PII violation even when the eval passed overall', async () => {
    const engine = new EvalEngine();
    const result = engine.evaluate('safety', { output: trace.output!, input: trace.input });

    // The precondition that makes this bug possible: no_pii failed, yet the
    // averaged verdict is a pass. If this ever stops holding, the assertion
    // below would pass for the wrong reason.
    const pii = result.rule_results.find((r) => r.ruleName === 'no_pii');
    expect(pii?.passed).toBe(false);
    expect(result.passed).toBe(true);

    await adapter.insertTrace(LOCAL_TENANT, trace);
    await adapter.insertEvalResult(LOCAL_TENANT, { ...result, trace_id: trace.trace_id });

    const stats = await adapter.getEvalStats(LOCAL_TENANT, '24h');
    expect(stats.safetyViolations.pii).toBe(1);
  });

  it('still reports zero when nothing violated', async () => {
    const engine = new EvalEngine();
    const clean: Trace = {
      ...trace,
      trace_id: 'trace-clean',
      output: 'The customer record was updated successfully with no issues to report.',
    };
    const result = engine.evaluate('safety', { output: clean.output!, input: clean.input });

    await adapter.insertTrace(LOCAL_TENANT, clean);
    await adapter.insertEvalResult(LOCAL_TENANT, { ...result, trace_id: clean.trace_id });

    const stats = await adapter.getEvalStats(LOCAL_TENANT, '24h');
    expect(stats.safetyViolations.pii).toBe(0);
    expect(stats.safetyViolations.injection).toBe(0);
    expect(stats.safetyViolations.hallucination).toBe(0);
  });
});
