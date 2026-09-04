/*
 * The trajectory reaches the evaluator.
 *
 * `EvalContext.toolCalls` existed before this branch and nothing ever
 * populated it for an evaluation: `evaluate_output` had no `tool_calls`
 * argument, and POST /api/v1/traces stored the tool calls it received and
 * then evaluated as though it had never been told. Every rule that reads
 * what the agent DID was therefore unreachable from both capture paths.
 *
 * These tests assert the wiring itself, at the two real surfaces (the MCP
 * tool over the SDK's own validation, and the HTTP route over a real
 * socket), by capturing the context the engine is handed. They deliberately
 * do NOT assert any rule's verdict — that is the rules' own tests' job.
 * What is proven here is that the data arrives.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { EvalEngine } from '../../src/eval/engine.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import type { EvalContext } from '../../src/types/eval.js';
import type { ToolCallRecord } from '../../src/types/trace.js';

const GREP_MISS: ToolCallRecord[] = [
  {
    tool_name: 'bash',
    input: { command: 'grep -rn "IRIS_TELEMETRY" src/' },
    output: '',
    latency_ms: 140,
    error: 'exit code 1 (no matches)',
  },
];

const OUTPUT = 'Yes, there is a switch: set IRIS_TELEMETRY=0 to stop the outbound calls.';

describe('evaluate_output carries the trajectory into the EvalContext', () => {
  let client: Client;
  let storage: SqliteAdapter;
  let seen: EvalContext[];

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    seen = [];

    const { mcpServer, evalEngine } = createIrisServer(defaultConfig, storage);
    // Capture what the tool hands the engine. The response body cannot show
    // this in stage one — no rule reads toolCalls yet — so the context is
    // the observation point.
    for (const method of ['evaluate', 'evaluateAll'] as const) {
      const original = evalEngine[method].bind(evalEngine);
      vi.spyOn(evalEngine, method).mockImplementation(((...args: unknown[]) => {
        seen.push((method === 'evaluate' ? args[1] : args[0]) as EvalContext);
        return (original as (...a: unknown[]) => unknown)(...args);
      }) as never);
    }

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: 'trajectory-test', version: '0.1.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await client.close();
    await storage.close();
  });

  it('round-trips an explicit tool_calls argument, error field included', async () => {
    const result = await client.callTool({
      name: 'evaluate_output',
      arguments: { output: OUTPUT, eval_type: 'all', tool_calls: GREP_MISS },
    });

    expect(result.isError ?? false).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0].toolCalls).toEqual(GREP_MISS);
    // The field the whole arc turns on: it survived the schema.
    expect(seen[0].toolCalls?.[0].error).toBe('exit code 1 (no matches)');
  });

  it('loads the trace’s tool calls when trace_id is given and tool_calls is not', async () => {
    const logged = await client.callTool({
      name: 'log_trace',
      arguments: { agent_name: 'iris-repo-assistant', output: OUTPUT, tool_calls: GREP_MISS },
    });
    const { trace_id: traceId } = JSON.parse(
      (logged.content as Array<{ text: string }>)[0].text,
    ) as { trace_id: string };

    await client.callTool({
      name: 'evaluate_output',
      arguments: { output: OUTPUT, eval_type: 'all', trace_id: traceId },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].toolCalls).toEqual(GREP_MISS);
  });

  it('prefers an explicit tool_calls argument over the stored trace', async () => {
    const logged = await client.callTool({
      name: 'log_trace',
      arguments: { agent_name: 'iris-repo-assistant', output: OUTPUT, tool_calls: GREP_MISS },
    });
    const { trace_id: traceId } = JSON.parse(
      (logged.content as Array<{ text: string }>)[0].text,
    ) as { trace_id: string };

    const override: ToolCallRecord[] = [{ tool_name: 'read_file', input: { path: 'README.md' } }];
    await client.callTool({
      name: 'evaluate_output',
      arguments: { output: OUTPUT, eval_type: 'all', trace_id: traceId, tool_calls: override },
    });

    expect(seen[0].toolCalls).toEqual(override);
  });

  it('leaves toolCalls undefined when neither argument nor trace supplies one', async () => {
    await client.callTool({
      name: 'evaluate_output',
      arguments: { output: OUTPUT, eval_type: 'all' },
    });

    expect(seen[0].toolCalls).toBeUndefined();
  });

  /*
   * A misspelled key inside a tool call is the failure this rejection
   * exists for: `err` instead of `error` would be dropped, and a rule
   * reading `error` would then score a FAILED call as a clean one.
   */
  it('rejects an unknown key inside a tool_calls entry', async () => {
    const result = await client.callTool({
      name: 'evaluate_output',
      arguments: {
        output: OUTPUT,
        tool_calls: [{ tool_name: 'bash', output: '', err: 'exit code 1' }],
      },
    });

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain('err');
    expect(text).toContain('tool_calls entry');
    expect(seen).toHaveLength(0);
  });

  it('rejects the same unknown key on log_trace, so both capture paths agree', async () => {
    const result = await client.callTool({
      name: 'log_trace',
      arguments: {
        agent_name: 'iris-repo-assistant',
        tool_calls: [{ tool_name: 'bash', latency: 140 }],
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('latency');
  });
});

describe('POST /api/v1/traces forwards the trajectory it just stored', () => {
  const booted: Array<{ storage: SqliteAdapter; server: Server }> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const b of booted.splice(0)) {
      b.server.closeAllConnections?.();
      await new Promise<void>((resolve) => b.server.close(() => resolve()));
      await b.storage.close();
    }
  });

  it('passes body.tool_calls into the evaluation context', async () => {
    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const evalEngine = new EvalEngine(
      defaultConfig.eval.defaultThreshold,
      defaultConfig.eval.ruleThresholds,
    );
    const seen: EvalContext[] = [];
    const original = evalEngine.evaluateAll.bind(evalEngine);
    vi.spyOn(evalEngine, 'evaluateAll').mockImplementation((context, custom) => {
      seen.push(context);
      return original(context, custom);
    });

    const dashboard = createDashboardServer(
      storage,
      { ...defaultConfig, dashboard: { ...defaultConfig.dashboard, port: 0 } },
      { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      { evalEngine },
    );
    const server = dashboard.start();
    await new Promise((r) => server.once('listening', r));
    booted.push({ storage, server });
    const port = (server.address() as { port: number }).port;

    const body = JSON.stringify({
      agent_name: 'iris-repo-assistant',
      output: OUTPUT,
      tool_calls: GREP_MISS,
      evaluate: true,
      eval_type: 'all',
    });
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/traces',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(body);
    });

    expect(status).toBe(201);
    expect(seen).toHaveLength(1);
    expect(seen[0].toolCalls).toEqual(GREP_MISS);

    // And the row it stored carries the same calls — one body, one shape.
    const traces = await storage.queryTraces(LOCAL_TENANT, { limit: 1 });
    expect(traces.traces[0].tool_calls).toEqual(GREP_MISS);
  });
});
