/*
 * What an export costs at a size a user with a real history has (#4).
 *
 *   node --expose-gc --import tsx scripts/bench-export.ts                 # 100k traces
 *   node --expose-gc --import tsx scripts/bench-export.ts --sizes 10000   # another size
 *   node --expose-gc --import tsx scripts/bench-export.ts --spans         # each trace also five spans
 *
 * --expose-gc is for the live-heap column; without it that column is "-".
 *
 * Builds a file-backed store of synthetic agent traces — a question, a
 * longer answer, two tool calls, metadata, one evaluation each — starts the
 * real dashboard server on it, and downloads GET /api/v1/traces/export over
 * a socket as CSV and as JSON Lines, then a search that matches half the
 * store, then the evaluations. For each: the time, the bytes, the live heap
 * the export holds (a second download, collecting garbage every 100 ms),
 * the heap and RSS growth over their level before the download (sampled
 * every 20 ms, garbage included), the event loop's longest stall, and the
 * slowest of the list requests sent every 50 ms while the export runs — how
 * long another request waited behind it.
 *
 * The downloading client runs in the same process and keeps nothing (it
 * counts bytes), so the growth measured is the server's. Everything lives
 * in a temporary directory, IRIS_HOME included, removed at the end.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { Server } from 'node:http';

const dir = mkdtempSync(join(tmpdir(), 'iris-bench-export-'));
process.env.IRIS_HOME = dir;
process.env.IRIS_DB_PATH = join(dir, 'iris.db');

const { SqliteAdapter } = await import('../src/storage/sqlite-adapter.js');
const { createDashboardServer } = await import('../src/dashboard/server.js');
const { defaultConfig } = await import('../src/config/defaults.js');
const { LOCAL_TENANT } = await import('../src/types/tenant.js');
type Trace = import('../src/types/trace.js').Trace;
type EvalResult = import('../src/types/eval.js').EvalResult;

const args = process.argv.slice(2);
const sizeArg = args.indexOf('--sizes');
const SIZES = sizeArg >= 0 ? args[sizeArg + 1].split(',').map(Number) : [100_000];
const SPANS = args.includes('--spans');

let seed = 0x9e3779b9;
const rand = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const VOCAB = Array.from({ length: 20_000 }, (_, i) => `w${i.toString(36)}`);
const filler = (n: number) => Array.from({ length: n }, () => VOCAB[Math.floor(Math.pow(rand(), 3) * VOCAB.length)]).join(' ');
const START = Date.now();
let SIZE_NOW = 0;

function trace(i: number, size: number): Trace {
  const at = START - (size - i) * 60_000;
  return {
    trace_id: `bench-${i}`,
    agent_name: `agent-${i % 7}`,
    framework: i % 2 ? 'langchain' : 'autogen',
    input: `order ${filler(20)}?`,
    output: `${filler(45)} ${i % 2 === 0 ? 'refund approved' : 'shipped'} ${filler(45)}.`,
    tool_calls: [
      { tool_name: 'lookup_order', input: { order_id: `A-${i}` }, output: { status: i % 3 ? 'shipped' : 'escalated', note: filler(8) } },
      { tool_name: 'send_email', input: { to: `user${i}@example.com`, body: filler(15) } },
    ],
    latency_ms: 200 + (i % 900),
    cost_usd: (i % 50) / 10_000,
    token_usage: { prompt_tokens: 300, completion_tokens: 120, total_tokens: 420 },
    metadata: { region: ['eu-west', 'us-east', 'ap-south'][i % 3], tier: i % 10 === 0 ? 'platinum' : 'standard' },
    timestamp: new Date(at).toISOString(),
    ...(SPANS
      ? {
          spans: Array.from({ length: 5 }, (_, k) => ({
            span_id: `bench-${i}-${k}`,
            trace_id: `bench-${i}`,
            name: k % 2 ? 'execute_tool lookup_order' : 'chat gpt-5',
            kind: k % 2 ? ('TOOL' as const) : ('LLM' as const),
            status_code: 'OK' as const,
            start_time: new Date(at + k * 500).toISOString(),
            attributes: { 'gen_ai.output.messages': filler(40) },
          })),
        }
      : {}),
  };
}

function evaluation(i: number): EvalResult {
  const passed = i % 5 !== 0;
  return {
    id: `bench-eval-${i}`,
    trace_id: `bench-${i}`,
    eval_type: 'completeness',
    output_text: filler(60),
    score: passed ? 0.9 : 0.4,
    passed,
    rule_results: [{ ruleName: 'min_output_length', passed, score: passed ? 1 : 0, message: passed ? 'OK' : 'too short' }],
    created_at: new Date(START - (SIZE_NOW - i) * 60_000 + 1000).toISOString(),
  };
}

interface Measure {
  label: string;
  /** Growth of the heap that survives a full collection — what the export holds, not garbage awaiting collection. -1 without --expose-gc. */
  liveMb?: number;
  records: number;
  bytes: number;
  ms: number;
  heapGrowthMb: number;
  rssGrowthMb: number;
  loopMaxMs: number;
  healthMaxMs: number;
  healthChecks: number;
}

const mb = (b: number) => b / 2 ** 20;

