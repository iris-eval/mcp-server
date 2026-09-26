/*
 * The recorder's promise to the application: Iris away, slow or refusing is
 * a normal state. The model call is never broken, slowed or changed by it,
 * nothing throws into the caller, the process still exits on time, and what
 * went wrong is said once.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { IrisRecorder, exportRequest, findServer, newSpanId, newTraceId, nowNanos, wrapOpenAI, type TraceRecord } from '../src/index.js';
import { PACKAGE_ROOT, REPLIES, freePort, startProvider, type Provider } from './helpers.js';

const trace = (text = 'hello'): TraceRecord => ({
  resource: { 'service.name': 'unit' },
  spans: [{ traceId: newTraceId(), spanId: newSpanId(), name: 'chat m', kind: 3, startTimeUnixNano: nowNanos(), endTimeUnixNano: nowNanos(), attributes: { 'iris.output': text, 'gen_ai.usage.input_tokens': 3, 'gen_ai.request.temperature': 0.5, 'gen_ai.response.finish_reasons': ['stop'] } }],
});

let provider: Provider;
before(async () => {
  provider = await startProvider();
});
after(async () => {
  await provider?.close();
});

describe('the wire format', () => {
  it('is an OTLP ExportTraceServiceRequest: one ResourceSpans per resource, typed AnyValues, nanosecond strings', () => {
    const a = trace('a');
    const b = { ...trace('b'), resource: { 'service.name': 'other' } };
    const body = exportRequest([a, b, trace('c')]) as { resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: unknown }> }; scopeSpans: Array<{ scope: { name: string }; spans: Array<Record<string, unknown>> }> }> };
    assert.equal(body.resourceSpans.length, 2);
    assert.equal(body.resourceSpans[0].scopeSpans[0].spans.length, 2);
    assert.equal(body.resourceSpans[0].scopeSpans[0].scope.name, '@iris-eval/sdk');
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    assert.match(String(span.traceId), /^[0-9a-f]{32}$/);
    assert.match(String(span.spanId), /^[0-9a-f]{16}$/);
    assert.match(String(span.startTimeUnixNano), /^\d{19}$/);
    const attrs = Object.fromEntries((span.attributes as Array<{ key: string; value: unknown }>).map((kv) => [kv.key, kv.value]));
    assert.deepEqual(attrs['gen_ai.usage.input_tokens'], { intValue: '3' });
    assert.deepEqual(attrs['gen_ai.request.temperature'], { doubleValue: 0.5 });
    assert.deepEqual(attrs['gen_ai.response.finish_reasons'], { arrayValue: { values: [{ stringValue: 'stop' }] } });
    assert.ok(Math.abs(Number(BigInt(String(span.startTimeUnixNano)) / 1_000_000n) - Date.now()) < 5_000);
  });
});

describe('finding Iris', () => {
  it('IRIS_URL first, then the port a running server wrote to runtime.json, else nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'iris-find-'));
    assert.equal(findServer({ IRIS_URL: 'http://iris.local:7000/', IRIS_HOME: home }), 'http://iris.local:7000');
    assert.equal(findServer({ IRIS_HOME: home }), undefined);
    writeFileSync(join(home, 'runtime.json'), JSON.stringify({ dashboardPort: 6921, pid: 1 }));
    assert.equal(findServer({ IRIS_HOME: home }), 'http://127.0.0.1:6921');
    writeFileSync(join(home, 'runtime.json'), '{ not json');
    assert.equal(findServer({ IRIS_HOME: home }), undefined);
  });
});

describe('when Iris is not there', () => {
  it('the wrapped call answers exactly as unwrapped, nothing throws, the loss is counted and said once', async () => {
    const dead = `http://127.0.0.1:${await freePort()}`;
    const errors: string[] = [];
    const recorder = new IrisRecorder({ url: dead, flushIntervalMs: 1, onError: (e) => errors.push(e.message) });
    const client = wrapOpenAI(new OpenAI({ apiKey: 'scripted', baseURL: `${provider.url}/v1`, maxRetries: 0 }), { recorder });
    for (let i = 0; i < 3; i += 1) {
      const res = await client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'What is the capital of France?' }] });
      assert.equal(res.choices[0].message.content, REPLIES.default);
    }
    await recorder.flush();
    assert.equal(recorder.stats.recorded, 3);
    assert.equal(recorder.stats.sent, 0);
    assert.equal(recorder.stats.dropped, 3);
    assert.ok(errors.length > 0 && errors.every((m) => m.includes(dead)));
  });

  it('with no server named anywhere, the default warning is one line, once', async () => {
    /* eslint-disable no-console -- the default warning goes to console.warn, which this test reads */
    const warnings: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    try {
      const home = mkdtempSync(join(tmpdir(), 'iris-none-'));
      const saved = { url: process.env.IRIS_URL, home: process.env.IRIS_HOME };
      delete process.env.IRIS_URL;
      process.env.IRIS_HOME = home;
      const recorder = new IrisRecorder({ flushIntervalMs: 1 });
      recorder.record(trace());
      await recorder.flush();
      recorder.record(trace());
      await recorder.flush();
      process.env.IRIS_HOME = saved.home;
      if (saved.url !== undefined) process.env.IRIS_URL = saved.url;
      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0]), /no server to send to/);
      assert.equal(recorder.stats.dropped, 2);
    } finally {
      console.warn = original;
    }
    /* eslint-enable no-console */
  });

  it('the queue is bounded: the oldest trace goes first', async () => {
    const recorder = new IrisRecorder({ url: 'http://127.0.0.1:1', maxQueue: 2, flushIntervalMs: 60_000, onError: () => {} });
    recorder.record(trace('1'));
    recorder.record(trace('2'));
    recorder.record(trace('3'));
    assert.equal(recorder.stats.dropped, 1);
    await recorder.shutdown(2_000);
  });

  it('a trace over the request budget is dropped on the sending side, and the rest still go', async () => {
    const sizes: number[] = [];
    const errors: string[] = [];
    const recorder = new IrisRecorder({
      url: 'http://iris.test',
      flushIntervalMs: 1,
      onError: (e) => errors.push(e.message),
      fetch: async (_url, init) => {
        sizes.push(String(init?.body).length);
        return new Response(JSON.stringify({ 'iris-eval': { stored: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const started = process.hrtime.bigint();
    recorder.record(trace('x'.repeat(1_000_000)));
    // record() only queues: the million-character trace is not serialized on the caller's path.
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 5);
    recorder.record(trace('fits'));
    await recorder.flush();
    assert.equal(recorder.stats.dropped, 1);
    assert.match(errors[0], /over the 900000-byte request budget/);
    assert.equal(sizes.length, 1);
    assert.ok(sizes[0] < 900_000);
  });

  it('a server that never answers is abandoned at the timeout, and flush never rejects', async () => {
    const sockets: Array<{ destroy(): void }> = [];
    const blackHole: Server = createServer(() => {
      /* accepts and never answers */
    });
    blackHole.on('connection', (s) => sockets.push(s));
    const port = await freePort();
    await new Promise<void>((r) => blackHole.listen(port, '127.0.0.1', () => r()));
    const recorder = new IrisRecorder({ url: `http://127.0.0.1:${port}`, timeoutMs: 200, flushIntervalMs: 1, onError: () => {} });
    recorder.record(trace());
    const started = Date.now();
    await recorder.flush(5_000);
    assert.ok(Date.now() - started < 2_000, `flush took ${Date.now() - started} ms`);
    assert.equal(recorder.stats.dropped, 1);
    for (const s of sockets) s.destroy();
    await new Promise((r) => blackHole.close(r));
  });

  it('a refusal (a wrong key) is dropped with the server\'s own sentence', async () => {
    const port = await freePort();
    const refusing = createServer((_req, res) => res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'A valid API key is required' })));
    await new Promise<void>((r) => refusing.listen(port, '127.0.0.1', () => r()));
    const errors: string[] = [];
    const recorder = new IrisRecorder({ url: `http://127.0.0.1:${port}`, flushIntervalMs: 1, onError: (e) => errors.push(e.message) });
    recorder.record(trace());
    await recorder.flush();
    assert.equal(recorder.stats.dropped, 1);
    assert.match(errors[0], /answered 401: A valid API key is required/);
    await new Promise((r) => refusing.close(r));
  });

  it('a process that ends without flushing still delivers what it recorded before it exits', async () => {
    const received: unknown[] = [];
    const port = await freePort();
    const iris = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ 'iris-eval': { stored: [] } }));
      });
    });
    await new Promise<void>((r) => iris.listen(port, '127.0.0.1', () => r()));
    const script = join(PACKAGE_ROOT, 'build', 'deliver-child.mjs');
    writeFileSync(
      script,
      [
        `import { wrapOpenAI, IrisRecorder } from './src/index.js';`,
        `import OpenAI from 'openai';`,
        `const recorder = new IrisRecorder({ url: 'http://127.0.0.1:${port}', flushIntervalMs: 60000 });`,
        `const client = wrapOpenAI(new OpenAI({ apiKey: 'x', baseURL: '${provider.url}/v1', maxRetries: 0 }), { recorder, agentName: 'exiting' });`,
        `await client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });`,
      ].join('\n'),
    );
    const child = spawn(process.execPath, [script], { stdio: 'ignore' });
    const status = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    await new Promise((r) => iris.close(r));
    assert.equal(status, 0);
    // The batch interval is a minute; the only way the trace arrived is the send on the way out.
    assert.equal(received.length, 1);
    assert.match(JSON.stringify(received[0]), /"service.name","value":\{"stringValue":"exiting"\}/);
  });

  it('a process that recorded a call against a dead server still exits promptly, with its own exit code', async () => {
    // Beside the built sources, so `openai` resolves from this package's node_modules.
    const script = join(PACKAGE_ROOT, 'build', 'exit-child.mjs');
    writeFileSync(
      script,
      [
        `import { wrapOpenAI, IrisRecorder } from './src/index.js';`,
        `import OpenAI from 'openai';`,
        `const recorder = new IrisRecorder({ url: 'http://127.0.0.1:${await freePort()}', onError: () => {} });`,
        `const client = wrapOpenAI(new OpenAI({ apiKey: 'x', baseURL: '${provider.url}/v1', maxRetries: 0 }), { recorder });`,
        `const res = await client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });`,
        `console.log(res.choices[0].message.content);`,
        `process.exitCode = 7;`,
      ].join('\n'),
    );
    // The provider runs in this process, so the child is spawned asynchronously and awaited.
    const started = Date.now();
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    const status = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    const took = Date.now() - started;
    assert.equal(stdout.trim(), REPLIES.default);
    assert.equal(status, 7);
    // It tries to deliver once before exiting (the connection is refused at once) and never holds the process open.
    assert.ok(took < 5_000, `the process took ${took} ms to exit`);
  });
});
