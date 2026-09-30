/*
 * The stall guard: nothing the store does in the background holds the event
 * loop for long.
 *
 * A stdio MCP client waits on the server, and a Node process answers
 * nothing while a SQLite statement runs. The retention sweep, the merge it
 * owes, the erasure of a retired search index, the index build and the
 * fill of stored risk estimates each run in steps of under 50 ms of work with the event loop free between them
 * (src/storage/search-index.ts, never holding the event loop). This runs
 * each on a store of agent-loop traces (three model calls and two tool calls
 * each, sent the way OTLP stores them: the heaviest shape the benchmark
 * knows) and fails when the event loop is ever held longer than
 * STALL_LIMIT_MS.
 *
 * Held means the main thread's own CPU time between two callbacks of a
 * 1 ms timer, not the wall clock between them. A hosted runner deschedules
 * the process now and then for hundreds of milliseconds (this job saw 300
 * to 400 ms gaps in steps whose code had not changed); that time is not
 * spent in a statement, and the wall clock cannot tell the two apart. A
 * statement that holds the loop spends its time on this thread, so its CPU
 * time is what the guard reads. The wall-clock gap is printed beside it.
 *
 * On the same store, the code before the steps held the loop for the whole
 * sweep (one transaction) and for the whole drop of a retired index (one
 * statement); the numbers are in the pull request that added this guard.
 *
 * It still runs alone, in CI's stall-guard job
 * (tests/stall/vitest.config.ts), never inside the parallel suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeSync, copyFileSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { TAIL_CHECKPOINT_PAGES } from '../../src/storage/checkpointer.js';
import { retiredRemain } from '../../src/storage/search-index.js';
import { READ_PATH_INDEXES, readPathsMissing } from '../../src/storage/read-paths.js';
import { openDriver } from '../../src/storage/driver.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import { EvalEngine } from '../../src/eval/engine.js';
import type { Driver } from '../../src/storage/driver.js';
import type { Trace } from '../../src/types/trace.js';
import { SEARCH_DRIVER } from '../unit/storage/fts5-here.js';

/** Traces in the store: what a CI runner can build in seconds, and enough that one statement over it stalls for far longer than the limit. */
const TRACES = 10_000;
/** The share past the retention window: large enough for the sweep's merge path. */
const OLD = 0.3;
/** Evaluations without a stored risk estimate, as 0.19.0 left them: a fill in one transaction would hold the loop for seconds. */
const EVALS = 10_000;
/**
 * The ceiling on iris.db-wal while writes never pause and while the index
 * is built. The server's own connection checkpoints at
 * TAIL_CHECKPOINT_PAGES (64 MB) and background steps have the worker empty
 * the log at STEP_TRUNCATE_PAGES (32 MB); twice the first is room for the
 * worker's own copy holding the checkpoint lock a while. With the worker
 * alone, as 0.20.0's first checkpoint worker had it, the log grew with
 * every write: 2.6 GB by the end of an index build at 100,000 traces, and
 * in these two cases 1.1 GB and 149 MB (67 and 35 MB now).
 */
const WAL_CEILING_MB = 128;
/** Steps aim at 50 ms of work; the rest is room for a slower runner and a garbage collection. */
const STALL_LIMIT_MS = 250;

let seed = 0x9e3779b9;
const rand = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const VOCAB = Array.from({ length: 20_000 }, (_, i) => `w${i.toString(36)}`);
const filler = (n: number) => Array.from({ length: n }, () => VOCAB[Math.floor(Math.pow(rand(), 3) * VOCAB.length)]).join(' ');
const turn = (role: string, content: string) => ({ role, parts: [{ type: 'text', content }] });
const DAY = 86_400_000;

