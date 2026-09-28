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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Worker } from 'node:worker_threads';
import { SqliteAdapter, BUSY_TIMEOUT_MS } from '../../../src/storage/sqlite-adapter.js';
import { SearchWorkerClient, SearchWorkerUnavailable, resetSearchWorkerWarning } from '../../../src/storage/search-worker-client.js';
import { buildHealth } from '../../../src/health.js';
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

/*
 * A search that is held open until the test lets it go (#703). Timing a
 * slow search against something else made these tests depend on how busy
 * the machine was. Instead, a stand-in thread (the adapter's tests-only
 * searchWorkerEntry) opens the store read-only with node:sqlite, and on a
 * search begins a read transaction, reads, says `held`, and stays in it:
 * SQLite sees a reader holding the file exactly as it would during a long
 * search. `release` ends the transaction and answers the search with an
 * empty page.
 */
function heldSearchEntry(): URL {
  const dir = mkdtempSync(join(tmpdir(), 'iris-search-worker-held-'));
  dirs.push(dir);
  const file = join(dir, 'held.mjs');
  writeFileSync(
    file,
    [
      "import { parentPort, workerData } from 'node:worker_threads';",
      "import { DatabaseSync } from 'node:sqlite';",
      'const db = new DatabaseSync(workerData.path, { readOnly: true });',
      'let held;',
      "parentPort.postMessage({ type: 'ready' });",
      "parentPort.on('message', (msg) => {",
      "  if (msg.type === 'close') { db.close(); parentPort.close(); return; }",
      "  if (msg.type === 'release') { db.exec('COMMIT'); parentPort.postMessage({ id: held, result: { total: 0, pageIds: [], matches: [], complete: true } }); return; }",
      '  held = msg.id;',
      "  db.exec('BEGIN');",
      "  db.prepare('SELECT count(*) AS n FROM traces').get();",
      "  parentPort.postMessage({ type: 'held' });",
      '});',
    ].join('\n'),
  );
  return pathToFileURL(file);
}

