/*
 * How fast trace search is, at a size a user with a real history has (#7).
 *
 *   npx tsx scripts/bench-trace-search.ts                 # 10k and 100k traces
 *   npx tsx scripts/bench-trace-search.ts --sizes 10000   # one size
 *   IRIS_SQLITE_DRIVER=node npx tsx scripts/bench-trace-search.ts
 *   npx tsx scripts/bench-trace-search.ts --spans         # each trace also an OTLP agent loop (#683)
 *   npx tsx scripts/bench-trace-search.ts --cjk           # Chinese text, words run together (#682)
 *   npx tsx scripts/bench-trace-search.ts --scan-up-to 10000  # the no-FTS5 scan only up to that size
 *
 * Builds a file-backed store per size with synthetic traces shaped like
 * agent traffic — a question, a longer answer, two tool calls, metadata —
 * drawn from a vocabulary with a Zipf-like skew, so some words are in most
 * traces and some in a handful. Then times each query (median of the runs,
 * page of 50, the total counted), with the index and, at the sizes where it
 * finishes in reasonable time, the no-FTS5 scan. Prints the machine it ran
 * on, because a number without its machine is not a measurement.
 *
 * With --spans, each trace also carries the spans an instrumented agent loop
 * sends over OTLP: three model calls, each re-sending the conversation so
 * far, and two tool calls with arguments and results, every span with the
 * OTLP ids the door keeps and one trace in ten with an exception event.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { SqliteAdapter } from '../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../src/types/tenant.js';
import type { Trace } from '../src/types/trace.js';

const args = process.argv.slice(2);
const sizeArg = args.indexOf('--sizes');
const SIZES = sizeArg >= 0 ? args[sizeArg + 1].split(',').map(Number) : [10_000, 100_000];
const RUNS = 15;
/** The scan reads every trace per query; fewer runs keep the 100k pass to minutes. */
const SCAN_RUNS = 3;
const scanArg = args.indexOf('--scan-up-to');
const SCAN_UP_TO = scanArg >= 0 ? Number(args[scanArg + 1]) : 100_000;
const SPANS = args.includes('--spans');
/** Chinese text instead of Latin: two-character words run together, a comma every eighth (#682). */
const CJK = args.includes('--cjk');

// Deterministic, so two runs build the same store.
let seed = 0x9e3779b9;
const rand = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};

const START = Date.now();
let SIZE_NOW = 0;

// Filler: a 20,000-word vocabulary drawn with a steep skew, so a few words are in most traces and most words in few.
const VOCAB = Array.from({ length: 20_000 }, (_, i) =>
  CJK ? String.fromCodePoint(0x4e00 + ((i * 7) % 20_000)) + String.fromCodePoint(0x4e00 + ((i * 13 + 5) % 20_000)) : `w${i.toString(36)}`,
);
const filler = (n: number) =>
  CJK
    ? Array.from({ length: n }, (_, k) => VOCAB[Math.floor(Math.pow(rand(), 3) * VOCAB.length)] + (k % 8 === 7 ? '，' : '')).join('')
    : Array.from({ length: n }, () => VOCAB[Math.floor(Math.pow(rand(), 3) * VOCAB.length)]).join(' ');

/*
 * Planted words with a known share of traces, so each query below has a
 * stated selectivity rather than whatever the filler happened to produce.
 */
function trace(i: number): Trace {
  const planted = [
    i % 1000 === 7 ? 'quokka' : '', // 0.1%
    i % 100 === 3 ? 'kestrel' : '', // 1%
    i % 2 === 0 ? 'refund approved' : 'refund', // "refund" in every trace, the phrase in half
    CJK && i % 100 === 9 ? '退款已经批准了' : '', // with --cjk, 批准 inside a run in 1%
  ].join(' ');
  return {
    trace_id: `bench-${i}`,
    agent_name: `agent-${i % 7}`,
    framework: i % 2 ? 'langchain' : 'autogen',
    input: `order ${filler(20)}?`,
    output: `${filler(45)} ${planted} ${filler(45)}.`,
    tool_calls: [
      { tool_name: 'lookup_order', input: { order_id: `A-${i}` }, output: { status: i % 3 ? 'shipped' : 'escalated', note: filler(8) } },
      { tool_name: 'send_email', input: { to: `user${i}@example.com`, body: filler(15) } },
    ],
    metadata: { region: ['eu-west', 'us-east', 'ap-south'][i % 3], tier: i % 10 === 0 ? 'platinum' : 'standard' },
    // One a minute, the newest a minute ago, so a retention window cuts off a known share.
    timestamp: new Date(START - (SIZE_NOW - i) * 60_000).toISOString(),
    ...(SPANS ? { spans: agentLoop(i) } : {}),
  };
}