/** One agent loop, as the OTLP door stores it (scripts/bench-trace-search.ts --spans). */
function trace(i: number, now: number): Trace {
  const at = now - (i < TRACES * OLD ? 40 * DAY : DAY) + i * 1000;
  const iso = (ms: number) => new Date(at + ms).toISOString();
  const history = [turn('user', `order ${filler(20)}?`)];
  const spans: NonNullable<Trace['spans']> = [];
  for (let call = 0; call < 3; call += 1) {
    const answer = turn('assistant', filler(40));
    spans.push({
      span_id: `t-${i}-llm-${call}`,
      trace_id: `t-${i}`,
      name: 'chat gpt-5',
      kind: 'LLM',
      status_code: 'OK',
      start_time: iso(call * 1000),
      attributes: { 'gen_ai.input.messages': JSON.stringify(history), 'gen_ai.output.messages': JSON.stringify([answer]), 'gen_ai.usage.input_tokens': 200 + call * 150 },
    });
    history.push(answer);
    if (call === 2) break;
    const result = filler(60);
    spans.push({
      span_id: `t-${i}-tool-${call}`,
      trace_id: `t-${i}`,
      name: 'execute_tool lookup_order',
      kind: 'TOOL',
      status_code: 'OK',
      start_time: iso(call * 1000 + 500),
      attributes: { 'gen_ai.tool.call.arguments': JSON.stringify({ order_id: `A-${i}`, note: filler(8) }), 'gen_ai.tool.call.result': JSON.stringify({ status: 'ok', body: result }) },
    });
    history.push(turn('tool', result));
  }
  return {
    trace_id: `t-${i}`,
    agent_name: `agent-${i % 7}`,
    input: `order ${filler(20)}?`,
    output: `${filler(90)}.`,
    tool_calls: [{ tool_name: 'lookup_order', input: { order_id: `A-${i}` }, output: { status: 'shipped', note: filler(8) } }],
    timestamp: iso(0),
    spans,
  };
}

/** This thread's CPU time, in milliseconds (Node 23.9+; before that the whole process's, which only overstates). */
const threadCpuMs = (): number => {
  const usage = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage();
  return (usage.user + usage.system) / 1000;
};

/**
 * While `work` runs, the longest stretch between two callbacks of a 1 ms
 * timer: `held`, the CPU time this thread spent in it (what a statement
 * holding the loop costs), and `wall`, its length on the clock.
 */
async function longestStall(work: () => Promise<unknown>): Promise<{ held: number; wall: number }> {
  let last = performance.now();
  let lastCpu = threadCpuMs();
  let held = 0;
  let wall = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    const cpu = threadCpuMs();
    held = Math.max(held, cpu - lastCpu);
    wall = Math.max(wall, now - last);
    last = now;
    lastCpu = cpu;
  }, 1);
  try {
    await work();
    // One more turn, so a stall that ended with the work is counted.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    clearInterval(timer);
  }
  return { held, wall };
}

const report = (what: string, stall: { held: number; wall: number }) =>
  process.stdout.write(`[stall] ${what}: longest hold ${stall.held.toFixed(0)} ms of this thread's CPU (${stall.wall.toFixed(0)} ms on the clock)\n`);

const dbOf = (s: SqliteAdapter) => (s as unknown as { db: Driver }).db;
const count = (s: SqliteAdapter, sql: string) => Number((dbOf(s).prepare(sql).get() as { n: number }).n);