/** Start a search on a store whose thread is heldSearchEntry's, and resolve once the thread holds it; `release` lets it answer. */
async function holdSearch(s: SqliteAdapter): Promise<{ search: Promise<unknown>; release: () => void; thread: Worker }> {
  const search = s.queryTraces(LOCAL_TENANT, { search: 'anything' });
  const thread = threadOf(workerOf(s)!) as unknown as Worker;
  await new Promise<void>((resolve) => {
    const onMessage = (msg: { type?: string }) => {
      if (msg.type !== 'held') return;
      thread.off('message', onMessage);
      resolve();
    };
    thread.on('message', onMessage);
  });
  return { search, release: () => thread.postMessage({ type: 'release' }), thread };
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

  it('keeps the event loop free while a search runs on the worker, where on the adapter\'s thread it holds it throughout', async () => {
    const path = tempDb();
    const seed = await adapter(path);
    await seed.insertTraces(LOCAL_TENANT, corpus);

    // On the adapter's thread: not one turn of the event loop passes between asking and the answer.
    const onThread = await adapter(path, { searchWorker: false });
    let turns = 0;
    const count = setInterval(() => (turns += 1), 0);
    await onThread.queryTraces(LOCAL_TENANT, { search: 'refund approved' });
    clearInterval(count);
    expect(turns).toBe(0);

    // On the worker, held open: timers fire and another request is answered while the search is still unanswered.
    const onWorker = await adapter(path, { searchWorkerEntry: heldSearchEntry() });
    const held = await holdSearch(onWorker);
    let answered = false;
    void held.search.then(() => (answered = true));
    await new Promise((r) => setTimeout(r, 0));
    expect((await onWorker.queryTraces(LOCAL_TENANT, { limit: 5 })).total).toBe(corpus.length);
    expect(answered).toBe(false);
    held.release();
    await held.search;
    expect(answered).toBe(true);
  });
  it('starts a new thread after one fails, and fails only the search it was running', async () => {
    const path = tempDb();
    const seed = await adapter(path);
    await seed.insertTraces(LOCAL_TENANT, corpus);
    const s = await adapter(path);
    await s.queryTraces(LOCAL_TENANT, { search: 'refund' });
    const client = workerOf(s)!;
    // Idle and gone: the next search starts another.
    await threadOf(client)!.terminate();
    expect((await s.queryTraces(LOCAL_TENANT, { search: 'refund' })).search?.complete).toBe(true);
    expect(client.started).toBe(2);

    // Gone while it holds a search: that search fails, naming why; the next one works on a new thread.
    const heldStore = await adapter(path, { searchWorkerEntry: heldSearchEntry() });
    const held = await holdSearch(heldStore);
    const outcome = held.search.then(
      () => undefined,
      (err: Error) => err,
    );
    await held.thread.terminate();
    expect((await outcome)?.message).toMatch(/the search thread stopped/);
    const again = await holdSearch(heldStore);
    expect(workerOf(heldStore)!.started).toBe(2);
    again.release();
    expect(await again.search).toMatchObject({ total: 0, search: { complete: true } });
  });
  it('a delete during a search does not wait for it, and its text still leaves the file once the search ends', async () => {
    const path = tempDb();
    const s = await adapter(path, { searchWorkerEntry: heldSearchEntry() });
    await s.insertTraces(LOCAL_TENANT, corpus);
    const secret = 'DELETEDURINGSEARCH99';
    await s.insertTraces(LOCAL_TENANT, [{ trace_id: 'secret', agent_name: 'a', output: `the key is ${secret}`, timestamp: '2026-09-28T00:00:00.000Z' }]);
    await s.checkpoint();
    const holds = (file: string) => existsSync(file) && readFileSync(file).includes(Buffer.from(secret));
    expect(holds(path)).toBe(true);

    const held = await holdSearch(s);
    let answered = false;
    void held.search.then(() => (answered = true));
    const d0 = performance.now();
    expect(await s.deleteTrace(LOCAL_TENANT, 'secret')).toBe(true);
    const deleteMs = performance.now() - d0;
    /*
     * The delete returned while the search was still held open, and the
     * search cannot finish until this test releases it. A checkpoint that
     * waited for that reader could not have ended before its busy timeout
     * (BUSY_TIMEOUT_MS, 5 s): nothing would release the reader while it
     * waited. So the bound below is not a race between two timings; any
     * delete that did not wait is far inside it.
     */
    expect(answered).toBe(false);
    expect(deleteMs, `delete_trace took ${deleteMs.toFixed(0)} ms while a reader held the file`).toBeLessThan(BUSY_TIMEOUT_MS / 2);
    // The reader holds the old pages in place: the text is still in the file, and leaves it once the reader does.
    expect(holds(path)).toBe(true);
    held.release();
    await held.search;
    for (let i = 0; i < 250 && (holds(path) || holds(`${path}-wal`)); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(holds(path)).toBe(false);
    expect(holds(`${path}-wal`)).toBe(false);
  });
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

describe('a search worker that cannot start', () => {
  afterEach(() => resetSearchWorkerWarning());

  /** A thread that fails as it loads, as one refused its driver would, before it can say it is ready. */
  function failingEntry(): URL {
    const dir = mkdtempSync(join(tmpdir(), 'iris-search-worker-entry-'));
    dirs.push(dir);
    const file = join(dir, 'refuses.mjs');
    writeFileSync(file, "throw new Error('the driver was refused on this machine');\n");
    return pathToFileURL(file);
  }

  it('searches on the main thread, warns once per process with the reason, and says so in /health', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const entry = failingEntry();
      const a = await adapter(tempDb(), { searchWorkerEntry: entry });
      await a.insertTraces(LOCAL_TENANT, corpus);
      expect(a.searchWorkerStatus()).toEqual({ status: 'not_started', detail: 'not started: it starts with the first search' });
      const here = await adapter(tempDb(), { searchWorker: false });
      await here.insertTraces(LOCAL_TENANT, corpus);
      // The fallback keeps the answer the same.
      expect(await a.queryTraces(LOCAL_TENANT, { search: 'refund approved' })).toEqual(await here.queryTraces(LOCAL_TENANT, { search: 'refund approved' }));
      const unavailable = {
        status: 'unavailable',
        detail: 'unavailable (the driver was refused on this machine), searches run on the main thread',
      };
      expect(a.searchWorkerStatus()).toEqual(unavailable);
      // No new thread per search once one could not start.
      await a.queryTraces(LOCAL_TENANT, { search: 'refund' });
      expect(workerOf(a)).toBeUndefined();

      // A second store in the same process that cannot start one either: the warning is not repeated.
      const b = await adapter(tempDb(), { searchWorkerEntry: entry });
      await b.queryTraces(LOCAL_TENANT, { search: 'refund' });
      expect(b.searchWorkerStatus().status).toBe('unavailable');
      const warnings = lines.filter((l) => l.includes('search worker could not start'));
      expect(warnings).toEqual([
        '[iris.storage] The search worker could not start (the driver was refused on this machine); searches run on the main thread, where a slow one holds other requests while it runs.\n',
      ]);

      const health = await buildHealth({ storage: a, version: 'test' });
      expect(health.status).toBe(200);
      expect(health.body.status).toBe('ok');
      expect(health.body.search_worker).toEqual(unavailable);
    } finally {
      spy.mockRestore();
    }
  });

  it('health reports a ready worker, one not started yet, and a store in memory', async () => {
    const s = await adapter(tempDb());
    expect((await buildHealth({ storage: s })).body.search_worker).toEqual({ status: 'not_started', detail: 'not started: it starts with the first search' });
    await s.queryTraces(LOCAL_TENANT, { search: 'refund' });
    expect((await buildHealth({ storage: s })).body.search_worker).toEqual({ status: 'ready', detail: 'ready: searches run on their own thread' });
    const mem = await adapter(':memory:');
    expect((await buildHealth({ storage: mem })).body.search_worker).toEqual({ status: 'not_used', detail: 'not used: a store in memory searches on the main thread' });
    expect((await buildHealth({})).body.search_worker).toBeNull();
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

  it('closes without waiting for a thread inside one long SQLite statement, which terminate() cannot stop', async () => {
    // A thread that, asked to search, says it has started and runs one long statement in C, so it cannot hear the close message.
    const dir = mkdtempSync(join(tmpdir(), 'iris-search-worker-slow-'));
    dirs.push(dir);
    const file = join(dir, 'slow.mjs');
    writeFileSync(
      file,
      [
        "import { parentPort } from 'node:worker_threads';",
        "import { DatabaseSync } from 'node:sqlite';",
        "const db = new DatabaseSync(':memory:');",
        "parentPort.postMessage({ type: 'ready' });",
        "parentPort.on('message', (msg) => {",
        "  if (msg.type === 'close') { db.close(); parentPort.close(); return; }",
        "  parentPort.postMessage({ type: 'started' });",
        // 20 million rows counted in one statement: 3.6 s on the machine in the changelog, and many times the 200 ms close timeout anywhere.
        // (SQLite fixes 'now' for the length of a statement, so a statement that waits on the clock never ends.)
        "  db.prepare('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000000) SELECT count(*) FROM n').get();",
        "  parentPort.postMessage({ id: msg.id, result: { total: 0, pageIds: [], matches: [], complete: true } });",
        '});',
      ].join('\n'),
    );
    const client = new SearchWorkerClient({ path: 'unused', driver, busyTimeoutMs: 5000 }, 60_000, pathToFileURL(file), 200);
    // Settled into a value at once, so the rejection close() causes is never unhandled.
    const running = client.search({ tenantId: 'local', parsed: parseSearch('refund'), plan, index: 'scan', budgetMs: 60_000 }).then(
      () => undefined,
      (err: Error) => err,
    );
    const thread = threadOf(client) as unknown as Worker;
    let exited = false;
    thread.once('exit', () => (exited = true));
    await new Promise<void>((resolve) => {
      const onMessage = (msg: { type?: string }) => {
        if (msg.type !== 'started') return;
        thread.off('message', onMessage);
        resolve();
      };
      thread.on('message', onMessage);
    });
    await client.close();
    // close() returned while the thread was still inside its statement: it did not wait for the statement to end.
    expect(exited).toBe(false);
    expect((await running)?.message).toBe('the store is closed');
    // The thread still ends, when its statement does.
    await new Promise<void>((resolve) => (exited ? resolve() : thread.once('exit', () => resolve())));
    expect(exited).toBe(true);
  }, 30_000);
  it('reports a thread that cannot open the file as unavailable, so the caller can search itself', async () => {
    const client = new SearchWorkerClient({ path: join(tmpdir(), 'iris-no-such-dir', 'missing.db'), driver, busyTimeoutMs: 5000 });
    try {
      await expect(client.search({ tenantId: 'local', parsed: parseSearch('refund'), plan, index: 'scan', budgetMs: 1000 })).rejects.toBeInstanceOf(SearchWorkerUnavailable);
    } finally {
      await client.close();
    }
  });
});
