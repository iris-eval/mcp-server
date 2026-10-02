/*
 * Labels written by another process.
 *
 * The labels live in the database, which every server process on a home
 * shares, but each process read them once at start: a label written through
 * one client's server moved the local precision and the prior in that
 * process alone. An engine now checks before each evaluation whether the
 * labels changed, at the price of reading the database's change counter.
 *
 * Two adapters on one file stand for two processes: each has its own
 * connection, and the counter (`PRAGMA data_version`) moves for a connection
 * when another one commits.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { labelsInStep } from '../../../src/eval/shared-state.js';
import { refreshLocalLabels } from '../../../src/eval/local-labels.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

describe('labels another process wrote', () => {
  let dir: string;
  let a: SqliteAdapter;
  let b: SqliteAdapter;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iris-shared-labels-'));
    a = new SqliteAdapter(join(dir, 'iris.db'));
    await a.initialize();
    b = new SqliteAdapter(join(dir, 'iris.db'));
    await b.initialize();
  });
  afterEach(async () => {
    await a.close();
    await b.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const label = (store: SqliteAdapter, id: string, verdict: 'right' | 'wrong') =>
    store.insertVerdictLabel(LOCAL_TENANT, { id, evalId: `eval-${id}`, ruleName: 'no_pii', label: verdict, note: null });

  it('the stamp moves when another connection writes a label, and stays put otherwise', async () => {
    const empty = await a.labelsStamp(LOCAL_TENANT);
    expect(await a.labelsStamp(LOCAL_TENANT)).toBe(empty);
    await label(b, 'l1', 'right');
    const one = await a.labelsStamp(LOCAL_TENANT);
    expect(one).not.toBe(empty);
    // A write that is not a label moves the counter and leaves the stamp.
    await b.insertTrace(LOCAL_TENANT, { trace_id: 't1', agent_name: 'agent', output: 'ok', timestamp: new Date().toISOString() });
    expect(await a.labelsStamp(LOCAL_TENANT)).toBe(one);
    // The same fire labelled again, the other way: same count, a newer label.
    await new Promise((r) => setTimeout(r, 5));
    await b.insertVerdictLabel(LOCAL_TENANT, { id: 'l1b', evalId: 'eval-l1', ruleName: 'no_pii', label: 'wrong', note: null });
    expect(await a.labelsStamp(LOCAL_TENANT)).not.toBe(one);
  });

  it('the stamp moves for this connection\'s own label too', async () => {
    const before = await a.labelsStamp(LOCAL_TENANT);
    await label(a, 'l1', 'right');
    expect(await a.labelsStamp(LOCAL_TENANT)).not.toBe(before);
  });

  it('an engine reads a label another process wrote before its next evaluation, and reads nothing when none was written', async () => {
    const engine = new EvalEngine(0.7);
    await refreshLocalLabels(engine, a, LOCAL_TENANT);
    engine.setSharedState({ labels: labelsInStep(engine, a, LOCAL_TENANT) });
    expect(engine.localLabelSource()?.precision.get('no_pii')).toBeUndefined();

    await engine.evaluate('safety', { output: 'A plain answer.' });
    const settled = engine.localLabelSource();

    // Nothing written: the next evaluation keeps the same source object.
    await engine.evaluate('safety', { output: 'A plain answer.' });
    expect(engine.localLabelSource()).toBe(settled);

    await label(b, 'l1', 'right');
    await label(b, 'l2', 'wrong');
    await label(b, 'l3', 'right');
    await engine.evaluate('safety', { output: 'A plain answer.' });
    expect(engine.localLabelSource()).not.toBe(settled);
    expect(engine.localLabelSource()?.precision.get('no_pii')).toMatchObject({ right: 2, wrong: 1 });
  });

  it('a store that cannot answer leaves the engine evaluating under the labels it had', async () => {
    const engine = new EvalEngine(0.7);
    engine.setSharedState({
      labels: async () => {
        throw new Error('database is locked');
      },
    });
    await expect(engine.evaluate('safety', { output: 'A plain answer.' })).resolves.toMatchObject({ eval_type: 'safety' });
  });
});
