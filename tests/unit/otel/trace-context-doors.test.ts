/*
 * Trace context reaches the store through both doors (arc 9, N-12).
 *
 * log_trace reads `_meta.traceparent` off the MCP request (SEP-414);
 * POST /api/v1/traces reads the `traceparent` header. Both store it under
 * metadata.trace_context; a request without one stores nothing extra.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../../src/server.js';
import { createDashboardServer } from '../../../src/dashboard/server.js';
import { createCustomRuleStore } from '../../../src/custom-rule-store.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { IrisConfig } from '../../../src/types/config.js';

const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
type Content = Array<{ type: string; text: string }>;
const parse = (r: { content?: unknown }) => JSON.parse((r.content as Content)[0].text) as Record<string, unknown>;

describe('log_trace reads _meta (SEP-414)', () => {
  let client: Client;
  let storage: SqliteAdapter;
  let ruleDir: string;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    ruleDir = mkdtempSync(join(tmpdir(), 'iris-trace-context-'));
    const ruleStore = createCustomRuleStore({ pathFor: () => join(ruleDir, 'custom-rules.json'), auditPath: join(ruleDir, 'audit.log') });
    const { mcpServer } = createIrisServer(defaultConfig, storage, ruleStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: 'trace-context', version: '0.1.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
    rmSync(ruleDir, { recursive: true, force: true });
  });

  it('a call carrying traceparent in _meta stores the context; one without stores none', async () => {
    const withCtx = parse(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'bot', input: 'q', output: 'a', metadata: { requestId: 'r-1' } }, _meta: { traceparent: TP, baggage: 'session_id=s-9' } }));
    const stored = await storage.getTrace(LOCAL_TENANT, withCtx.trace_id as string);
    expect(stored?.metadata?.requestId).toBe('r-1');
    expect(stored?.metadata?.trace_context).toMatchObject({ traceparent: TP, trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', parent_span_id: '00f067aa0ba902b7', sampled: true, baggage: 'session_id=s-9' });

    const without = parse(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'bot', input: 'q', output: 'a' } }));
    const plain = await storage.getTrace(LOCAL_TENANT, without.trace_id as string);
    expect(plain?.metadata?.trace_context).toBeUndefined();
  });

  it('evaluate_output writes the context it carries onto a linked trace that has none, keeps one the trace already has, and changes nothing without a trace_id', async () => {
    const OTHER = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
    // A trace logged without a context: the evaluation's context lands on it.
    const bare = parse(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'bot', input: 'q', output: 'a' } }));
    const first = parse(await client.callTool({ name: 'evaluate_output', arguments: { output: 'a', trace_id: bare.trace_id as string }, _meta: { traceparent: TP } }));
    expect(first).not.toHaveProperty('trace_context');
    expect((await storage.getTrace(LOCAL_TENANT, bare.trace_id as string))?.metadata?.trace_context).toMatchObject({ trace_id: '4bf92f3577b34da6a3ce929d0e0e4736' });
    // A second evaluation with another context does not overwrite the first: the export was built on it.
    await client.callTool({ name: 'evaluate_output', arguments: { output: 'a', trace_id: bare.trace_id as string }, _meta: { traceparent: OTHER } });
    expect((await storage.getTrace(LOCAL_TENANT, bare.trace_id as string))?.metadata?.trace_context).toMatchObject({ trace_id: '4bf92f3577b34da6a3ce929d0e0e4736' });
    // A trace logged with its own context keeps it.
    const logged = parse(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'bot', input: 'q', output: 'a' }, _meta: { traceparent: OTHER } }));
    await client.callTool({ name: 'evaluate_output', arguments: { output: 'a', trace_id: logged.trace_id as string }, _meta: { traceparent: TP } });
    expect((await storage.getTrace(LOCAL_TENANT, logged.trace_id as string))?.metadata?.trace_context).toMatchObject({ trace_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    // No trace_id: nothing to carry it, the response is the same shape.
    const loose = parse(await client.callTool({ name: 'evaluate_output', arguments: { output: 'a' }, _meta: { traceparent: TP } }));
    expect(loose).not.toHaveProperty('trace_context');
    expect(await storage.updateTraceMetadata(LOCAL_TENANT, 'no-such-trace', { trace_context: {} })).toBe(false);
  });
});

describe('POST /api/v1/traces reads the traceparent header', () => {
  let storage: SqliteAdapter;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const config: IrisConfig = { ...defaultConfig, dashboard: { ...defaultConfig.dashboard, port: 0 } };
    const evalEngine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds, config.eval);
    server = createDashboardServer(storage, config, mockLogger, { evalEngine }).start();
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage.close();
  });

  it('the header lands on the stored trace; a malformed one is ignored, not refused', async () => {
    const ok = await fetch(`${base}/api/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json', traceparent: TP, tracestate: 'vendor=abc' }, body: JSON.stringify({ agent_name: 'bot', input: 'q', output: 'a' }) });
    expect(ok.status).toBe(201);
    const { trace_id } = (await ok.json()) as { trace_id: string };
    const stored = await storage.getTrace(LOCAL_TENANT, trace_id);
    expect(stored?.metadata?.trace_context).toMatchObject({ traceparent: TP, tracestate: 'vendor=abc', trace_id: '4bf92f3577b34da6a3ce929d0e0e4736' });

    const bad = await fetch(`${base}/api/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json', traceparent: 'nonsense' }, body: JSON.stringify({ agent_name: 'bot', input: 'q', output: 'a' }) });
    expect(bad.status).toBe(201);
    const plain = await storage.getTrace(LOCAL_TENANT, ((await bad.json()) as { trace_id: string }).trace_id);
    expect(plain?.metadata?.trace_context).toBeUndefined();

    // The API returns it with the trace (the drawer renders metadata as it is).
    const read = await fetch(`${base}/api/v1/traces/${trace_id}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { trace: { metadata?: { trace_context?: { traceparent?: string } } } }).trace.metadata?.trace_context?.traceparent).toBe(TP);
  });

  it('the OTLP door reads the same header onto every trace of the request', async () => {
    const payload = {
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'bot' } }] },
        scopeSpans: [{ spans: [{ traceId: '5b8efff798038103d269b633813fc60c', spanId: 'eee19b7ec3c1b174', name: 'run', kind: 1, startTimeUnixNano: '1758456000000000000', endTimeUnixNano: '1758456001000000000', attributes: [{ key: 'gen_ai.output.messages', value: { stringValue: 'a' } }] }] }],
      }],
    };
    const res = await fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json', traceparent: TP }, body: JSON.stringify(payload) });
    expect(res.status).toBe(200);
    const { 'iris-eval': block } = (await res.json()) as { 'iris-eval': { stored: Array<{ trace_id: string }> } };
    const stored = await storage.getTrace(LOCAL_TENANT, block.stored[0].trace_id);
    expect(stored?.metadata?.trace_context).toMatchObject({ traceparent: TP });
    expect((stored?.metadata as { otel?: { trace_id?: string } })?.otel?.trace_id).toBe('5b8efff798038103d269b633813fc60c');
  });
});
