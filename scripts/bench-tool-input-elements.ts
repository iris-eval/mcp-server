/*
 * What one tool call's arguments cost the server, with and without the
 * element limit (security.maxInputElements, GHSA-46jr-4wx8-v453).
 *
 *   node --import tsx scripts/bench-tool-input-elements.ts
 *   node --import tsx scripts/bench-tool-input-elements.ts --limits off,10000,100000 --concurrency 20 --runs 3
 *
 * For each limit and each payload, starts a fresh HTTP MCP server in a
 * child process (the real createIrisServer and createHttpTransport), opens
 * --concurrency sessions, and has each send the same log_trace call at
 * once. The payload is the largest of its shape that fits the 1 MB request
 * size limit and stays within the element limit: a call over the limit is
 * refused before its arguments are validated, so the worst case is one
 * just under it. The shapes are `spans` of zeros and of empty objects,
 * which fail validation once and twice per element. Just under is not
 * always the worst: past roughly 100,000 validation errors the SDK's error
 * message overflows the stack and stops early, so under a limit of 100,000
 * the costliest payload found was 60,000 empty objects (530 to 690 MB and
 * 9 to 11 s for 20 at once, across runs); `--elements 60000` sends that size.
 *
 * Reported: the server's peak RSS above its level after garbage collection
 * (sampled every millisecond from a worker thread, because the main thread
 * is blocked while it validates), the time until every request has been
 * answered, and what came back. Each figure is the median of --runs.
 * `off` is the SDK's own default, no limit. Everything lives in a
 * temporary directory, IRIS_HOME included, removed at the end.
 */
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

if (args[0] === '--serve') {
  // The child: one Iris HTTP MCP server, and a sampler of this process's RSS.
  const limit = args[1] === 'off' ? Infinity : Number(args[1]);
  const { createIrisServer } = await import('../src/server.js');
  const { createHttpTransport } = await import('../src/transport/http.js');
  const { SqliteAdapter } = await import('../src/storage/sqlite-adapter.js');
  const { defaultConfig } = await import('../src/config/defaults.js');
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const config = {
    ...defaultConfig,
    transport: { ...defaultConfig.transport, type: 'http' as const, port: 0 },
    security: {
      ...defaultConfig.security,
      // Infinity is the SDK's "no limit"; the config file cannot say it, a benchmark can.
      maxInputElements: limit,
      rateLimit: { ...defaultConfig.security.rateLimit, mcp: 1_000_000 },
    },
  };
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const { newMcpServer } = createIrisServer(config, storage, undefined, { warn: () => {} });
  const http = await createHttpTransport(newMcpServer, config, quiet);
  const peak = new BigInt64Array(new SharedArrayBuffer(8));
  new Worker(
    `const { workerData } = require('node:worker_threads');
     const peak = new BigInt64Array(workerData);
     setInterval(() => { const r = BigInt(process.memoryUsage.rss()); if (r > Atomics.load(peak, 0)) Atomics.store(peak, 0, r); }, 1);`,
    { eval: true, workerData: peak.buffer },
  ).unref();
  const gc = (globalThis as { gc?: () => void }).gc;
  process.on('message', (m) => {
    if (m === 'reset') {
      gc?.();
      gc?.();
      const base = process.memoryUsage.rss();
      Atomics.store(peak, 0, BigInt(base));
      process.send!({ base });
    }
    if (m === 'report') process.send!({ peak: Number(Atomics.load(peak, 0)) });
  });
  process.send!({ port: (http.httpServer.address() as { port: number }).port });
} else {
  const LIMITS = opt('limits', 'off,10000,50000,100000').split(',');
  const CONCURRENCY = Number(opt('concurrency', '20'));
  const RUNS = Number(opt('runs', '3'));
  const REQUEST_BYTES = 1024 * 1024;
  const SHAPES = { zeros: '0', objects: '{}' } as const;
  const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const home = mkdtempSync(join(tmpdir(), 'iris-bench-elements-'));
  const self = fileURLToPath(import.meta.url);

  const body = (unit: string, n: number) =>
    `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"log_trace","arguments":{"agent_name":"a","spans":[${Array(n).fill(unit).join(',')}]}}}`;
  /** Elements in the payload: the largest that fits the request size limit, and for a limit, two under it (agent_name and spans are the other two). */
  const elementsFor = (unit: string, limit: string) => {
    const fixed = Buffer.byteLength(body(unit, 0));
    const fits = Math.floor((REQUEST_BYTES - fixed + 1) / (unit.length + 1));
    const asked = args.includes('--elements') ? Number(opt('elements', '0')) : Infinity;
    return Math.min(fits, asked, limit === 'off' ? Infinity : Number(limit) - 2);
  };

  async function once1(limit: string, unit: string, n: number) {
    const child = fork(self, ['--serve', limit], { execArgv: ['--expose-gc', '--import', 'tsx'], env: { ...process.env, IRIS_HOME: home } });
    const next = () => once(child, 'message').then(([m]) => m as Record<string, number>);
    const { port } = await next();
    const url = `http://127.0.0.1:${port}/mcp`;
    const sessions: string[] = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      const init = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '1' } } }) });
      const sid = init.headers.get('mcp-session-id')!;
      await init.text();
      await (await fetch(url, { method: 'POST', headers: { ...H, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).text();
      sessions.push(sid);
    }
    const payload = body(unit, n);
    child.send('reset');
    const { base } = await next();
    const t0 = performance.now();
    const answers = await Promise.all(
      sessions.map(async (sid) => {
        try {
          const r = await fetch(url, { method: 'POST', headers: { ...H, 'mcp-session-id': sid }, body: payload });
          const text = await r.text();
          return `${r.status}${/"isError":true/.test(text) ? ' isError' : ''}`;
        } catch (err) {
          return `failed: ${(err as { cause?: { code?: string } }).cause?.code ?? String(err)}`;
        }
      }),
    );
    const ms = performance.now() - t0;
    let peakMb = NaN;
    if (child.exitCode === null && child.signalCode === null) {
      child.send('report');
      peakMb = ((await next()).peak - base) / 1048576;
    }
    child.kill();
    return { ms, peakMb, answers: [...new Set(answers)].join(', ') };
  }

  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(`# ${platform()} ${release()}, ${cpus()[0]?.model ?? 'cpu'} x${cpus().length}, ${Math.round(totalmem() / 2 ** 30)} GB, Node ${process.version}`);
  console.log(`# ${CONCURRENCY} sessions each send the same log_trace call at once; median of ${RUNS} runs\n`);
  console.log('| limit | spans of | elements | request bytes | peak RSS over baseline | answered all in | answers |');
  console.log('|---|---|---:|---:|---:|---:|---|');
  try {
    for (const limit of LIMITS) {
      for (const [shape, unit] of Object.entries(SHAPES)) {
        const n = elementsFor(unit, limit);
        const runs = [];
        for (let i = 0; i < RUNS; i++) runs.push(await once1(limit, unit, n));
        const peak = median(runs.map((r) => r.peakMb));
        const ms = median(runs.map((r) => r.ms));
        console.log(`| ${limit} | ${shape} | ${n.toLocaleString('en-US')} | ${Buffer.byteLength(body(unit, n)).toLocaleString('en-US')} | ${Number.isNaN(peak) ? 'server died' : `${Math.round(peak)} MB`} | ${(ms / 1000).toFixed(1)} s | ${runs[0].answers} |`);
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
