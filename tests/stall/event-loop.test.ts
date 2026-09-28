/*
 * The stall guard: nothing the store does in the background holds the event
 * loop for long.
 *
 * A stdio MCP client waits on the server, and a Node process answers
 * nothing while a SQLite statement runs. The retention sweep, the merge it
 * owes, the erasure of a retired search index and the index build each run
 * in steps of about 50 ms of work with the event loop free between them
 * (src/storage/search-index.ts, never holding the event loop). This runs
 * each on a store of agent-loop traces (three model calls and two tool calls
 * each, sent the way OTLP stores them: the heaviest shape the benchmark
 * knows) and fails when a 1 ms timer ever waits longer than STALL_LIMIT_MS.
 *
 * On the same store, the code before the steps held the loop for the whole
 * sweep (one transaction) and for the whole drop of a retired index (one
 * statement); the numbers are in the pull request that added this guard.
 *
 * It measures time, so it runs alone in CI's stall-guard job
 * (tests/stall/vitest.config.ts), never inside the parallel suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { retiredRemain } from '../../src/storage/search-index.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import type { Driver } from '../../src/storage/driver.js';
import type { Trace } from '../../src/types/trace.js';
import { SEARCH_DRIVER } from '../unit/storage/fts5-here.js';

/** Traces in the store: what a CI runner can build in seconds, and enough that one statement over it stalls for far longer than the limit. */
const TRACES = 10_000;
/** The share past the retention window: large enough for the sweep's merge path. */
const OLD = 0.3;
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

/** The longest gap between two callbacks of a 1 ms timer while `work` runs: the longest a request would have waited. */
async function longestStall(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 1);
  try {
    await work();
    // One more turn, so a stall that ended with the work is counted.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    clearInterval(timer);
  }
  return worst;
}

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
    rmSync(dir, { recursive: true, force: true });
  });

  /** A copy of a store, so each case starts from the same file. */
  const copy = (from: string, name: string) => {
    const to = join(dir, name);
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
    process.stdout.write(`[stall] retention sweep of ${swept} traces: longest stall ${stall.toFixed(0)} ms\n`);
    expect(swept).toBe(TRACES * OLD);
    expect(count(s, 'SELECT COUNT(*) AS n FROM trace_search_erase_owed')).toBe(0);
    expect(stall).toBeLessThan(STALL_LIMIT_MS);
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
    process.stdout.write(`[stall] retired index erased and ${TRACES} traces indexed again: longest stall ${stall.toFixed(0)} ms\n`);
    expect(retiredRemain(dbOf(s))).toBe(false);
    expect(await s.whenSearchIndexReady()).toBe('ready');
    expect(stall).toBeLessThan(STALL_LIMIT_MS);
    await s.close();
  });

  it('building the index after an upgrade', async () => {
    const s = new SqliteAdapter(copy(unindexed, 'upgrade.db'), { driver: SEARCH_DRIVER });
    await s.initialize();
    const stall = await longestStall(() => s.whenIdle());
    process.stdout.write(`[stall] index built for ${TRACES} traces after an upgrade: longest stall ${stall.toFixed(0)} ms\n`);
    expect(await s.whenSearchIndexReady()).toBe('ready');
    expect(count(s, 'SELECT COUNT(*) AS n FROM trace_search_docs')).toBe(TRACES);
    expect(stall).toBeLessThan(STALL_LIMIT_MS);
    await s.close();
  });
});
