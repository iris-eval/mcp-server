/*
 * Delivery when the process ends. A short script that records calls and
 * exits without calling flush() relies on the recorder's send on the way
 * out for everything it recorded. Each case runs in a child process, as an
 * application would, against a stand-in for Iris in this process, and is
 * repeated: CI runs this file on Linux, macOS and Windows.
 *
 *   - A process that finishes its work sends every queued trace, whole,
 *     before it exits, across as many requests as the 900 KB request budget
 *     needs, and keeps its own exit code.
 *   - A process that calls process.exit() while traces are queued or a send
 *     is waiting for Iris cannot deliver them, and says how many it did not
 *     deliver before it ends.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { PACKAGE_ROOT } from './helpers.js';

/** How many times each case runs, in a fresh process each time. */
const ROUNDS = 20;

interface Arrival {
  declaredLength: number;
  body: string;
}

/**
 * The stand-in for Iris. It listens on a port the system assigns at bind
 * time and records each `POST /v1/traces` as it came, unparsed: the
 * assertions read them. Test files run in parallel, and another file's
 * server can be started on a port chosen before this one was bound, so a
 * request for any other path (such as that file's health check) is answered
 * 404 and not counted.
 */
class StandIn {
  readonly arrivals: Arrival[] = [];
  /** Requests answered `{ stored: [] }`; `hold` leaves them unanswered. */
  hold = false;
  private readonly server: Server;
  private readonly sockets = new Set<{ destroy(): void }>();
  url = '';

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.method !== 'POST' || req.url !== '/v1/traces') {
          res.writeHead(404).end();
          return;
        }
        this.arrivals.push({ declaredLength: Number(req.headers['content-length'] ?? -1), body: Buffer.concat(chunks).toString('utf8') });
        if (!this.hold) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ 'iris-eval': { stored: [] } }));
      });
    });
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.once('close', () => this.sockets.delete(s));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server.close(r));
  }
}

/** The span names each request carried, after checking the request is a whole OTLP export. */
function spanNames(arrival: Arrival): string[] {
  assert.ok(arrival.body.length > 0, 'a request arrived with an empty body');
  assert.equal(Buffer.byteLength(arrival.body), arrival.declaredLength, 'the body is shorter than its Content-Length');
  const body = JSON.parse(arrival.body) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }> };
  return body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans.map((span) => span.name)));
}

/** A child script beside the built sources, so `./src/index.js` resolves. */
function childScript(name: string, lines: string[]): string {
  const path = join(PACKAGE_ROOT, 'build', `${name}.mjs`);
  writeFileSync(path, [`import { IrisRecorder, newSpanId, newTraceId, nowNanos } from './src/index.js';`, `const trace = (name, chars) => ({ resource: { 'service.name': 'exit-delivery' }, spans: [{ traceId: newTraceId(), spanId: newSpanId(), name, kind: 3, startTimeUnixNano: nowNanos(), endTimeUnixNano: nowNanos(), attributes: { 'iris.output': 'x'.repeat(chars) } }] });`, ...lines].join('\n'));
  return path;
}

async function run(script: string, args: string[]): Promise<{ status: number | null; stderr: string; took: number }> {
  const started = Date.now();
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += String(d)));
  const status = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { status, stderr, took: Date.now() - started };
}

let iris: StandIn;
before(async () => {
  iris = new StandIn();
  await iris.start();
});
after(async () => {
  await iris?.close();
});

describe('delivery when the process ends', () => {
  it(`a process that finishes with traces queued delivers every one, whole, before it exits (${ROUNDS} runs)`, async () => {
    // 30 small traces and 8 of about 200 KB: more than one request's worth, so the
    // send on the way out has to go on after its first request is answered.
    const script = childScript('exit-delivery-finish', [
      `const recorder = new IrisRecorder({ url: process.argv[2], flushIntervalMs: 60_000 });`,
      `for (let i = 0; i < 30; i += 1) recorder.record(trace(\`small-\${i}\`, 50));`,
      `for (let i = 0; i < 8; i += 1) recorder.record(trace(\`large-\${i}\`, 200_000));`,
      `process.exitCode = 3;`,
    ]);
    const expected = [...Array.from({ length: 30 }, (_, i) => `small-${i}`), ...Array.from({ length: 8 }, (_, i) => `large-${i}`)].sort();
    for (let round = 0; round < ROUNDS; round += 1) {
      iris.arrivals.length = 0;
      const { status, stderr } = await run(script, [iris.url]);
      // The batch interval is a minute: everything that arrived was sent on the way out.
      assert.equal(status, 3, `run ${round + 1}: the process's own exit code`);
      assert.equal(stderr, '', `run ${round + 1}: nothing to report`);
      assert.ok(iris.arrivals.length >= 2, `run ${round + 1}: ${iris.arrivals.length} request(s); the traces need at least two`);
      const names = iris.arrivals.flatMap(spanNames).sort();
      assert.deepEqual(names, expected, `run ${round + 1}: every trace arrives exactly once`);
    }
  });

  it(`a process that calls process.exit() with traces queued says how many it did not deliver (${ROUNDS} runs)`, async () => {
    const script = childScript('exit-delivery-exit-queued', [
      `const recorder = new IrisRecorder({ url: process.argv[2], flushIntervalMs: 60_000 });`,
      `for (let i = 0; i < 5; i += 1) recorder.record(trace(\`queued-\${i}\`, 50));`,
      `process.exit(4);`,
    ]);
    for (let round = 0; round < ROUNDS; round += 1) {
      iris.arrivals.length = 0;
      const { status, stderr } = await run(script, [iris.url]);
      assert.equal(status, 4, `run ${round + 1}: the process's own exit code`);
      assert.equal(iris.arrivals.length, 0, `run ${round + 1}: nothing was sent`);
      assert.match(stderr, /^iris: the process exited before 5 traces were delivered \(5 queued\)/, `run ${round + 1}`);
    }
  });

  it(`a process that calls process.exit() while Iris has not answered says so, and still exits at once (${ROUNDS} runs)`, async () => {
    // The batch leaves the queue when the 1 ms timer fires; Iris holds its answer; the
    // process exits 300 ms later with the request open.
    const script = childScript('exit-delivery-exit-in-flight', [
      `const recorder = new IrisRecorder({ url: process.argv[2], flushIntervalMs: 1 });`,
      `for (let i = 0; i < 2; i += 1) recorder.record(trace(\`sent-\${i}\`, 50));`,
      `setTimeout(() => recorder.record(trace('late', 50)), 50);`,
      `setTimeout(() => process.exit(0), 300);`,
    ]);
    iris.hold = true;
    try {
      for (let round = 0; round < ROUNDS; round += 1) {
        iris.arrivals.length = 0;
        const { status, stderr, took } = await run(script, [iris.url]);
        assert.equal(status, 0, `run ${round + 1}: the process's own exit code`);
        assert.match(stderr, /^iris: the process exited before 3 traces were delivered \(2 in flight, 1 queued\)/, `run ${round + 1}`);
        // The recorder never holds the process open: the exit is the application's, at 300 ms.
        assert.ok(took < 5_000, `run ${round + 1}: the process took ${took} ms to exit`);
      }
    } finally {
      iris.hold = false;
    }
  });
});
