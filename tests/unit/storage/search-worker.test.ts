/*
 * Search on a worker thread (#703).
 *
 * The work a search does before its first result cannot be interrupted, and
 * it grows with the store; on the server's thread it held every MCP and HTTP
 * request for as long as it took. A store in a file now searches on a
 * thread of its own, with its own read-only connection. These tests hold it
 * to the same answers as a search on the adapter's own connection, show the
 * event loop stays free while a slow search runs, and walk the thread's
 * life: started on the first search, replaced after a failure or when it
 * stops answering, and closed with the store, leaving no handle on the file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { SearchWorkerClient, SearchWorkerUnavailable } from '../../../src/storage/search-worker-client.js';
import { parseSearch } from '../../../src/storage/search.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { Trace } from '../../../src/types/trace.js';
import { SEARCH_DRIVER } from './fts5-here.js';

const dirs: string[] = [];
const open: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-search-worker-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
}

async function adapter(path: string, options: ConstructorParameters<typeof SqliteAdapter>[1] = {}): Promise<SqliteAdapter> {
  const s = new SqliteAdapter(path, { driver: SEARCH_DRIVER, ...options });
  await s.initialize();
  open.push(s);
  await s.whenSearchIndexReady();
  return s;
}

const workerOf = (s: SqliteAdapter) => (s as unknown as { searchWorker?: SearchWorkerClient }).searchWorker;
const threadOf = (c: SearchWorkerClient) => (c as unknown as { worker?: { terminate(): Promise<number> } }).worker;

const WORDS = ['refund', 'approved', 'denied', 'order', 'shipped', 'escalated', 'café', 'agent', '退款已经批准了', 'kestrel'];
const corpus: Trace[] = Array.from({ length: 120 }, (_, i) => ({
  trace_id: `w-${String(i).padStart(3, '0')}`,
  agent_name: i % 3 ? 'support-bot' : 'sales-bot',
  input: `question ${i} about ${WORDS[i % WORDS.length]}`,
  output: `The agent said ${WORDS[(i * 3) % WORDS.length]} and ${WORDS[(i * 7) % WORDS.length]}.`,
  metadata: { tier: i % 10 === 0 ? 'platinum' : 'standard' },
  timestamp: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
  latency_ms: (i * 37) % 50,
}));

/** Long traces, so reading them all without FTS5 takes hundreds of milliseconds. */
function slowCorpus(n: number): Trace[] {
  const words = Array.from({ length: 3000 }, (_, i) => `w${i.toString(36)}x`);
  let seed = 11;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  return Array.from({ length: n }, (_, i) => ({
    trace_id: `s-${i}`,
    agent_name: 'a',
    input: 'q',
    output: Array.from({ length: 1200 }, () => words[Math.floor(rand() * words.length)]).join(' '),
    timestamp: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString(),
  }));
}

