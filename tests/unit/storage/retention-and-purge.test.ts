import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { generateEvalId } from '../../../src/utils/ids.js';
import { LOCAL_TENANT, asTenantId } from '../../../src/types/tenant.js';
import type { Trace } from '../../../src/types/trace.js';
import type { EvalResult } from '../../../src/types/eval.js';

/*
 * #372 — retention and purge for stored text.
 *
 * Every eval row carries output_text verbatim (a PII detector stores the
 * PII it found), and eval_results.trace_id is ON DELETE SET NULL — so the
 * trace sweep left every evaluation behind forever, and deleting rows by
 * any path left their bytes readable in the file and in iris.db-wal.
 */

const SENTINEL = 'SENTINEL-536-22-8145-quarterly-leak';

function trace(id: string, timestamp: string, output = 'ok'): Trace {
  return { trace_id: id, agent_name: 'retention-agent', output, timestamp };
}

function evalRow(traceId: string | undefined, outputText: string): EvalResult {
  return {
    id: generateEvalId(),
    trace_id: traceId,
    eval_type: 'safety',
    output_text: outputText,
    score: 0,
    passed: false,
    rule_results: [{ ruleName: 'no_pii', passed: false, score: 0, message: 'Potential PII detected: SSN' }],
    suggestions: [],
  };
}

/** Rewrite created_at, which insertEvalResult always stamps with "now". */
function ageEval(adapter: SqliteAdapter, id: string, createdAt: string): void {
  (adapter as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
    .prepare('UPDATE eval_results SET created_at = ? WHERE id = ?')
    .run(createdAt, id);
}

describe('deleteEvalResultsOlderThan', () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    adapter = new SqliteAdapter(':memory:');
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('deletes evaluations older than the window and keeps recent ones — linked or not', async () => {
    await adapter.insertTrace(LOCAL_TENANT, trace('t-recent', new Date().toISOString()));
    const oldLinked = evalRow('t-recent', 'old linked');
    const oldUnlinked = evalRow(undefined, 'old unlinked');
    const recent = evalRow('t-recent', 'recent');
    for (const row of [oldLinked, oldUnlinked, recent]) await adapter.insertEvalResult(LOCAL_TENANT, row);
    ageEval(adapter, oldLinked.id, '2020-01-01T00:00:00.000Z');
    ageEval(adapter, oldUnlinked.id, '2020-01-02T00:00:00.000Z');

    const deleted = await adapter.deleteEvalResultsOlderThan(LOCAL_TENANT, 30);
    expect(deleted).toBe(2);

    const remaining = await adapter.queryEvalResults(LOCAL_TENANT, {});
    expect(remaining.total).toBe(1);
    expect(remaining.results[0].id).toBe(recent.id);
  });

  it('is the gap the trace sweep leaves: sweeping traces alone keeps the eval text', async () => {
    await adapter.insertTrace(LOCAL_TENANT, trace('t-old', '2020-01-01T00:00:00.000Z'));
    const row = evalRow('t-old', SENTINEL);
    await adapter.insertEvalResult(LOCAL_TENANT, row);
    ageEval(adapter, row.id, '2020-01-01T00:00:00.000Z');

    expect(await adapter.deleteTracesOlderThan(LOCAL_TENANT, 30)).toBe(1);
    // The evaluation survived the trace sweep with its text intact (trace_id NULLed).
    const afterTraces = await adapter.queryEvalResults(LOCAL_TENANT, {});
    expect(afterTraces.total).toBe(1);
    expect(afterTraces.results[0].output_text).toBe(SENTINEL);
    expect(afterTraces.results[0].trace_id).toBeFalsy();

    expect(await adapter.deleteEvalResultsOlderThan(LOCAL_TENANT, 30)).toBe(1);
    expect((await adapter.queryEvalResults(LOCAL_TENANT, {})).total).toBe(0);
  });

  it('scopes to the tenant', async () => {
    const tenantA = asTenantId('tenant-a');
    const tenantB = asTenantId('tenant-b');
    const a = evalRow(undefined, 'a');
    const b = evalRow(undefined, 'b');
    await adapter.insertEvalResult(tenantA, a);
    await adapter.insertEvalResult(tenantB, b);
    ageEval(adapter, a.id, '2020-01-01T00:00:00.000Z');
    ageEval(adapter, b.id, '2020-01-01T00:00:00.000Z');

    expect(await adapter.deleteEvalResultsOlderThan(tenantA, 1)).toBe(1);
    expect((await adapter.queryEvalResults(tenantA, {})).total).toBe(0);
    expect((await adapter.queryEvalResults(tenantB, {})).total).toBe(1);
  });
});