describe(`no background step holds the event loop over ${STALL_LIMIT_MS} ms (${TRACES.toLocaleString('en-US')} agent-loop traces)`, () => {
  let dir: string;
  /** The traces with their index, as a running server keeps them. */
  let indexed: string;
  /** The same traces without an index, as 0.19.0 left them. */
  let unindexed: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iris-stall-'));
    indexed = join(dir, 'indexed.db');
    unindexed = join(dir, 'unindexed.db');
    const now = Date.now();
    for (const [path, fts5] of [
      [indexed, true],
      [unindexed, false],
    ] as const) {
      seed = 0x9e3779b9;
      const s = new SqliteAdapter(path, { driver: SEARCH_DRIVER, fts5 });
      await s.initialize();
      for (let i = 0; i < TRACES; i += 500) await s.insertTraces(LOCAL_TENANT, Array.from({ length: Math.min(500, TRACES - i) }, (_, k) => trace(i + k, now)));
      await s.checkpoint();
      await s.close();
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /*
   * A copy of a store, so each case starts from the same file. Each call
   * gets a file of its own: a retried case used to copy over the file its
   * failed attempt had left open, beside that attempt's write-ahead log,
   * and SQLite read the old log into the new copy ("database disk image is
   * malformed"), which hid the first failure behind a false one.
   */
  let copies = 0;
  const copy = (from: string, name: string) => {
    copies += 1;
    const to = join(dir, `${copies}-${name}`);
    copyFileSync(from, to);
    return to;
  };

  it('the retention sweep, and the merge it owes', async () => {
    const s = new SqliteAdapter(copy(indexed, 'sweep.db'), { driver: SEARCH_DRIVER });
    await s.initialize();
    let swept = 0;
    const stall = await longestStall(async () => {
      swept = await s.deleteTracesOlderThan(LOCAL_TENANT, 30);
    });
    report(`retention sweep of ${swept} traces`, stall);
    expect(swept).toBe(TRACES * OLD);
    expect(count(s, 'SELECT COUNT(*) AS n FROM trace_search_erase_owed')).toBe(0);
    expect(stall.held).toBeLessThan(STALL_LIMIT_MS);
    await s.close();
  });

  it('erasing an index retired at the start, then the rebuild (#695)', async () => {
    const path = copy(indexed, 'rebuild.db');
    // A start on a SQLite without FTS5 drops the index's triggers; the next start with FTS5 retires the index and rebuilds.
    const bare = new SqliteAdapter(path, { driver: SEARCH_DRIVER, fts5: false });
    await bare.initialize();
    await bare.close();
    const s = new SqliteAdapter(path, { driver: SEARCH_DRIVER });
    await s.initialize();
    expect(retiredRemain(dbOf(s))).toBe(true);
    const stall = await longestStall(() => s.whenIdle());
    report(`retired index erased and ${TRACES} traces indexed again`, stall);
    expect(retiredRemain(dbOf(s))).toBe(false);
    expect(await s.whenSearchIndexReady()).toBe('ready');
    expect(stall.held).toBeLessThan(STALL_LIMIT_MS);
    await s.close();
  });

  it('storing risk estimates for evaluations written before migration 018', async () => {
    const path = copy(indexed, 'risk.db');
    const seeded = new SqliteAdapter(path, { driver: SEARCH_DRIVER });
    await seeded.initialize();
    const engine = new EvalEngine();
    for (let i = 0; i < 4; i += 1) {
      const result = await engine.evaluateAll({ output: `${filler(60)}.`, input: `${filler(15)}?` });
      await seeded.insertEvalResult(LOCAL_TENANT, { ...result, id: `seed-${i}`, trace_id: undefined });
    }
    const db = dbOf(seeded);
    const cols = (db.prepare("SELECT name FROM pragma_table_info('eval_results') WHERE name <> 'id'").all() as Array<{ name: string }>).map((c) => c.name);
    db.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${EVALS / 4 - 1}) INSERT INTO eval_results (id, ${cols.join(', ')}) SELECT 'e-' || n.i || '-' || e.id, ${cols.map((c) => `e.${c}`).join(', ')} FROM n, (SELECT * FROM eval_results) e`,
    );
    db.exec('UPDATE eval_results SET risk_estimate = NULL, risk_version = NULL');
    await seeded.close();
    const s = new SqliteAdapter(path, { driver: SEARCH_DRIVER });
    await s.initialize();
    const stall = await longestStall(() => s.whenIdle());
    report(`risk estimates stored for ${EVALS} evaluations`, stall);
    expect(count(s, 'SELECT COUNT(*) AS n FROM eval_results')).toBe(EVALS);
    expect(count(s, 'SELECT COUNT(*) AS n FROM eval_results WHERE risk_version IS NULL')).toBe(0);
    expect(stall.held).toBeLessThan(STALL_LIMIT_MS);
    await s.close();
  });

  it('the first start after an upgrade from 0.19.0, and the indexes the hot reads name built after it (migration 019)', async () => {
    const path = copy(indexed, 'read-paths.db');
    // Back to the indexes 0.19.0 left: the four 019 builds gone, the three it replaces there, 019 not applied.
    const raw = openDriver(path, { driver: SEARCH_DRIVER });
    raw.exec(`
      ${READ_PATH_INDEXES.map((i) => `DROP INDEX ${i.name};`).join('\n')}
      CREATE INDEX idx_traces_tenant_agent ON traces(tenant_id, agent_name);
      CREATE INDEX idx_traces_tenant_timestamp ON traces(tenant_id, timestamp);
      CREATE INDEX idx_traces_framework ON traces(framework);
      DELETE FROM _iris_migrations WHERE id = '019-read-paths';
    `);
    raw.close();
    // Without the copy #710 takes before migrating, which is a start's other cost and moves off the event loop on its own.
    const s = new SqliteAdapter(path, { driver: SEARCH_DRIVER, backup: false });
    let started = false;
    const stall = await longestStall(async () => {
      await s.initialize();
      // The start answers before they are built.
      started = s.readIndexesState() === 'building';
      await s.whenIdle();
    });
    report(`first start after an upgrade, then ${READ_PATH_INDEXES.length} indexes built over ${TRACES} traces`, stall);
    expect(started).toBe(true);
    expect(s.readIndexesState()).toBe('ready');
    expect(readPathsMissing(dbOf(s))).toEqual([]);
    expect(stall.held).toBeLessThan(STALL_LIMIT_MS);
    await s.close();
  });

  it('building the index after an upgrade', async () => {
    const s = new SqliteAdapter(copy(unindexed, 'upgrade.db'), { driver: SEARCH_DRIVER });
    await s.initialize();
    const stall = await longestStall(() => s.whenIdle());
    report(`index built for ${TRACES} traces after an upgrade`, stall);
    expect(await s.whenSearchIndexReady()).toBe('ready');
    expect(count(s, 'SELECT COUNT(*) AS n FROM trace_search_docs')).toBe(TRACES);
    expect(stall.held).toBeLessThan(STALL_LIMIT_MS);
    await s.close();
  });

  /*
   * The log's size on disk, in MB, sampled every few milliseconds while
   * `work` runs: its largest, and the story an assertion prints when it is too
   * large. The story follows the log's checkpoint sequence number (header
   * bytes 12-15, which SQLite adds one to each time the log starts over):
   * how often it started over, how large it was each time, and the longest
   * stretch it spent over the tail checkpoint's size without starting over.
   * #746: on hosted runners the log now and then stops starting over, and
   * this is the record of how.
   */
  async function largestLog(path: string, work: () => Promise<unknown>): Promise<{ largest: number; story: () => string }> {
    const wal = `${path}-wal`;
    const size = () => {
      try {
        return statSync(wal).size / 2 ** 20;
      } catch {
        return 0;
      }
    };
    const seq = () => {
      let fd: number | undefined;
      try {
        fd = openSync(wal, 'r');
        const b = Buffer.alloc(16);
        return readSync(fd, b, 0, 16, 0) === 16 ? b.readUInt32BE(12) : -1;
      } catch {
        return -1;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    };
    const began = performance.now();
    const samples: Array<[number, number, number]> = [];
    const sample = () => samples.push([performance.now() - began, size(), seq()]);
    sample();
    const timer = setInterval(sample, 5);
    try {
      await work();
    } finally {
      clearInterval(timer);
      sample();
    }
    const largest = Math.max(...samples.map(([, mb]) => mb));
    const story = () => {
      const tailMb = (TAIL_CHECKPOINT_PAGES * 4096) / 2 ** 20;
      const restarts: string[] = [];
      let lastRestart = 0;
      let longestOver = 0;
      for (let k = 1; k < samples.length; k += 1) {
        const [t, mb, q] = samples[k];
        const before = samples[k - 1];
        if (q !== -1 && before[2] !== -1 && q !== before[2]) {
          restarts.push(`${Math.round(t)} ms at ${before[1].toFixed(0)} MB`);
          lastRestart = t;
        }
        if (mb > tailMb) longestOver = Math.max(longestOver, t - lastRestart);
      }
      const shown = restarts.slice(0, 20).join(', ') + (restarts.length > 20 ? ', …' : '');
      return (
        `log over ${samples.length} samples in ${Math.round(samples.at(-1)![0])} ms: largest ${largest.toFixed(1)} MB; ` +
        `started over ${restarts.length} time(s)${restarts.length ? ` (${shown})` : ''}; ` +
        `longest stretch over the tail checkpoint's ${tailMb} MB without starting over: ${Math.round(longestOver)} ms`
      );
    };
    return { largest, story };
  }

  it(`the log stays under ${WAL_CEILING_MB} MB while agent-loop traces are written back to back`, async () => {
    const path = copy(indexed, 'wal-writes.db');
    const s = new SqliteAdapter(path, { driver: SEARCH_DRIVER });
    await s.initialize();
    const now = Date.now();
    // Each trace one write, as log_trace stores them, with no pause. With the worker alone the log reached 1.1 GB here; now about 67 MB.
    const { largest, story } = await largestLog(path, async () => {
      for (let i = 0; i < 6_000; i += 1) {
        await s.insertTrace(LOCAL_TENANT, trace(TRACES + i, now));
        await new Promise((r) => setImmediate(r));
      }
    });
    process.stdout.write(`[wal] 6,000 agent-loop traces written back to back: largest log ${largest.toFixed(1)} MB\n`);
    const worker = (s as unknown as { checkpointer?: { active: boolean; truncateInProgress: boolean } }).checkpointer;
    expect(largest, `${story()}; checkpoint worker ${worker ? `active ${worker.active}, truncating ${worker.truncateInProgress}` : 'none'}`).toBeLessThan(WAL_CEILING_MB);
    await s.close();
  });

  it(`the log stays under ${WAL_CEILING_MB} MB while the index is built after an upgrade`, async () => {
    const path = copy(unindexed, 'wal-build.db');
    const s = new SqliteAdapter(path, { driver: SEARCH_DRIVER });
    const { largest, story } = await largestLog(path, async () => {
      await s.initialize();
      await s.whenIdle();
    });
    process.stdout.write(`[wal] index built for ${TRACES} traces: largest log ${largest.toFixed(1)} MB\n`);
    expect(await s.whenSearchIndexReady()).toBe('ready');
    expect(largest, story()).toBeLessThan(WAL_CEILING_MB);
    await s.close();
  });
});
