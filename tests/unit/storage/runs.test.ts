import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { Trace } from '../../../src/types/trace.js';

/*
 * The runs registry, and the one property that matters about it: every
 * countable fact is counted from the rows, never stored beside them. A run
 * whose trace count came out of a column would go wrong the first time a
 * trace was deleted, and nobody would find out from the number itself.
 */

let dir: string;
let store: SqliteAdapter;

const trace = (id: string, over: Partial<Trace> = {}): Trace => ({
  trace_id: id,
  agent_name: 'runner',
  input: `question ${id}`,
  output: `answer ${id}`,
  timestamp: '2026-09-01T10:00:00Z',
  ...over,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'iris-runs-'));
  store = new SqliteAdapter(join(dir, 'test.db'));
  await store.initialize();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the runs registry', () => {
  it('lists a run that exists only because a trace carried the id', async () => {
    // Nothing registered it. A caller who passes `run` on log_trace and
    // nothing else must still find their run — otherwise the listing shows
    // an empty page to the person who just created the data.
    await store.insertTrace(LOCAL_TENANT, trace('t1', { run_id: 'nightly-1' }));
    await store.insertTrace(LOCAL_TENANT, trace('t2', { run_id: 'nightly-1' }));

    const runs = await store.listRuns(LOCAL_TENANT);
    expect(runs.map((r) => r.runId)).toEqual(['nightly-1']);
    expect(runs[0].traces).toBe(2);
    expect(runs[0].evaluated).toBe(0);
    expect(runs[0].label).toBeNull();
  });

  it('keeps the label and the re-evaluation link, which cannot be derived', async () => {
    await store.insertTrace(LOCAL_TENANT, trace('t1', { run_id: 'before' }));
    await store.upsertRun(LOCAL_TENANT, { runId: 'after', label: 'rules v2', reevaluationOf: 'before' });

    const after = await store.getRun(LOCAL_TENANT, 'after');
    expect(after?.label).toBe('rules v2');
    expect(after?.reevaluationOf).toBe('before');
    // Registered with no rows yet: listed, not hidden. A re-evaluation that
    // produced nothing is a result worth seeing.
    expect(after?.traces).toBe(0);
  });

  it('an upsert never nulls a fact it was not given', async () => {
    await store.upsertRun(LOCAL_TENANT, { runId: 'r', label: 'first', reevaluationOf: 'base' });
    await store.upsertRun(LOCAL_TENANT, { runId: 'r', agentName: 'runner' });

    const r = await store.getRun(LOCAL_TENANT, 'r');
    expect(r?.label).toBe('first');
    expect(r?.reevaluationOf).toBe('base');
  });

  it('returns null for a run nothing mentions', async () => {
    expect(await store.getRun(LOCAL_TENANT, 'never-existed')).toBeNull();
  });

  it('reports which traces still need evaluating under a ruleset', async () => {
    await store.insertTrace(LOCAL_TENANT, trace('t1', { run_id: 'r' }));
    await store.insertTrace(LOCAL_TENANT, trace('t2', { run_id: 'r' }));

    const before = await store.getRunTraceEvaluationState(LOCAL_TENANT, 'r', 'hash-v2');
    expect(before.map((s) => s.evaluatedUnderRuleset)).toEqual([false, false]);
    expect(before.map((s) => s.traceId).sort()).toEqual(['t1', 't2']);
  });

  it('scopes every read to the tenant', async () => {
    await store.insertTrace(LOCAL_TENANT, trace('t1', { run_id: 'mine' }));
    const runs = await store.listRuns(LOCAL_TENANT);
    expect(runs).toHaveLength(1);
  });
});