describe('search on a worker thread', () => {
  for (const fts5 of [true, false]) {
    const how = fts5 ? 'with the index' : 'without FTS5';
    it(`answers exactly as a search on the adapter's own connection, ${how}`, async () => {
      const path = tempDb();
      const seeded = await adapter(path, { fts5 });
      await seeded.insertTraces(LOCAL_TENANT, corpus);
      const here = await adapter(path, { fts5, searchWorker: false });
      const cases: Array<Parameters<SqliteAdapter['queryTraces']>[1]> = [
        { search: 'refund' },
        { search: 'refund approved', sort_by: 'timestamp', sort_order: 'asc' },
        { search: '"agent said"', limit: 7, offset: 5 },
        { search: 'esc* order', sort_by: 'latency_ms' },
        { search: '批准' },
        { search: 'platinum', filter: { agent_name: 'sales-bot' } },
        { search: 'nothingmatches' },
      ];
      for (const c of cases) {
        const a = await seeded.queryTraces(LOCAL_TENANT, c);
        const b = await here.queryTraces(LOCAL_TENANT, c);
        expect(a, JSON.stringify(c)).toEqual(b);
      }
      expect(workerOf(seeded)?.started).toBe(1);
      expect(workerOf(here)).toBeUndefined();
    });
  }

  it('is not started until the first search, and never for a store in memory', async () => {
    const s = await adapter(tempDb());
    await s.insertTraces(LOCAL_TENANT, corpus.slice(0, 5));
    await s.queryTraces(LOCAL_TENANT, {});
    expect(workerOf(s)).toBeUndefined();
    await s.queryTraces(LOCAL_TENANT, { search: 'refund' });
    expect(workerOf(s)?.started).toBe(1);

    const mem = await adapter(':memory:');
    await mem.insertTraces(LOCAL_TENANT, corpus.slice(0, 5));
    expect((await mem.queryTraces(LOCAL_TENANT, { search: 'refund' })).search?.complete).toBe(true);
    expect(workerOf(mem)).toBeUndefined();
  });

  it('sees a trace written a moment before the search', async () => {
    const s = await adapter(tempDb());
    await s.queryTraces(LOCAL_TENANT, { search: 'refund' });
    for (let i = 0; i < 5; i += 1) {
      await s.insertTraces(LOCAL_TENANT, [{ trace_id: `fresh-${i}`, agent_name: 'a', output: `zebra${i} arrived`, timestamp: new Date().toISOString() }]);
      expect((await s.queryTraces(LOCAL_TENANT, { search: `zebra${i}` })).traces.map((t) => t.trace_id)).toEqual([`fresh-${i}`]);
    }
  });

  it('keeps the event loop free while a slow search runs', async () => {
    const path = tempDb();
    const seed = await adapter(path, { fts5: false });
    await seed.insertTraces(LOCAL_TENANT, slowCorpus(600));
    const onWorker = await adapter(path, { fts5: false, searchBudgetMs: 60_000 });
    const onThread = await adapter(path, { fts5: false, searchBudgetMs: 60_000, searchWorker: false });
    // Start the thread first: a thread starting is not what is measured.
    await onWorker.queryTraces(LOCAL_TENANT, { search: 'w0x', filter: { agent_name: 'nobody' } });

    /** The longest the event loop went without running a 1 ms timer while `run` was awaited. */
    async function longestStall(run: () => Promise<unknown>): Promise<{ stall: number; took: number }> {
      let last = performance.now();
      let stall = 0;
      const tick = setInterval(() => {
        const now = performance.now();
        stall = Math.max(stall, now - last);
        last = now;
      }, 1);
      const t0 = performance.now();
      await run();
      const took = performance.now() - t0;
      await new Promise((r) => setTimeout(r, 5));
      clearInterval(tick);
      stall = Math.max(stall, performance.now() - last);
      return { stall, took };
    }
    const thread = await longestStall(() => onThread.queryTraces(LOCAL_TENANT, { search: 'w1x w2x' }));
    const worker = await longestStall(() => onWorker.queryTraces(LOCAL_TENANT, { search: 'w1x w2x' }));
    // On the adapter's thread the loop is held for the whole search; on the worker, for a small part of it.
    expect(thread.stall, `the search on this thread took ${thread.took.toFixed(0)} ms`).toBeGreaterThan(thread.took * 0.8);
    expect(worker.stall, `the worker's search took ${worker.took.toFixed(0)} ms and held the loop ${worker.stall.toFixed(0)} ms`).toBeLessThan(worker.took / 4);
  }, 60_000);

  it('starts a new thread after one fails, and fails only the search it was running', async () => {
    const path = tempDb();
    const seed = await adapter(path, { fts5: false });
    await seed.insertTraces(LOCAL_TENANT, slowCorpus(300));
    const s = await adapter(path, { fts5: false, searchBudgetMs: 60_000 });
    await s.queryTraces(LOCAL_TENANT, { search: 'w0x', filter: { agent_name: 'nobody' } });
    const client = workerOf(s)!;
    // Idle and gone: the next search starts another.
    await threadOf(client)!.terminate();
    expect((await s.queryTraces(LOCAL_TENANT, { search: 'w0x' })).search?.complete).toBe(true);
    expect(client.started).toBe(2);
    // Gone in the middle of a search: that search fails, naming why; the next one works.
    const running = s.queryTraces(LOCAL_TENANT, { search: 'w1x w2x' });
    await new Promise((r) => setTimeout(r, 20));
    await threadOf(client)!.terminate();
    await expect(running).rejects.toThrow(/the search thread stopped/);
    expect((await s.queryTraces(LOCAL_TENANT, { search: 'w0x' })).total).toBeGreaterThan(0);
    expect(client.started).toBe(3);
  }, 60_000);

  it('a delete during a search does not wait for it, and its text still leaves the file once the search ends', async () => {
    const path = tempDb();
    const s = await adapter(path, { fts5: false, searchBudgetMs: 60_000 });
    await s.insertTraces(LOCAL_TENANT, slowCorpus(600));
    const secret = 'DELETEDURINGSEARCH99';
    await s.insertTraces(LOCAL_TENANT, [{ trace_id: 'secret', agent_name: 'a', output: `the key is ${secret}`, timestamp: '2026-09-28T00:00:00.000Z' }]);
    await s.checkpoint();
    await s.queryTraces(LOCAL_TENANT, { search: 'w0x', filter: { agent_name: 'nobody' } });
    const holds = (file: string) => existsSync(file) && readFileSync(file).includes(Buffer.from(secret));
    expect(holds(path)).toBe(true);

    const t0 = performance.now();
    const search = s.queryTraces(LOCAL_TENANT, { search: 'w1x w2x' });
    await new Promise((r) => setTimeout(r, 30));
    const d0 = performance.now();
    expect(await s.deleteTrace(LOCAL_TENANT, 'secret')).toBe(true);
    const deleteMs = performance.now() - d0;
    await search;
    const searchMs = performance.now() - t0;
    // The delete returned while the search was still reading: it did not wait for the reader to let go.
    expect(deleteMs, `delete took ${deleteMs.toFixed(0)} ms, the search ${searchMs.toFixed(0)} ms`).toBeLessThan(searchMs / 2);
    for (let i = 0; i < 100 && (holds(path) || holds(`${path}-wal`)); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(holds(path)).toBe(false);
    expect(holds(`${path}-wal`)).toBe(false);
  }, 60_000);

  it('closes its connection with the store: the file can be removed at once, and no thread is left', async () => {
    const path = tempDb();
    const s = new SqliteAdapter(path, { driver: SEARCH_DRIVER });
    await s.initialize();
    await s.insertTraces(LOCAL_TENANT, corpus);
    await s.queryTraces(LOCAL_TENANT, { search: 'refund' });
    const client = workerOf(s)!;
    const thread = threadOf(client) as unknown as { threadId: number; once(e: 'exit', f: () => void): void };
    const exited = new Promise<void>((r) => thread.once('exit', r));
    await s.close();
    await exited;
    // Windows refuses to delete a file any connection still holds.
    rmSync(join(path, '..'), { recursive: true, force: false });
    dirs.splice(dirs.indexOf(join(path, '..')), 1);
  });
});

describe('SearchWorkerClient', () => {
  const plan = { whereClause: "WHERE tenant_id = ?", params: ['local'], filtered: false, sortBy: 'relevance', sortOrder: 'desc', limit: 50, offset: 0 };
  const driver = SEARCH_DRIVER;

  it('answers a thread that does not answer in time as stopped with nothing read, and replaces it', async () => {
    const path = tempDb();
    const seed = await adapter(path, { fts5: false });
    await seed.insertTraces(LOCAL_TENANT, slowCorpus(300));
    const client = new SearchWorkerClient({ path, driver, busyTimeoutMs: 5000 }, 0);
    try {
      // No budget and no grace: the thread is judged stuck before it can answer.
      const r = await client.search({ tenantId: 'local', parsed: parseSearch('w1x'), plan, index: 'scan', budgetMs: 0 });
      expect(r).toEqual({ total: 0, pageIds: [], matches: [], complete: false });
      expect(client.started).toBe(1);
    } finally {
      await client.close();
    }
  }, 60_000);

  it('reports a thread that cannot open the file as unavailable, so the caller can search itself', async () => {
    const client = new SearchWorkerClient({ path: join(tmpdir(), 'iris-no-such-dir', 'missing.db'), driver, busyTimeoutMs: 5000 });
    try {
      await expect(client.search({ tenantId: 'local', parsed: parseSearch('refund'), plan, index: 'scan', budgetMs: 1000 })).rejects.toBeInstanceOf(SearchWorkerUnavailable);
    } finally {
      await client.close();
    }
  });
});
