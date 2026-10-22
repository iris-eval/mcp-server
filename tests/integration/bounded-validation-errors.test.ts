/*
 * Validation errors return at most 20 issues and the total, on the real
 * servers: the dashboard API's trace ingest, its OTLP door, and an MCP
 * tool call with unknown arguments. A request wrong in a few places is
 * still told every one of them; a request wrong in thousands of places gets
 * a small answer that says how many there were.
 *
 * And before any of that, a body over the element limit
 * (security.maxInputElements) is answered 413 without a schema reading it:
 * JSON on every dashboard route, and protobuf on the OTLP door once decoded.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { createIrisServer } from '../../src/server.js';
import { defaultConfig, protobufElementCeiling } from '../../src/config/defaults.js';
import { decodeExportTraceServiceRequest } from '../../src/otel/protobuf.js';
import { countElements } from '../../src/utils/element-count.js';
import { requestSizeLimitBytes } from '../../src/utils/size-limit.js';
import { MAX_LISTED_ISSUES } from '../../src/utils/validation-errors.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { textOf, type ToolResult } from '../helpers/mcp-results.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

let lastStorage: SqliteAdapter | undefined;

async function dashboard(maxInputElements = defaultConfig.security.maxInputElements): Promise<string> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  lastStorage = storage;
  const config = { ...defaultConfig, dashboard: { ...defaultConfig.dashboard, port: 0 }, security: { ...defaultConfig.security, maxInputElements } };
  const server: Server = createDashboardServer(storage, config, quiet, {}).start();
  await new Promise((resolve) => server.once('listening', resolve));
  cleanup.push(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage.close();
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

interface Refusal {
  error: string;
  details: Array<{ code: string; path: unknown[]; message: string; keys?: string[]; keyCount?: number }>;
  issueCount: number;
  detailsNote?: string;
}

async function post(url: string, body: unknown): Promise<{ status: number; bytes: number; json: Refusal }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, bytes: Buffer.byteLength(text), json: JSON.parse(text) as Refusal };
}

describe('POST /api/v1/traces', () => {
  it('answers a trace wrong in 50,000 places with the first 20 issues, the total and a note, in a few kilobytes', async () => {
    const base = await dashboard();
    const r = await post(`${base}/api/v1/traces`, { agent_name: 'a', output: 'x', spans: Array(50_000).fill(0) });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('Invalid trace payload');
    expect(r.json.details).toHaveLength(MAX_LISTED_ISSUES);
    expect(r.json.details[0]).toMatchObject({ code: 'invalid_type', path: ['spans', 0] });
    expect(r.json.issueCount).toBe(50_000);
    expect(r.json.detailsNote).toBe('The first 20 of 50,000 issues are listed; the rest are left out to keep this response small.');
    expect(r.bytes).toBeLessThan(5_000);
  });

  it('still lists every issue of a trace wrong in a few places, with the same fields as before and the count', async () => {
    const base = await dashboard();
    const r = await post(`${base}/api/v1/traces`, { agent_name: 7, output: 'x', latency_ms: 'slow', spans: [0] });
    expect(r.status).toBe(400);
    expect(r.json.details.map((d) => d.path)).toEqual([['agent_name'], ['latency_ms'], ['spans', 0]]);
    expect(r.json.issueCount).toBe(3);
    expect(r.json.detailsNote).toBeUndefined();
    expect(Object.keys(r.json).sort()).toEqual(['details', 'error', 'issueCount']);
  });

  it('names at most 20 of 1,000 unknown keys, and says how many there were', async () => {
    const base = await dashboard();
    const extra = Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [`k${i}`, 0]));
    const r = await post(`${base}/api/v1/traces`, { agent_name: 'a', output: 'x', ...extra });
    expect(r.status).toBe(400);
    const [issue] = r.json.details;
    expect(issue.code).toBe('unrecognized_keys');
    expect(issue.keys).toHaveLength(20);
    expect(issue.keyCount).toBe(1_000);
    expect(issue.message).toContain('"k19" and 980 more');
    expect(r.bytes).toBeLessThan(3_000);
  });
});

describe('POST /v1/traces (OTLP)', () => {
  it("says why a span was dropped in three issues and how many more, however many it had", async () => {
    const base = await dashboard();
    const span = { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', name: 's', startTimeUnixNano: '1', endTimeUnixNano: '2', attributes: Array(10_000).fill(0) };
    const res = await fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] }) });
    const text = await res.text();
    const body = JSON.parse(text) as { partialSuccess: { rejectedSpans: number; errorMessage: string } };
    expect(body.partialSuccess.rejectedSpans).toBe(1);
    expect(body.partialSuccess.errorMessage).toMatch(/^attributes\.0: .*; attributes\.2: .*; and 9,997 more$/);
    expect(Buffer.byteLength(text)).toBeLessThan(2_000);
  });
});

describe('an MCP tool call with unknown arguments', () => {
  it('names at most 20 of them, and how many more', async () => {
    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const { mcpServer } = createIrisServer(defaultConfig, storage, undefined, { warn: () => {} });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverSide);
    const client = new Client({ name: 'bounded-errors', version: '0.1.0' });
    await client.connect(clientSide);
    cleanup.push(async () => {
      await client.close();
      await storage.close();
    });
    const extra = Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [`arg${i}`, 0]));
    const result = (await client.callTool({ name: 'evaluate_output', arguments: { output: 'x', ...extra } })) as ToolResult;
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('"arg19" and 980 more');
    expect(text).not.toContain('"arg20"');
  });
});

describe('a request body over the element limit', () => {
  const tooMany = (limit: number) => `The request body holds more than ${limit} array elements and object keys`;
  const stored = async () => (await lastStorage!.queryTraces(LOCAL_TENANT, {})).total;

  it('is answered 413 on POST /api/v1/traces before the schema reads it, and nothing is stored', async () => {
    const base = await dashboard();
    const res = await fetch(`${base}/api/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_name: 'a', output: 'x', spans: Array(100_001).fill(0) }) });
    const text = await res.text();
    expect(res.status).toBe(413);
    expect(JSON.parse(text)).toEqual({ error: expect.stringContaining(tooMany(100_000)), limit: 100_000 });
    expect(Buffer.byteLength(text)).toBeLessThan(400);
    expect(await stored()).toBe(0);
  });

  it('passes a body of exactly the limit on to the route, and refuses one element more', async () => {
    // { agent_name, output, tool_calls: [{ tool_name } x n] }: 3 + 2n elements.
    const body = (n: number) => ({ agent_name: 'a', output: 'x', tool_calls: Array.from({ length: n }, () => ({ tool_name: 't' })) });
    const exact = await dashboard(23);
    expect((await fetch(`${exact}/api/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(10)) })).status).toBe(201);
    const under = await dashboard(22);
    expect((await fetch(`${under}/api/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(10)) })).status).toBe(413);
  });

  it('is answered 413 on every JSON route, not only trace ingest', async () => {
    const base = await dashboard(50);
    const res = await fetch(`${base}/api/v1/datasets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'd', case_keys: Array.from({ length: 60 }, (_, i) => `c${i}`) }) });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { limit: number }).limit).toBe(50);
  });

  it('is answered 413 on POST /v1/traces as JSON over the shared limit, and as protobuf over its own ceiling as it decodes', async () => {
    const base = await dashboard();
    const span = { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', name: 's', startTimeUnixNano: '1', endTimeUnixNano: '2', attributes: Array(100_001).fill(0) };
    const json = await fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] }) });
    expect(json.status).toBe(413);
    // One empty attribute (field 9, length 0) more than the protobuf ceiling, in one span.
    const ceiling = protobufElementCeiling(defaultConfig.security.maxInputElements, requestSizeLimitBytes(defaultConfig.security.requestSizeLimit));
    expect(ceiling).toBe(209_716);
    const varint = (n: number) => { const out: number[] = []; while (n > 127) { out.push((n & 127) | 128); n >>>= 7; } out.push(n); return Buffer.from(out); };
    const wrap = (tag: number, inner: Buffer) => Buffer.concat([Buffer.from([tag]), varint(inner.length), inner]);
    const attributes = Buffer.alloc((ceiling + 1) * 2);
    for (let i = 0; i <= ceiling; i++) attributes[i * 2] = 0x4a;
    const pb = wrap(0x0a, wrap(0x12, wrap(0x12, attributes)));
    const proto = await fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: pb });
    expect(proto.status).toBe(413);
    expect(((await proto.json()) as { error: string }).error).toContain(tooMany(ceiling));
    expect(await stored()).toBe(0);
  });

  it('accepts a 1 MB protobuf batch from the plain Python exporter, which holds more elements than the shared limit', async () => {
    // python-plain.pb (a real exporter body) repeated to just under 1 MB, ten spans to a trace, every id its own.
    const one = readFileSync(resolve(__dirname, '..', 'fixtures', 'otlp', 'python-plain.pb'));
    const first = (decodeExportTraceServiceRequest(one).resourceSpans[0] as { scopeSpans: Array<{ spans: Array<{ traceId: string; spanId: string }> }> }).scopeSpans[0].spans[0];
    const traceAt = one.indexOf(Buffer.from(first.traceId, 'hex'));
    const spanAt = one.indexOf(Buffer.from(first.spanId, 'hex'));
    expect(traceAt).toBeGreaterThan(-1);
    expect(spanAt).toBeGreaterThan(-1);
    const copies = Math.floor(requestSizeLimitBytes(defaultConfig.security.requestSizeLimit) / one.length);
    const batch = Buffer.alloc(copies * one.length);
    for (let i = 0; i < copies; i++) {
      const copy = Buffer.from(one);
      copy.writeUInt32BE(Math.floor(i / 10) + 1, traceAt + 12);
      copy.writeUInt32BE(i + 1, spanAt + 4);
      copy.copy(batch, i * one.length);
    }
    expect(batch.length).toBeGreaterThan(1_000_000);
    expect(countElements(decodeExportTraceServiceRequest(batch), Infinity)).toBeGreaterThan(defaultConfig.security.maxInputElements);

    const base = await dashboard();
    const res = await fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: batch });
    const body = (await res.json()) as { partialSuccess?: unknown };
    expect(res.status).toBe(200);
    expect(body.partialSuccess).toBeUndefined();
    expect(await stored()).toBe(Math.ceil(copies / 10));
  }, 30_000);

  it('lets the real protobuf exports in tests/fixtures/otlp through at the default', async () => {
    const base = await dashboard();
    for (const name of ['python-plain', 'openai-agents', 'langsmith-langgraph']) {
      const pb = readFileSync(resolve(__dirname, '..', 'fixtures', 'otlp', `${name}.pb`));
      const res = await fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: pb });
      expect(res.status, name).toBe(200);
    }
  });
});