describe('purge + checkpoint on a file-backed database', () => {
  let dir: string;
  let dbPath: string;
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iris-purge-'));
    dbPath = join(dir, 'iris.db');
    adapter = new SqliteAdapter(dbPath);
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const fileHolds = (path: string, needle: string): boolean => existsSync(path) && readFileSync(path).includes(needle);

  it('removes every trace, span and evaluation and leaves no copy of the text in iris.db or iris.db-wal', async () => {
    await adapter.insertTrace(LOCAL_TENANT, {
      ...trace('t-1', new Date().toISOString(), SENTINEL),
      spans: [{ span_id: 's-1', trace_id: 't-1', name: 'llm', kind: 'LLM', status_code: 'OK', start_time: new Date().toISOString() }],
    });
    await adapter.insertTrace(LOCAL_TENANT, trace('t-2', new Date().toISOString()));
    await adapter.insertEvalResult(LOCAL_TENANT, evalRow('t-1', SENTINEL));
    await adapter.insertEvalResult(LOCAL_TENANT, evalRow(undefined, 'clean'));

    // Anti-theater: the text really is on disk before the purge (WAL mode
    // lands fresh writes in the -wal file first).
    expect(fileHolds(dbPath, SENTINEL) || fileHolds(`${dbPath}-wal`, SENTINEL)).toBe(true);

    const counts = await adapter.purge(LOCAL_TENANT);
    expect(counts).toEqual({ traces: 2, evalResults: 2 });

    expect((await adapter.queryTraces(LOCAL_TENANT, {})).total).toBe(0);
    expect((await adapter.queryEvalResults(LOCAL_TENANT, {})).total).toBe(0);
    expect(await adapter.getSpansByTraceId(LOCAL_TENANT, 't-1')).toEqual([]);

    expect(fileHolds(dbPath, SENTINEL)).toBe(false);
    expect(fileHolds(`${dbPath}-wal`, SENTINEL)).toBe(false);
  });

  it('a retention sweep followed by checkpoint() leaves no copy of the swept text either', async () => {
    await adapter.insertTrace(LOCAL_TENANT, trace('t-old', '2020-01-01T00:00:00.000Z', SENTINEL));
    const row = evalRow('t-old', SENTINEL);
    await adapter.insertEvalResult(LOCAL_TENANT, row);
    ageEval(adapter, row.id, '2020-01-01T00:00:00.000Z');
    expect(fileHolds(dbPath, SENTINEL) || fileHolds(`${dbPath}-wal`, SENTINEL)).toBe(true);

    expect(await adapter.deleteTracesOlderThan(LOCAL_TENANT, 30)).toBe(1);
    expect(await adapter.deleteEvalResultsOlderThan(LOCAL_TENANT, 30)).toBe(1);
    await adapter.checkpoint();

    expect(fileHolds(dbPath, SENTINEL)).toBe(false);
    expect(fileHolds(`${dbPath}-wal`, SENTINEL)).toBe(false);
  });

  it('purge is tenant-scoped', async () => {
    const other = asTenantId('other-tenant');
    await adapter.insertTrace(LOCAL_TENANT, trace('t-local', new Date().toISOString()));
    await adapter.insertTrace(other, trace('t-other', new Date().toISOString()));
    await adapter.insertEvalResult(other, evalRow('t-other', 'other'));

    expect(await adapter.purge(LOCAL_TENANT)).toEqual({ traces: 1, evalResults: 0 });
    expect((await adapter.queryTraces(other, {})).total).toBe(1);
    expect((await adapter.queryEvalResults(other, {})).total).toBe(1);
  });
});

describe('getEvalStats counts safety violations inside eval_type="all" rows', () => {
  it('a no_pii failure recorded by an all-bundles run is counted, not hidden behind the eval_type filter', async () => {
    const adapter = new SqliteAdapter(':memory:');
    await adapter.initialize();
    try {
      await adapter.insertEvalResult(LOCAL_TENANT, { ...evalRow(undefined, 'leak'), eval_type: 'all' });
      await adapter.insertEvalResult(LOCAL_TENANT, evalRow(undefined, 'leak'));
      const stats = await adapter.getEvalStats(LOCAL_TENANT, '24h');
      expect(stats.totalEvals).toBe(2);
      expect(stats.safetyViolations.pii).toBe(2);
    } finally {
      await adapter.close();
    }
  });
});
