/*
 * Work that grows with the store runs in steps, never as one statement
 * (search-index.ts, never holding the event loop).
 *
 * The retention sweep deletes a few traces per transaction and then merges
 * the index in steps, with the event loop turning between them; it can be
 * stopped by close() at any step and finishes on the next sweep or start,
 * and every route leaves none of the swept words in the file. An index
 * retired at the start (#695) is erased a bounded number of rows at a time
 * before the rebuild indexes anything, with a one-statement fallback for a
 * connection that refuses the writes. And the build says what it is doing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { openDriver, type Driver } from '../../../src/storage/driver.js';
import { deleteOwingMerge, eraseRetiredStep, levelMergeStep, mergeOwedStep, nextStepSize, retiredRemain, sweepEraseMode, ERASE_OWED_TABLE, SEARCH_FILTER_INDEX, STEP_TARGET_MS } from '../../../src/storage/search-index.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { Trace } from '../../../src/types/trace.js';
import { SEARCH_DRIVER } from './fts5-here.js';

// File-backed stores, several opens per test (see trace-search.test.ts).
vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
const open: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-steps-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
}

type Log = Array<['info' | 'warn', string]>;

function store(path: string, options: { fts5?: boolean; log?: Log } = {}): SqliteAdapter {
  const s = new SqliteAdapter(path, { driver: SEARCH_DRIVER, ...(options.fts5 === false ? { fts5: false } : {}), ...(options.log ? { log: (level, line) => void options.log!.push([level, line]) } : {}) });
  open.push(s);
  return s;
}

async function started(path: string, options: { fts5?: boolean; log?: Log } = {}): Promise<SqliteAdapter> {
  const s = store(path, options);
  await s.initialize();
  await s.whenIdle();
  return s;
}

async function closed(s: SqliteAdapter): Promise<void> {
  await s.close();
  open.splice(open.indexOf(s), 1);
}

const dbOf = (s: SqliteAdapter) => (s as unknown as { db: Driver }).db;
/** Where a word left on disk is, and the checkpoint worker's state: the message when an erasure assertion fails. */
const residue = (s: SqliteAdapter, path: string, word: string): string => {
  const w = (s as unknown as { checkpointer?: { active: boolean; stopped: string; truncateInProgress: boolean } }).checkpointer;
  const has = (file: string) => existsSync(file) && readFileSync(file).includes(Buffer.from(word));
  return JSON.stringify({ inDb: has(path), inWal: has(`${path}-wal`), walBytes: existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`).length : -1, worker: w ? { active: w.active, stopped: w.stopped, truncating: w.truncateInProgress } : null, retrying: (s as unknown as { eraseRetry?: unknown }).eraseRetry !== undefined, passive: dbOf(s).pragma('wal_checkpoint(PASSIVE)') });
};
const fileHolds = (path: string, needle: string): boolean => existsSync(path) && readFileSync(path).includes(needle);
/** Whether the word is in iris.db or its WAL. FTS5 stores a term after the prefix it shares with the term before it, so look for its tail. */
const onDisk = (path: string, word: string) => fileHolds(path, word.slice(4)) || fileHolds(`${path}-wal`, word.slice(4));
const OLD = '2020-01-01T00:00:00.000Z';
const recent = () => new Date().toISOString();

/** `n` traces, the old ones carrying `word`: what a retention sweep of 30 days removes. */
function traces(n: number, old: number, word: string): Trace[] {
  return Array.from({ length: n }, (_, i) => ({
    trace_id: `t-${i}`,
    agent_name: 'a',
    input: `question ${i} about an order`,
    output: i < old ? `record ${i} holds ${word} and more text` : `record ${i} is ordinary text about the order`,
    timestamp: i < old ? OLD : recent(),
  }));
}

/** FTS5's own integrity-check on both indexes (the words, and the CJK stream), and the id table against the traces. */
function integrity(s: SqliteAdapter): void {
  dbOf(s).exec("INSERT INTO trace_search (trace_search, rank) VALUES ('integrity-check', 0)");
  dbOf(s).exec("INSERT INTO trace_search_cjk (trace_search_cjk, rank) VALUES ('integrity-check', 0)");
  const row = dbOf(s).prepare('SELECT (SELECT COUNT(*) FROM traces) AS traces, (SELECT COUNT(*) FROM trace_search_docs) AS docs').get() as { traces: number; docs: number };
  expect(Number(row.docs)).toBe(Number(row.traces));
}

const owed = (s: SqliteAdapter) => Number((dbOf(s).prepare(`SELECT COUNT(*) AS n FROM ${ERASE_OWED_TABLE}`).get() as { n: number }).n);

/** Counts the event loop's turns until `work` settles. */
async function turnsDuring<T>(work: Promise<T>): Promise<{ value: T; turns: number }> {
  let turns = 0;
  let stop = false;
  const tick = () => {
    if (stop) return;
    turns += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  const value = await work;
  stop = true;
  return { value, turns };
}

describe('the retention sweep runs in steps', () => {
  it('deletes in steps with the event loop turning between them, then merges the index and leaves none of the swept words', async () => {
    const path = tempDb();
    const s = await started(path);
    const word = 'qazwsxedcrfvtgbyhnujmikolp';
    await s.insertTraces(LOCAL_TENANT, traces(600, 300, word));
    await s.checkpoint();
    expect(onDisk(path, word)).toBe(true);
    // Half the index is going: the sweep deletes with secure-delete off and merges afterwards.
    expect(sweepEraseMode(300, 600)).toBe('merge');

    const { value, turns } = await turnsDuring(s.deleteTracesOlderThan(LOCAL_TENANT, 30));
    expect(value).toBe(300);
    // Steps start at one trace and at most double: 300 traces take at least nine, and the loop turned between each.
    expect(turns).toBeGreaterThanOrEqual(8);
    expect(owed(s)).toBe(0);
    await s.checkpoint();
    expect(onDisk(path, word), residue(s, path, word)).toBe(false);
    integrity(s);
    expect((await s.queryTraces(LOCAL_TENANT, { search: word })).total).toBe(0);
    expect((await s.queryTraces(LOCAL_TENANT, { search: 'ordinary' })).total).toBe(300);
    // secure-delete is back on for the deletes that follow, and automerge (off inside each step) back at FTS5's default.
    const config = (k: string) => Number((dbOf(s).prepare('SELECT v FROM trace_search_config WHERE k = ?').get(k) as { v: number }).v);
    expect(config('secure-delete')).toBe(1);
    expect(config('automerge')).toBe(4);
  });

  it('a small sweep erases each trace as it deletes it, and owes no merge', async () => {
    const path = tempDb();
    const s = await started(path);
    const word = 'plokijuhygtfrdeswaqzxcvbnm';
    await s.insertTraces(LOCAL_TENANT, traces(400, 2, word));
    expect(sweepEraseMode(2, 400)).toBe('rows');
    expect(await s.deleteTracesOlderThan(LOCAL_TENANT, 30)).toBe(2);
    expect(owed(s)).toBe(0);
    await s.checkpoint();
    expect(onDisk(path, word), residue(s, path, word)).toBe(false);
    integrity(s);
  });

  it('close() stops a sweep at its next step; the next start finishes the merge it owed, and the next sweep deletes the rest', async () => {
    const path = tempDb();
    const first = await started(path);
    const word = 'mjuhnbgtrfvcdewsxzaqplokiy';
    await first.insertTraces(LOCAL_TENANT, traces(600, 300, word));
    const sweep = first.deleteTracesOlderThan(LOCAL_TENANT, 30);
    await closed(first);
    // The first step (one trace) ran before close(); the sweep stopped at the next.
    expect(await sweep).toBe(1);

    // That trace's words were deleted with secure-delete off: they are still in the index's pages, and a merge is owed.
    const raw = openDriver(path, { driver: SEARCH_DRIVER });
    expect(Number((raw.prepare(`SELECT COUNT(*) AS n FROM ${ERASE_OWED_TABLE}`).get() as { n: number }).n)).toBeGreaterThan(0);
    expect(Number((raw.prepare('SELECT COUNT(*) AS n FROM traces').get() as { n: number }).n)).toBe(599);
    raw.close();

    const next = store(path);
    await next.initialize();
    // The start does not wait for the merge; it runs after.
    expect(owed(next)).toBeGreaterThan(0);
    await next.whenIdle();
    expect(owed(next)).toBe(0);
    expect(await next.deleteTracesOlderThan(LOCAL_TENANT, 30)).toBe(299);
    await next.checkpoint();
    expect(onDisk(path, word), residue(next, path, word)).toBe(false);
    integrity(next);
  });

  it('the swept words are on disk until the merge a sweep owes is done, and gone after it', async () => {
    const path = tempDb();
    const first = await started(path);
    const word = 'zaqxswcdevfrbgtnhymjukilop';
    await first.insertTraces(LOCAL_TENANT, traces(300, 150, word));
    // A sweep's deletes, done the way its steps do them, and the server closed before any merge step ran.
    const db = dbOf(first);
    expect(db.transaction(() => deleteOwingMerge(db, () => db.prepare('DELETE FROM traces WHERE timestamp < ?').run('2021-01-01T00:00:00.000Z').changes)).immediate()).toBe(150);
    await closed(first);
    const raw = openDriver(path, { driver: SEARCH_DRIVER });
    raw.pragma('wal_checkpoint(TRUNCATE)');
    raw.close();
    // Anti-theater: the rows are gone and zeroed, but the index's older segments still hold the word.
    expect(onDisk(path, word)).toBe(true);

    const next = await started(path);
    expect(owed(next)).toBe(0);
    await next.checkpoint();
    expect(onDisk(path, word), residue(next, path, word)).toBe(false);
    integrity(next);
  });

  it('the evaluation sweep deletes in steps too', async () => {
    const s = await started(tempDb());
    const at = OLD;
    const db = dbOf(s);
    const insert = db.prepare("INSERT INTO eval_results (id, tenant_id, eval_type, output_text, score, passed, rule_results, suggestions, created_at) VALUES (?, 'local', 'completeness', 'x', 1, 1, '[]', '[]', ?)");
    db.transaction(() => {
      for (let i = 0; i < 2000; i += 1) insert.run(`e-${i}`, i < 1500 ? at : recent());
    })();
    const { value, turns } = await turnsDuring(s.deleteEvalResultsOlderThan(LOCAL_TENANT, 30));
    expect(value).toBe(1500);
    expect(turns).toBeGreaterThanOrEqual(2);
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM eval_results').get() as { n: number }).n)).toBe(500);
  });
});

describe('an index retired at the start is erased in steps (#695)', () => {
  /**
   * A file whose index a start without FTS5 left without its triggers, with
   * one trace deleted by hand meanwhile: its words are then only in the old
   * index's pages, which the rebuild must erase.
   */
  async function retiredFile(word: string): Promise<string> {
    const path = tempDb();
    const s = await started(path);
    await s.insertTraces(LOCAL_TENANT, [
      ...traces(800, 0, word),
      { trace_id: 'gone', agent_name: 'a', output: `the only trace with ${word}`, timestamp: recent() },
      // One trace in the CJK stream, so both indexes are retired and rebuilt.
      { trace_id: 'cjk', agent_name: 'a', output: '退款已经批准了', timestamp: recent() },
    ]);
    await closed(s);
    const degraded = await started(path, { fts5: false });
    expect(await degraded.deleteTrace(LOCAL_TENANT, 'gone')).toBe(true);
    await degraded.checkpoint();
    await closed(degraded);
    expect(onDisk(path, word)).toBe(true);
    return path;
  }

  const rowsLeft = (db: Driver) =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'trace_search%retired%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'").all() as Array<{ name: string }>).reduce(
      (sum, { name }) => sum + Number((db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n),
      0,
    );

  it('each step deletes at most the rows it is given, zeroing what it frees, and the last drops the emptied tables', async () => {
    const word = 'wsxedcrfvtgbyhnujmikolpqaz';
    const path = await retiredFile(word);
    // Retire it, and close before the build's first step.
    const s = store(path);
    await s.initialize();
    await closed(s);

    const db = openDriver(path, { driver: SEARCH_DRIVER });
    db.pragma('secure_delete = ON');
    try {
      expect(retiredRemain(db)).toBe(true);
      let steps = 0;
      for (let left = rowsLeft(db); ; steps += 1) {
        const more = eraseRetiredStep(db, 16);
        const now = retiredRemain(db) ? rowsLeft(db) : 0;
        if (more) expect(left - now).toBeLessThanOrEqual(16);
        left = now;
        if (!more) break;
      }
      expect(steps).toBeGreaterThan(3);
      expect(retiredRemain(db)).toBe(false);
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    expect(onDisk(path, word)).toBe(false);
  });

  it('the rebuild erases it before indexing, a trace deleted while it was retired leaves none of its words, and FTS5’s integrity-check passes on both indexes', async () => {
    const word = 'edcrfvtgbyhnujmikolpqazwsx';
    const path = await retiredFile(word);
    const log: Log = [];
    const s = store(path, { log });
    await s.initialize();
    expect(retiredRemain(dbOf(s))).toBe(true);
    // Both indexes were retired: the words and the CJK stream.
    const retired = (dbOf(s).prepare("SELECT name FROM sqlite_master WHERE name IN ('trace_search_retired', 'trace_search_cjk_retired')").all() as Array<{ name: string }>).map((r) => r.name).sort();
    expect(retired).toEqual(['trace_search_cjk_retired', 'trace_search_retired']);
    const { value, turns } = await turnsDuring(s.whenSearchIndexReady());
    expect(value).toBe('ready');
    expect(turns).toBeGreaterThan(3);
    expect(retiredRemain(dbOf(s))).toBe(false);
    await s.checkpoint();
    expect(onDisk(path, word), residue(s, path, word)).toBe(false);
    integrity(s);
    expect((await s.queryTraces(LOCAL_TENANT, { search: 'ordinary' })).total).toBe(800);
    expect((await s.queryTraces(LOCAL_TENANT, { search: '批准' })).traces.map((t) => t.trace_id)).toEqual(['cjk']);
    expect(log[0]).toEqual(['info', expect.stringMatching(/^Search index: erasing the previous index, then indexing 801 of 801 stored trace\(s\) in the background/)]);
    expect(log.filter(([level]) => level === 'warn')).toEqual([]);
  });

  it('a connection that refuses writes to the shadow tables drops it in one statement, and says so; FTS5’s integrity-check passes on both indexes', async () => {
    const word = 'rfvtgbyhnujmikolpqazwsxedc';
    const path = await retiredFile(word);
    const log: Log = [];
    const s = store(path, { log });
    // What a connection in defensive mode with no way to turn it off answers.
    dbOf(s).writeShadowTables = () => {
      throw new Error('table trace_search_retired_data may not be modified');
    };
    await s.initialize();
    expect(await s.whenSearchIndexReady()).toBe('ready');
    expect(log).toContainEqual(['warn', expect.stringMatching(/dropped in one statement/)]);
    expect(retiredRemain(dbOf(s))).toBe(false);
    await s.checkpoint();
    expect(onDisk(path, word), residue(s, path, word)).toBe(false);
    integrity(s);
  });
});

describe('step sizes stay under the bound', () => {
  it('a step is sized to STEP_TARGET_MS from the work the last one did, and grows by at most half', () => {
    expect(STEP_TARGET_MS).toBe(35);
    // 100 traces in 70 ms: 50 next.
    expect(nextStepSize(100, 70, [8, 1024])).toBe(50);
    // 100 in 10 ms would scale to 350: at most 150.
    expect(nextStepSize(100, 10, [8, 1024])).toBe(150);
    // By what it did, not what it was allowed: a merge that wrote 20 rows of a 512-page budget in 1 ms grows from 20.
    expect(nextStepSize(20, 1, [16, 512])).toBe(30);
    // Within the range.
    expect(nextStepSize(10, 1000, [8, 1024])).toBe(8);
    expect(nextStepSize(1000, 1, [8, 1024])).toBe(1024);
  });

  it('the build turns automerge off in its steps and merges the levels in steps of its own: nothing is left to merge, automerge is back at 4, and the index is whole', async () => {
    const path = tempDb();
    const bare = await started(path, { fts5: false });
    await bare.insertTraces(LOCAL_TENANT, traces(3000, 0, 'unused'));
    await closed(bare);
    const s = await started(path);
    expect(await s.whenSearchIndexReady()).toBe('ready');
    const db = dbOf(s);
    // The merges the build's writes owed are done: a level merge finds nothing to do.
    expect(levelMergeStep(db, 512)).toBe(0);
    expect(Number((db.prepare("SELECT v FROM trace_search_config WHERE k = 'automerge'").get() as { v: number }).v)).toBe(4);
    integrity(s);
    expect((await s.queryTraces(LOCAL_TENANT, { search: 'ordinary' })).total).toBe(3000);
  });

  it('the merge a sweep owes reports the rows each step wrote, which sizes the next', async () => {
    const path = tempDb();
    const s = await started(path);
    await s.insertTraces(LOCAL_TENANT, traces(400, 200, 'zxcvbnmasdfghjklqwertyuiop'));
    const db = dbOf(s);
    db.transaction(() => deleteOwingMerge(db, () => db.prepare('DELETE FROM traces WHERE timestamp < ?').run('2021-01-01T00:00:00.000Z').changes)).immediate();
    const first = mergeOwedStep(db, 16);
    expect(first.written).toBeGreaterThan(0);
    let step = first;
    while (step.owed) step = mergeOwedStep(db, 512);
    expect(owed(s)).toBe(0);
    integrity(s);
  });
});

describe('the covering index is built after the start (search-index.ts, CREATE_FILTER_INDEX)', () => {
  it('a store from before the index opens without it, answers searches meanwhile, and has it once the background work is done', async () => {
    const path = tempDb();
    const bare = await started(path, { fts5: false });
    await bare.insertTraces(LOCAL_TENANT, traces(500, 0, 'unused'));
    await closed(bare);
    const log: Log = [];
    const s = store(path, { log });
    await s.initialize();
    const hasIndex = () => dbOf(s).prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(SEARCH_FILTER_INDEX) !== undefined;
    // initialize() did not build it: the start does not wait for a read of every trace row.
    expect(hasIndex()).toBe(false);
    expect((await s.queryTraces(LOCAL_TENANT, { search: 'ordinary', limit: 1 })).total).toBe(500);
    await s.whenIdle();
    expect(hasIndex()).toBe(true);
    expect(log).toContainEqual(['info', expect.stringMatching(/^Search index: the covering index for search filters was built after the start, in [\d.]+ s$/)]);
    integrity(s);
  });
});

describe('the build says what it is doing', () => {
  it('logs when it starts and when it is ready, with the counts and the time, and reports its progress', async () => {
    const path = tempDb();
    const bare = await started(path, { fts5: false });
    await bare.insertTraces(LOCAL_TENANT, traces(500, 0, 'unused'));
    await closed(bare);

    const log: Log = [];
    const s = store(path, { log });
    await s.initialize();
    expect(await s.searchStatus()).toEqual({ state: 'building', index: 'scan', total: 500, indexed: 0, cjk_pending: 0, retired: false });
    await s.whenSearchIndexReady();
    expect(await s.searchStatus()).toEqual({ state: 'ready', index: 'fts5', total: null, indexed: null, cjk_pending: 0, retired: false });
    const lines = log.map(([level, line]) => [level, line.replace(/[\d.]+ s$/, 'N s')]);
    // The covering index is built beside the build, so its line may come before or after the build's first.
    expect(lines[0]).toEqual(['info', 'Search index: indexing 500 of 500 stored trace(s) in the background; until it is done, a search reads the traces (the same results, slower)']);
    expect(lines.slice(1).sort()).toEqual([
      ['info', 'Search index ready: 500 trace(s) indexed in N s'],
      ['info', 'Search index: the covering index for search filters was built after the start, in N s'],
    ]);
  });

  it('reports no index on a SQLite without FTS5', async () => {
    const s = await started(tempDb(), { fts5: false });
    expect(await s.searchStatus()).toEqual({ state: 'unavailable', index: 'scan', total: null, indexed: null, cjk_pending: 0, retired: false });
  });
});
