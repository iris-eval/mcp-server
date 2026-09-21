/*
 * Datasets over HTTP, and a comparison restricted to one (arc 8, R-8).
 *
 * Two runs share three case keys; a dataset of two of them makes the
 * comparison pair two, not three, and the response says so. No statistic
 * is new — the same McNemar over fewer cases — which is why the probe is
 * the pair count and the matched counts, not a p-value.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { SqliteAdapter } from '../../../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../../../src/dashboard/server.js';
import { defaultConfig } from '../../../../src/config/defaults.js';
import { createLogger } from '../../../../src/utils/logger.js';
import { compareStoredRuns } from '../../../../src/tools/compare-runs.js';
import { IrisError } from '../../../../src/tools/errors.js';
import { LOCAL_TENANT } from '../../../../src/types/tenant.js';
import type { EvalResult } from '../../../../src/types/eval.js';

describe('the datasets routes and the dataset-restricted comparison', () => {
  let storage: SqliteAdapter;
  let server: Server;
  let port = 0;

  const evalRow = (id: string, traceId: string, passed: boolean, runId: string): EvalResult => ({
    id,
    trace_id: traceId,
    eval_type: 'all',
    output_text: 'answer',
    score: passed ? 0.9 : 0.2,
    passed,
    rule_results: [{ ruleName: 'min_output_length', passed, score: passed ? 1 : 0, message: 'm' }],
    suggestions: [],
    run_id: runId,
  });

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const config = structuredClone(defaultConfig);
    config.dashboard.port = 0;
    config.dashboard.host = '127.0.0.1';
    config.logging.level = 'error';
    server = createDashboardServer(storage, config, createLogger(config)).start();
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    port = (server.address() as { port: number }).port;
    // Two runs, three shared cases. before: all pass. after: case-a and case-b fail, case-c passes.
    const cases = ['case-a', 'case-b', 'case-c'];
    for (const run of ['before-run', 'after-run']) {
      for (const key of cases) {
        const traceId = `${run}-${key}`;
        await storage.insertTrace(LOCAL_TENANT, {
          trace_id: traceId,
          agent_name: 'runner',
          input: `ask ${key}`,
          output: `answer ${key}`,
          timestamp: '2026-09-01T10:00:00Z',
          run_id: run,
          case_key: key,
        });
        const passed = run === 'before-run' || key === 'case-c';
        await storage.insertEvalResult(LOCAL_TENANT, evalRow(`e-${traceId}`, traceId, passed, run));
      }
    }
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage.close();
  });

  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('POST promotes a run’s case keys, GET lists and reads it by id and by label, and an unknown one is 404', async () => {
    const created = await call('POST', '/datasets', { label: 'release-gate', from_run: 'before-run' });
    expect(created.status).toBe(201);
    const dataset = created.body.dataset as { id: string; label: string; cases: number; caseKeys: Array<{ caseKey: string }> };
    expect(dataset.label).toBe('release-gate');
    expect(dataset.cases).toBe(3);
    expect(dataset.caseKeys.map((c) => c.caseKey)).toEqual(['case-a', 'case-b', 'case-c']);
    const list = await call('GET', '/datasets');
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(1);
    expect((list.body.datasets as Array<{ id: string }>)[0].id).toBe(dataset.id);
    expect((await call('GET', `/datasets/${dataset.id}`)).status).toBe(200);
    expect(((await call('GET', '/datasets/release-gate')).body.dataset as { id: string }).id).toBe(dataset.id);
    expect((await call('GET', '/datasets/nope')).status).toBe(404);
  });

  it('POST unions from_run, case_keys and cases (with the expected answer), refuses an empty promotion and a taken label, and names a misspelled key', async () => {
    const empty = await call('POST', '/datasets', { label: 'x', from_run: 'no-such-run' });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/has no traces with a case key/);
    const nothing = await call('POST', '/datasets', { label: 'x' });
    expect(nothing.status).toBe(400);
    expect(nothing.body.error).toMatch(/at least one case key/);
    const unioned = await call('POST', '/datasets', {
      label: 'mixed',
      from_run: 'before-run',
      case_keys: ['case-z'],
      cases: [{ case_key: 'case-a', expected: { answer: 'A' } }],
    });
    expect(unioned.status).toBe(201);
    const ds = unioned.body.dataset as { cases: number; caseKeys: Array<{ caseKey: string; expected: unknown }> };
    expect(ds.cases).toBe(4);
    expect(ds.caseKeys.find((c) => c.caseKey === 'case-a')?.expected).toEqual({ answer: 'A' });
    expect(ds.caseKeys.find((c) => c.caseKey === 'case-z')?.expected).toBeNull();
    const taken = await call('POST', '/datasets', { label: 'mixed', case_keys: ['q'] });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatch(/A dataset labelled "mixed" already exists/);
    const typo = await call('POST', '/datasets', { label: 'y', case_key: ['q'] });
    expect(typo.status).toBe(400);
    expect((typo.body.details as Array<{ message: string }>).map((d) => d.message).join(' ')).toMatch(/Unknown key\(s\): "case_key"\. Valid keys: label, from_run, case_keys, cases/);
  });

  it('a dataset restricts the comparison: two pairs of the three shared cases, and the response says which and how many', async () => {
    const all = await call('POST', '/compare', { before: 'before-run', after: 'after-run' });
    expect(all.status).toBe(200);
    expect((all.body.paired as { pairs: number }).pairs).toBe(3);
    expect(all.body.dataset).toBeNull();

    await call('POST', '/datasets', { label: 'two-cases', case_keys: ['case-a', 'case-c'] });
    const restricted = await call('POST', '/compare', { before: 'before-run', after: 'after-run', dataset: 'two-cases' });
    expect(restricted.status).toBe(200);
    expect((restricted.body.paired as { pairs: number; b: number; c: number }).pairs).toBe(2);
    // case-a passed before and failed after (b = 1); case-c is concordant; case-b is outside the dataset.
    expect((restricted.body.paired as { b: number }).b).toBe(1);
    expect((restricted.body.before as { n: number }).n).toBe(2);
    expect((restricted.body.after as { n: number }).n).toBe(2);
    expect(restricted.body.dataset).toMatchObject({ label: 'two-cases', cases: 2, matched_before: 2, matched_after: 2, version: 1 });
    expect(restricted.body.summary).toMatch(/^Restricted to dataset "two-cases" \(2 cases\): 2 rows of before-run and 2 of after-run matched\./);

    const unknown = await call('POST', '/compare', { before: 'before-run', after: 'after-run', dataset: 'nope' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toMatch(/No dataset has the id or label "nope"/);
  });

  it('the tool path refuses an unknown dataset as IRIS_INVALID_ARGUMENT naming the field', async () => {
    let caught: unknown;
    try {
      await compareStoredRuns(storage, LOCAL_TENANT, { before: 'before-run', after: 'after-run', dataset: 'missing' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IrisError);
    expect((caught as IrisError).envelope.code).toBe('IRIS_INVALID_ARGUMENT');
    expect((caught as IrisError).envelope.field).toBe('dataset');
  });
});
