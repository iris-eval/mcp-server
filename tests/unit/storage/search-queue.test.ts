/*
 * The search index queue (#729).
 *
 * A write stores the trace and queues its id; the index is written after,
 * in batches. What this file proves, on both drivers:
 *
 *   - the insert does not write the index, and a search right after it
 *     still finds the trace (it indexes the queue first), with the ranking
 *     and snippet the index gives;
 *   - the indexer takes the queue without a search, after the write;
 *   - every delete route takes a queued trace off the queue, and its text
 *     leaves the file the way an indexed trace's does;
 *   - a trace changed while queued (the metadata patch, a span added, an
 *     UPDATE by hand) is indexed as it is when the indexer reaches it, and
 *     its later delete hands the index exactly those words (FTS5's own
 *     integrity check after each step);
 *   - a CJK trace queued and then indexed gets its CJK stream;
 *   - close() indexes what the process queued, and a start indexes what an
 *     earlier process left queued.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter, INDEX_BACKLOG_TRACES, INDEX_INLINE_MIN } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT, asTenantId } from '../../../src/types/tenant.js';
import { nodeSqliteAvailable, type Driver } from '../../../src/storage/driver.js';
import type { Trace } from '../../../src/types/trace.js';
import { driverHasFts5 } from './fts5-here.js';
import Database from 'better-sqlite3';

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
const open: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDb = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-queue-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
};

const DRIVERS = (['native', ...(nodeSqliteAvailable() ? ['node'] : [])] as Array<'native' | 'node'>).filter((d) => driverHasFts5(d));
const at = (minute: number) => new Date(Date.UTC(2026, 8, 20, 12, minute)).toISOString();
const trace = (trace_id: string, output: string, minute = 0, extra: Partial<Trace> = {}): Trace => ({ trace_id, agent_name: 'bot', output, timestamp: at(minute), ...extra });

const rawDb = (s: SqliteAdapter) => (s as unknown as { db: Driver }).db;
/** The queue and the index as they are, without indexing anything first. */
function state(s: SqliteAdapter): { queued: string[]; docs: string[] } {
  const db = rawDb(s);
  return {
    queued: (db.prepare('SELECT q.trace_id FROM trace_search_queue q LEFT JOIN traces t ON t.trace_id = q.trace_id ORDER BY t.rowid').all() as Array<{ trace_id: string }>).map((r) => r.trace_id),
    docs: (db.prepare('SELECT trace_id FROM trace_search_docs ORDER BY doc_id').all() as Array<{ trace_id: string }>).map((r) => r.trace_id),
  };
}
function integrity(s: SqliteAdapter): void {
  const db = rawDb(s);
  db.exec("INSERT INTO trace_search (trace_search, rank) VALUES ('integrity-check', 0)");
  db.exec("INSERT INTO trace_search_cjk (trace_search_cjk, rank) VALUES ('integrity-check', 0)");
}
const ids = async (s: SqliteAdapter, search: string, tenant = LOCAL_TENANT) =>
  (await s.queryTraces(tenant, { search, sort_by: 'timestamp', sort_order: 'asc', limit: 1000 })).traces.map((t) => t.trace_id);
const holds = (file: string, needle: string) => existsSync(file) && readFileSync(file).includes(Buffer.from(needle, 'utf8'));