const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const turn = (role: string, content: string) => ({ role, parts: [{ type: 'text', content }] });

/** The spans of one instrumented agent loop, as fromOtlp stores them. */
function agentLoop(i: number): NonNullable<Trace['spans']> {
  const at = (ms: number) => new Date(START - (SIZE_NOW - i) * 60_000 + ms).toISOString();
  const history = [turn('user', `order ${filler(20)}?`)];
  const spans: NonNullable<Trace['spans']> = [];
  for (let call = 0; call < 3; call += 1) {
    const answer = turn('assistant', filler(40));
    spans.push({
      span_id: `bench-${i}-llm-${call}`,
      trace_id: `bench-${i}`,
      name: 'chat gpt-5',
      kind: 'LLM',
      status_code: 'OK',
      start_time: at(call * 1000),
      attributes: {
        'gen_ai.request.model': 'gpt-5',
        'gen_ai.input.messages': JSON.stringify(history),
        'gen_ai.output.messages': JSON.stringify([answer]),
        'gen_ai.usage.input_tokens': 200 + call * 150,
        'gen_ai.usage.output_tokens': 60,
        'otel.span_id': hex(16),
      },
    });
    history.push(answer);
    if (call === 2) break;
    const result = `${filler(60)} ${call === 0 && i % 100 === 11 ? 'wombat' : ''}`;
    spans.push({
      span_id: `bench-${i}-tool-${call}`,
      trace_id: `bench-${i}`,
      name: 'execute_tool lookup_order',
      kind: 'TOOL',
      status_code: i % 10 === 5 && call === 1 ? 'ERROR' : 'OK',
      start_time: at(call * 1000 + 500),
      attributes: {
        'gen_ai.tool.name': 'lookup_order',
        'gen_ai.tool.call.id': `call_${hex(24)}`,
        'gen_ai.tool.call.arguments': JSON.stringify({ order_id: `A-${i}`, note: filler(8) }),
        'gen_ai.tool.call.result': JSON.stringify({ status: 'ok', body: result }),
        'otel.span_id': hex(16),
      },
      ...(i % 10 === 5 && call === 1 ? { events: [{ name: 'exception', timestamp: at(call * 1000 + 600), attributes: { 'exception.type': 'TimeoutError', 'exception.message': `upstream timed out ${filler(10)}` } }] } : {}),
    });
    history.push(turn('tool', result));
  }
  return spans;
}

const QUERIES: Array<{ label: string; q: string; sort?: 'timestamp'; agent?: string }> = [
  { label: 'word in 0.1% of traces', q: 'quokka' },
  { label: 'word in 1%', q: 'kestrel' },
  { label: 'word in 10% (a metadata value)', q: 'platinum' },
  { label: 'word in 33% (a tool-call value)', q: 'escalated' },
  { label: 'word in every trace', q: 'order' },
  { label: 'word in every trace, newest first', q: 'order', sort: 'timestamp' },
  { label: 'word in every trace, one agent', q: 'order', agent: 'agent-3' },
  { label: 'two words (1% and 100%)', q: 'kestrel refund' },
  { label: 'phrase in 50%', q: '"refund approved"' },
  { label: 'prefix', q: 'kestr*' },
  ...(SPANS ? [{ label: 'word in 1% (a tool result in a span)', q: 'wombat' }, { label: 'word in 10% (an exception message)', q: 'upstream' }] : []),
  ...(CJK ? [{ label: 'CJK word inside a run, 1%', q: '批准' }] : []),
];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

type Query = (typeof QUERIES)[number];

async function time(store: SqliteAdapter, query: Query, runs: number): Promise<{ ms: number; total: number }> {
  let total = 0;
  const samples: number[] = [];
  for (let r = 0; r < runs; r += 1) {
    const t0 = performance.now();
    const page = await store.queryTraces(LOCAL_TENANT, {
      search: query.q,
      limit: 50,
      ...(query.sort ? { sort_by: query.sort } : {}),
      ...(query.agent ? { filter: { agent_name: query.agent } } : {}),
    });
    samples.push(performance.now() - t0);
    total = page.total;
  }
  return { ms: median(samples), total };
}