async function measure(base: string, label: string, path: string): Promise<Measure> {
  global.gc?.();
  await new Promise((r) => setTimeout(r, 200));
  const heap0 = process.memoryUsage().heapUsed;
  const rss0 = process.memoryUsage().rss;
  let heapPeak = heap0;
  let rssPeak = rss0;
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    heapPeak = Math.max(heapPeak, m.heapUsed);
    rssPeak = Math.max(rssPeak, m.rss);
  }, 20);
  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();

  // Another request, every 50 ms, while the export runs: how long it waits.
  let running = true;
  const health: number[] = [];
  const prober = (async () => {
    while (running) {
      const t = performance.now();
      await (await fetch(`${base}/api/v1/traces?limit=1`)).arrayBuffer();
      health.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 50));
    }
  })();

  const t0 = performance.now();
  const res = await fetch(`${base}${path}`);
  if (res.status !== 200) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  let bytes = 0;
  let newlines = 0;
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    for (let k = 0; k < value.length; k++) if (value[k] === 10) newlines++;
  }
  const ms = performance.now() - t0;
  running = false;
  await prober;
  clearInterval(sampler);
  loop.disable();
  return {
    label,
    records: path.includes('format=csv') ? -1 : newlines,
    bytes,
    ms,
    heapGrowthMb: mb(heapPeak - heap0),
    rssGrowthMb: mb(rssPeak - rss0),
    loopMaxMs: loop.max / 1e6,
    healthMaxMs: Math.max(...health),
    healthChecks: health.length,
  };
}

/**
 * The same download again, collecting garbage every 100 ms and reading the
 * heap after each collection: the largest amount the export kept alive at
 * once. Collection slows the download, so this pass is not the timed one.
 */
async function liveHeap(base: string, path: string): Promise<number> {
  const gc = global.gc;
  if (!gc) return -1;
  gc();
  const heap0 = process.memoryUsage().heapUsed;
  let peak = heap0;
  const sampler = setInterval(() => {
    gc();
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }, 100);
  const res = await fetch(`${base}${path}`);
  const reader = res.body!.getReader();
  while (!(await reader.read()).done);
  clearInterval(sampler);
  return mb(peak - heap0);
}

const cpu = cpus()[0];
console.log(`machine: ${cpu.model}, ${cpus().length} logical cores, ${(totalmem() / 2 ** 30).toFixed(0)} GB RAM, ${platform()} ${release()}, Node ${process.versions.node}${global.gc ? ', --expose-gc' : ''}`);

try {
  for (const size of SIZES) {
    const path = join(dir, `bench-${size}.db`);
    const store = new SqliteAdapter(path);
    await store.initialize();
    seed = 0x9e3779b9;
    SIZE_NOW = size;
    for (let i = 0; i < size; i += 1000) {
      const n = Math.min(1000, size - i);
      await store.insertTraces(LOCAL_TENANT, Array.from({ length: n }, (_, k) => trace(i + k, size)));
      for (let k = 0; k < n; k++) await store.insertEvalResult(LOCAL_TENANT, evaluation(i + k));
    }
    await store.checkpoint();
    await store.whenSearchIndexReady();
    console.log(`\n${size.toLocaleString('en-US')} traces, ${size.toLocaleString('en-US')} evaluations${SPANS ? `, ${(size * 5).toLocaleString('en-US')} spans` : ''} — driver ${store.driver}, file ${mb(statSync(path).size).toFixed(0)} MB`);

    const config = { ...defaultConfig, dashboard: { ...defaultConfig.dashboard, port: 0 }, security: { ...defaultConfig.security, rateLimit: { ...defaultConfig.security.rateLimit, api: 100_000 } } };
    const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: (...a: unknown[]) => console.error('[server]', ...a) };
    const server: Server = createDashboardServer(store, config, quiet).start();
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    // What the other request costs with no export running, for comparison.
    const idle: number[] = [];
    for (let k = 0; k < 40; k++) {
      const t = performance.now();
      await (await fetch(`${base}/api/v1/traces?limit=1`)).arrayBuffer();
      idle.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 50));
    }
    console.log(`  the other request (GET /api/v1/traces?limit=1) with no export running: max ${Math.max(...idle).toFixed(0)} ms over ${idle.length}`);

    const EXPORTS: Array<[string, string]> = [
      ['traces, CSV (first read)', '/api/v1/traces/export?format=csv'],
      ['traces, CSV', '/api/v1/traces/export?format=csv'],
      ['traces, JSON Lines', '/api/v1/traces/export?format=jsonl'],
      // The first search of a process starts the search thread (search-worker-client.ts), as the list's first search does.
      ['search 50%, JSONL (1st search)', '/api/v1/traces/export?format=jsonl&q=refund+approved'],
      ['search in 50%, JSON Lines', '/api/v1/traces/export?format=jsonl&q=refund+approved'],
      ['evaluations, CSV', '/api/v1/evaluations/export?format=csv'],
    ];
    const runs: Measure[] = [];
    for (const [label, url] of EXPORTS) runs.push({ ...(await measure(base, label, url)), liveMb: await liveHeap(base, url) });

    console.log(`  ${'export'.padEnd(30)} ${'records'.padStart(8)} ${'MB'.padStart(6)} ${'seconds'.padStart(8)} ${'live heap +MB'.padStart(14)} ${'heap +MB'.padStart(9)} ${'RSS +MB'.padStart(8)} ${'loop max ms'.padStart(12)} ${'other request max ms'.padStart(21)}`);
    for (const r of runs) {
      console.log(
        `  ${r.label.padEnd(30)} ${(r.records < 0 ? '-' : r.records.toLocaleString('en-US')).padStart(8)} ${mb(r.bytes).toFixed(0).padStart(6)} ${(r.ms / 1000).toFixed(1).padStart(8)} ${(r.liveMb === undefined || r.liveMb < 0 ? '-' : r.liveMb.toFixed(0)).padStart(14)} ${r.heapGrowthMb.toFixed(0).padStart(9)} ${r.rssGrowthMb.toFixed(0).padStart(8)} ${r.loopMaxMs.toFixed(0).padStart(12)} ${`${r.healthMaxMs.toFixed(0)} (${r.healthChecks} sent)`.padStart(21)}`,
      );
    }
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  // The search thread may still hold the file for a moment after close on Windows.
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