describe.each(DRIVERS)('the search index queue on %s', (driver) => {
  const store = async (path = tempDb()): Promise<SqliteAdapter> => {
    const s = new SqliteAdapter(path, { driver, searchWorker: false });
    await s.initialize();
    open.push(s);
    await s.whenSearchIndexReady();
    return s;
  };

  it('an insert queues the trace and writes no index; a search right after it finds the trace, with the index’s ranking and snippet', async () => {
    const s = await store();
    await s.insertTraces(LOCAL_TENANT, [trace('a', 'The refund was approved on Monday.', 1), trace('b', 'refund refund refund, billing escalated', 2)]);
    expect(state(s)).toEqual({ queued: ['a', 'b'], docs: [] });
    const found = await s.queryTraces(LOCAL_TENANT, { search: 'refund' });
    expect(found.search).toMatchObject({ index: 'fts5', complete: true });
    // bm25 ranks the trace with the word three times first.
    expect(found.traces.map((t) => t.trace_id)).toEqual(['b', 'a']);
    expect(found.traces[1].match?.fragments.some((f) => f.hit && /refund/i.test(f.text))).toBe(true);
    expect(state(s)).toEqual({ queued: [], docs: ['a', 'b'] });
    integrity(s);
  });

  it('writes faster than the index wait for it: the queue never holds much more than INDEX_BACKLOG_TRACES', async () => {
    const s = await store();
    const depth = () => Number((rawDb(s).prepare('SELECT COUNT(*) AS n FROM trace_search_queue').get() as { n: number }).n);
    let deepest = 0;
    // Batches below INDEX_INLINE_MIN, which are queued, back to back with no pause for the indexer.
    const size = INDEX_INLINE_MIN - 1;
    const batches = Math.ceil((INDEX_BACKLOG_TRACES * 2) / size);
    for (let b = 0; b < batches; b++) {
      await s.insertTraces(LOCAL_TENANT, Array.from({ length: size }, (_, i) => trace(`b${b}-${i}`, `batch ${b} trace ${i} refund words`, b % 50)));
      deepest = Math.max(deepest, depth());
    }
    expect(batches * size).toBeGreaterThan(INDEX_BACKLOG_TRACES);
    // A write indexes the queue down to the bound before it returns; the bound can be passed by the one batch that crossed it.
    expect(deepest).toBeLessThanOrEqual(INDEX_BACKLOG_TRACES + size);
    expect((await s.queryTraces(LOCAL_TENANT, { search: 'refund', limit: 1 })).total).toBe(batches * size);
    integrity(s);
  });

  it('a search indexes a queue in steps, with other requests answered between them, and finds every trace stored before it', async () => {
    const s = await store();
    // What another process stored and queued and never indexed: several steps' worth (a step starts at BUILD_BATCH traces and at most doubles).
    const n = 300;
    const db = rawDb(s);
    db.exec(`
      WITH RECURSIVE i(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM i WHERE k < ${n})
      INSERT INTO traces (trace_id, agent_name, output, timestamp) SELECT 'q' || k, 'bot', 'queued elsewhere, refund ' || k, '${at(1)}' FROM i;
      INSERT INTO trace_search_queue (trace_id) SELECT trace_id FROM traces;
    `);
    let turns = 0;
    const count = setInterval(() => (turns += 1), 0);
    const found = await s.queryTraces(LOCAL_TENANT, { search: 'refund', limit: 1 });
    clearInterval(count);
    expect(found.total).toBe(n);
    expect(found.search?.complete).toBe(true);
    expect(state(s).queued).toEqual([]);
    expect(turns).toBeGreaterThan(0);
    integrity(s);
  });

  it('an export of a search right after a write holds the queued trace', async () => {
    const s = await store();
    await s.insertTraces(LOCAL_TENANT, [trace('x1', 'exported refund', 1), trace('x2', 'another refund', 2)]);
    expect(state(s).queued).toEqual(['x1', 'x2']);
    const exported: string[] = [];
    for await (const batch of s.exportTraces(LOCAL_TENANT, { search: 'refund', sort_by: 'timestamp', sort_order: 'asc' })) exported.push(...batch.map((r) => r.trace.trace_id));
    expect(exported).toEqual(['x1', 'x2']);
    integrity(s);
  });

  it('a batch of INDEX_INLINE_MIN traces or more is indexed in the transaction that stores it', async () => {
    const s = await store();
    await s.insertTraces(LOCAL_TENANT, [trace('small', 'queued first', 1)]);
    expect(state(s).queued).toEqual(['small']);
    const big = Array.from({ length: INDEX_INLINE_MIN }, (_, i) => trace(`big-${i}`, `one of a large batch ${i}`, 2));
    await s.insertTraces(LOCAL_TENANT, big);
    // The large batch was indexed where it was stored; the small one still waits for the indexer.
    expect(state(s)).toEqual({ queued: ['small'], docs: big.map((t) => t.trace_id) });
    integrity(s);
    expect(await ids(s, 'queued')).toEqual(['small']);
    expect(state(s)).toEqual({ queued: [], docs: [...big.map((t) => t.trace_id), 'small'] });
  });

  it('writes that never pause: the queue stays within INDEX_BACKLOG_TRACES, and a search in the stream finds every trace', async () => {
    const s = await store();
    const depth = () => Number((rawDb(s).prepare('SELECT COUNT(*) AS n FROM trace_search_queue').get() as { n: number }).n);
    // One write a turn of the event loop, never the INDEX_IDLE_MS pause the indexer waits for, past the bound and half again.
    const n = Math.ceil(INDEX_BACKLOG_TRACES * 1.5);
    let deepest = 0;
    for (let i = 0; i < n; i++) {
      await s.insertTraces(LOCAL_TENANT, [trace(`w${i}`, `stream ${i}`, 1)]);
      deepest = Math.max(deepest, depth());
      if (i === INDEX_BACKLOG_TRACES - 10) {
        const found = await s.queryTraces(LOCAL_TENANT, { search: 'stream', limit: 1 });
        expect(found.total).toBe(i + 1);
        expect(found.search?.complete).toBe(true);
      }
      await new Promise((r) => setImmediate(r));
    }
    expect(deepest).toBeLessThanOrEqual(INDEX_BACKLOG_TRACES + 1);
    const found = await s.queryTraces(LOCAL_TENANT, { search: 'stream', limit: 1 });
    expect(found.total).toBe(n);
    expect(found.search?.complete).toBe(true);
    integrity(s);
  });

  it('the indexer takes the queue after the write, without a search', async () => {
    const s = await store();
    await s.insertTraces(LOCAL_TENANT, [trace('a', 'nothing searched for', 1)]);
    expect(state(s).queued).toEqual(['a']);
    const deadline = Date.now() + 10_000;
    while (state(s).queued.length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(state(s)).toEqual({ queued: [], docs: ['a'] });
    integrity(s);
  });

  it('every delete route takes a queued trace off the queue, and its words leave the file', async () => {
    const path = tempDb();
    const s = await store(path);
    const other = asTenantId('acme');
    const secret = (n: number) => `qzxqzxsecret${n}`;
    await s.insertTraces(LOCAL_TENANT, [trace('del', secret(1), 1), trace('hand', secret(2), 2), trace('old', secret(3), 3, { timestamp: '2020-01-01T00:00:00.000Z' }), trace('keep', 'kept words', 4)]);
    await s.insertTraces(other, [trace('purged', secret(4), 5)]);
    expect(state(s).queued).toEqual(['del', 'hand', 'old', 'keep', 'purged']);
    expect(await s.deleteTrace(LOCAL_TENANT, 'del')).toBe(true);
    rawDb(s).prepare("DELETE FROM traces WHERE trace_id = 'hand'").run();
    expect(await s.deleteTracesOlderThan(LOCAL_TENANT, 30)).toBe(1);
    await s.purge(other);
    // Off the queue and never indexed; 'keep' is queued or, if the indexer has run meanwhile, indexed.
    const { queued, docs } = state(s);
    expect([...queued, ...docs]).toEqual(['keep']);
    expect(await ids(s, 'kept')).toEqual(['keep']);
    for (let n = 1; n <= 4; n++) expect(await ids(s, secret(n), n === 4 ? other : LOCAL_TENANT)).toEqual([]);
    integrity(s);
    await s.checkpoint();
    for (let n = 1; n <= 4; n++) {
      expect(holds(path, secret(n)), secret(n)).toBe(false);
      expect(holds(`${path}-wal`, secret(n)), secret(n)).toBe(false);
    }
  });

  it('a trace changed while queued is indexed as it is then, and its delete hands the index exactly those words', async () => {
    const s = await store();
    await s.insertTraces(LOCAL_TENANT, [trace('t', 'first draft of the answer', 1)]);
    expect(await s.updateTraceMetadata(LOCAL_TENANT, 't', { reviewer: 'Grace Hopper' })).toBe(true);
    await s.insertSpan(LOCAL_TENANT, { span_id: 's1', trace_id: 't', name: 'lookup', kind: 'TOOL', status_code: 'OK', start_time: at(1), attributes: { 'gen_ai.tool.call.result': 'parcel marzipan shipped' } });
    rawDb(s).prepare("UPDATE traces SET output = 'final answer, rewritten' WHERE trace_id = 't'").run();
    expect(state(s)).toEqual({ queued: ['t'], docs: [] });
    expect(await ids(s, 'hopper')).toEqual(['t']);
    expect(await ids(s, 'marzipan')).toEqual(['t']);
    expect(await ids(s, 'rewritten')).toEqual(['t']);
    expect(await ids(s, 'draft')).toEqual([]);
    integrity(s);
    // Indexed now: a change goes through the index triggers, and the delete takes out what they put in.
    expect(await s.updateTraceMetadata(LOCAL_TENANT, 't', { reviewer: 'Ada Lovelace' })).toBe(true);
    expect(await ids(s, 'lovelace')).toEqual(['t']);
    expect(await ids(s, 'hopper')).toEqual([]);
    integrity(s);
    expect(await s.deleteTrace(LOCAL_TENANT, 't')).toBe(true);
    expect(state(s)).toEqual({ queued: [], docs: [] });
    integrity(s);
  });

  it('a CJK trace gets its CJK stream when the queue is indexed, and none when it is deleted first', async () => {
    const s = await store();
    await s.insertTraces(LOCAL_TENANT, [trace('zh1', '退款已经批准了', 1), trace('zh2', '鼗鼙鼛鼜不留', 2)]);
    expect(await s.deleteTrace(LOCAL_TENANT, 'zh2')).toBe(true);
    expect(await ids(s, '批准')).toEqual(['zh1']);
    const cjk = rawDb(s).prepare('SELECT COUNT(*) AS n FROM trace_search_cjk_docs').get() as { n: number };
    expect(Number(cjk.n)).toBe(1);
    expect(await ids(s, '鼙鼛')).toEqual([]);
    integrity(s);
  });

  it('close() indexes what the process queued; a start indexes what an earlier process left queued', async () => {
    const path = tempDb();
    const first = await store(path);
    await first.insertTraces(LOCAL_TENANT, [trace('a', 'written by a short-lived ingest', 1)]);
    await first.close();
    open.splice(open.indexOf(first), 1);
    const second = await store(path);
    expect(state(second)).toEqual({ queued: [], docs: ['a'] });

    await second.close();
    open.splice(open.indexOf(second), 1);
    // A process that stopped before close: its trace is stored and its queue row is still there.
    const other = new Database(path);
    other.prepare("INSERT INTO traces (tenant_id, trace_id, agent_name, output, timestamp) VALUES ('local', 'b', 'bot', 'left on the queue', ?)").run(at(2));
    other.prepare("INSERT INTO trace_search_queue (trace_id) VALUES ('b')").run();
    other.close();
    const next = new SqliteAdapter(path, { driver, searchWorker: false });
    await next.initialize();
    open.push(next);
    // Accounted for by the queue: the start does not rebuild the index, it indexes the queue.
    expect(await next.whenSearchIndexReady()).toBe('ready');
    expect(state(next)).toEqual({ queued: [], docs: ['a', 'b'] });
    expect(await ids(next, 'queue')).toEqual(['b']);
  });
});