/** Fill a store with `size` traces in batches of 1,000, from the same seed every time; returns the milliseconds taken. */
async function fill(store: SqliteAdapter, size: number): Promise<number> {
  seed = 0x9e3779b9;
  SIZE_NOW = size;
  const t0 = performance.now();
  for (let i = 0; i < size; i += 1000) {
    await store.insertTraces(LOCAL_TENANT, Array.from({ length: Math.min(1000, size - i) }, (_, k) => trace(i + k)));
  }
  const ms = performance.now() - t0;
  await store.checkpoint();
  return ms;
}

const mb = (path: string) => (statSync(path).size / 2 ** 20).toFixed(0);
const perTrace = (ms: number, size: number) => ((ms * 1000) / size).toFixed(0);

const cpu = cpus()[0];
console.log(`machine: ${cpu.model}, ${cpus().length} logical cores, ${(totalmem() / 2 ** 30).toFixed(0)} GB RAM, ${platform()} ${release()}, Node ${process.versions.node}`);

for (const size of SIZES) {
  const dir = mkdtempSync(join(tmpdir(), 'iris-bench-search-'));
  try {
    // The same traces into a store without the index, for what indexing costs on write and on disk.
    const plainPath = join(dir, 'plain.db');
    const plain = new SqliteAdapter(plainPath, { fts5: false });
    await plain.initialize();
    const plainMs = await fill(plain, size);
    await plain.close();

    const path = join(dir, 'iris.db');
    let store = new SqliteAdapter(path);
    await store.initialize();
    const sqlite = ((store as unknown as { db: { prepare(s: string): { get(): unknown } } }).db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
    console.log(`\n${size.toLocaleString('en-US')} traces — driver ${store.driver}, SQLite ${sqlite}`);
    const indexedMs = await fill(store, size);
    console.log(`  insert without the index: ${perTrace(plainMs, size)} µs per trace, file ${mb(plainPath)} MB`);
    console.log(`  insert with the index:    ${perTrace(indexedMs, size)} µs per trace, file ${mb(path)} MB`);
    if (SPANS || CJK) {
      // Where the index's bytes are: the FTS5 index, the CJK stream (its FTS5 table and the text each row was given), the id table and the covering index.
      const db = (store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db;
      const rows = db
        .prepare(
          "SELECT CASE WHEN name LIKE 'trace_search_cjk%' THEN 'CJK stream' WHEN name LIKE 'trace_search_%' AND name <> 'trace_search_docs' THEN 'trace_search (FTS5)' ELSE name END AS part, SUM(pgsize) AS bytes FROM dbstat WHERE name LIKE 'trace_search%' OR name IN ('idx_traces_search_filter', 'spans', 'traces') GROUP BY part ORDER BY bytes DESC",
        )
        .all() as Array<{ part: string; bytes: number }>;
      console.log(`  bytes by table: ${rows.map((r) => `${r.part} ${(r.bytes / 2 ** 20).toFixed(0)} MB`).join(', ')}`);
    }

    // A second connection that behaves as a SQLite without FTS5, for the scan column. Its start drops the triggers on the file; the reopen below restores them.
    const scan = size <= SCAN_UP_TO ? new SqliteAdapter(path, { fts5: false }) : undefined;
    await scan?.initialize();
    console.log(`  ${'query'.padEnd(36)} matches   fts5 ms${scan ? '   scan ms' : ''}`);
    for (const query of QUERIES) {
      const indexed = await time(store, query, RUNS);
      let scanned = '';
      if (scan) {
        const s = await time(scan, query, SCAN_RUNS);
        if (s.total !== indexed.total) throw new Error(`scan and index disagree on ${JSON.stringify(query.q)}: ${s.total} vs ${indexed.total}`);
        scanned = s.ms.toFixed(0).padStart(10);
      }
      console.log(`  ${query.label.padEnd(36)} ${String(indexed.total).padStart(7)} ${indexed.ms.toFixed(1).padStart(9)}${scanned}`);
    }
    await scan?.close();

    // The scan connection's start dropped the triggers, so the next start rebuilds the index from the
    // traces — which is also what the migration does to an existing database. Time it.
    await store.close();
    const reopened = new SqliteAdapter(path);
    const t2 = performance.now();
    // The event loop's worst stall while the build runs: how long a request could wait behind it.
    const loop = monitorEventLoopDelay({ resolution: 5 });
    loop.enable();
    await reopened.initialize();
    const startedMs = performance.now() - t2;
    await reopened.whenSearchIndexReady();
    loop.disable();
    console.log(
      `  the upgrade, ${size.toLocaleString('en-US')} stored traces: start ${startedMs.toFixed(0)} ms; index built in the background in ${((performance.now() - t2) / 1000).toFixed(1)} s; longest event-loop stall during it ${(loop.max / 1e6).toFixed(0)} ms`,
    );
    store = reopened;

    if (SPANS) {
      /*
       * The upgrade a user with an index from before the span column meets:
       * the file as main left it (four columns, its two triggers), opened by
       * this build, which drops that index at the start and builds the new
       * one in the background.
       */
      await store.close();
      const raw = new SqliteAdapter(path, { fts5: false });
      await raw.initialize();
      (raw as unknown as { db: { exec(s: string): void } }).db.exec(`
        DELETE FROM trace_search_docs;
        CREATE VIRTUAL TABLE trace_search_old USING fts5(input, output, tool_calls, metadata, content = '', tokenize = 'unicode61 remove_diacritics 2');
        INSERT INTO trace_search_docs (tenant_id, trace_id) SELECT tenant_id, trace_id FROM traces ORDER BY rowid;
        INSERT INTO trace_search_old (rowid, input, output, tool_calls, metadata)
          SELECT d.doc_id, t.input, t.output, (SELECT group_concat(value, ' ') FROM json_tree(t.tool_calls) WHERE type IN ('text', 'integer', 'real')), (SELECT group_concat(value, ' ') FROM json_tree(t.metadata) WHERE type IN ('text', 'integer', 'real'))
          FROM trace_search_docs d JOIN traces t ON t.trace_id = d.trace_id;
      `);
      await raw.close();
      // Swap the four-column index in under the name the build looks for (a start without FTS5 left no triggers; the old pair is recreated).
      const fts = new SqliteAdapter(path);
      await fts.initialize();
      await fts.whenSearchIndexReady();
      (fts as unknown as { db: { exec(s: string): void } }).db.exec(`
        ${['trace_search_au', 'trace_search_bd', 'trace_search_spans_bi', 'trace_search_spans_ai', 'trace_search_spans_bd', 'trace_search_spans_ad', 'trace_search_spans_bu', 'trace_search_spans_au'].map((t) => `DROP TRIGGER IF EXISTS ${t};`).join(' ')}
        DROP TABLE trace_search;
        ALTER TABLE trace_search_old RENAME TO trace_search;
        CREATE TRIGGER trace_search_ad AFTER DELETE ON traces BEGIN DELETE FROM trace_search_docs WHERE trace_id = OLD.trace_id; END;
        CREATE TRIGGER trace_search_au AFTER UPDATE OF metadata ON traces BEGIN SELECT 1; END;
      `);
      await fts.close();
      await (await import('node:fs/promises')).stat(path);
      const t3 = performance.now();
      const loop2 = monitorEventLoopDelay({ resolution: 5 });
      loop2.enable();
      const upgraded = new SqliteAdapter(path);
      await upgraded.initialize();
      const upStart = performance.now() - t3;
      await upgraded.whenSearchIndexReady();
      loop2.disable();
      console.log(
        `  the upgrade from the four-column index: start ${upStart.toFixed(0)} ms; span index built in the background in ${((performance.now() - t3) / 1000).toFixed(1)} s; longest event-loop stall during it ${(loop2.max / 1e6).toFixed(0)} ms; file ${mb(path)} MB`,
      );
      store = upgraded;
    }

    // Deletes: one trace at a time (delete_trace, erased row by row), then a retention sweep of the oldest 3%.
    const one: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now();
      await store.deleteTrace(LOCAL_TENANT, `bench-${size - 1 - i * 37}`);
      one.push(performance.now() - t0);
    }
    const sweepDays = (size * 0.97) / (24 * 60);
    const t1 = performance.now();
    const swept = await store.deleteTracesOlderThan(LOCAL_TENANT, sweepDays);
    const sweepMs = performance.now() - t1;
    console.log(`  delete_trace: ${median(one).toFixed(1)} ms (median of 20)`);
    console.log(`  retention sweep of ${swept.toLocaleString('en-US')} traces: ${(sweepMs / 1000).toFixed(1)} s`);
    await store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
