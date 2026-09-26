/*
 * How fast trace search is, at a size a user with a real history has (#7).
 *
 *   npx tsx scripts/bench-trace-search.ts                 # 10k and 100k traces
 *   npx tsx scripts/bench-trace-search.ts --sizes 10000   # one size
 *   IRIS_SQLITE_DRIVER=node npx tsx scripts/bench-trace-search.ts
 *
 * Builds a file-backed store per size with synthetic traces shaped like
 * agent traffic — a question, a longer answer, two tool calls, metadata —
 * drawn from a vocabulary with a Zipf-like skew, so some words are in most
 * traces and some in a handful. Then times each query (median of the runs,
 * page of 50, the total counted), with the index and, at the sizes where it
 * finishes in reasonable time, the no-FTS5 scan. Prints the machine it ran
 * on, because a number without its machine is not a measurement.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SqliteAdapter } from '../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../src/types/tenant.js';
import type { Trace } from '../src/types/trace.js';

const args = process.argv.slice(2);
const sizeArg = args.indexOf('--sizes');
const SIZES = sizeArg >= 0 ? args[sizeArg + 1].split(',').map(Number) : [10_000, 100_000];
const RUNS = 15;
/** The scan reads every trace per query; fewer runs keep the 100k pass to minutes. */
const SCAN_RUNS = 3;
const SCAN_UP_TO = 100_000;

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
const VOCAB = Array.from({ length: 20_000 }, (_, i) => `w${i.toString(36)}`);
const filler = (n: number) => Array.from({ length: n }, () => VOCAB[Math.floor(Math.pow(rand(), 3) * VOCAB.length)]).join(' ');

/*
 * Planted words with a known share of traces, so each query below has a
 * stated selectivity rather than whatever the filler happened to produce.
 */
function trace(i: number): Trace {
  const planted = [
    i % 1000 === 7 ? 'quokka' : '', // 0.1%
    i % 100 === 3 ? 'kestrel' : '', // 1%
    i % 2 === 0 ? 'refund approved' : 'refund', // "refund" in every trace, the phrase in half
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
  };
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
    await reopened.initialize();
    console.log(`  index built from ${size.toLocaleString('en-US')} stored traces (the upgrade): ${((performance.now() - t2) / 1000).toFixed(1)} s`);
    store = reopened;

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
