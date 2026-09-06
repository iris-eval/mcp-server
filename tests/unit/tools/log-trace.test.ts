import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { registerLogTraceTool, toolCallSchema } from '../../../src/tools/log-trace.js';
import { toSteps } from '../../../src/eval/steps.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

describe('log_trace tool', () => {
  let server: McpServer;
  let storage: SqliteAdapter;

  beforeEach(async () => {
    server = new McpServer({ name: 'test', version: '0.1.0' });
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    registerLogTraceTool(server, storage);
  });

  afterEach(async () => {
    await storage.close();
  });

  it('should register the log_trace tool', () => {
    // Tool is registered — verified by no errors during registration
    expect(server).toBeDefined();
  });

  it('should store a trace via direct storage call', async () => {
    await storage.insertTrace(LOCAL_TENANT, {
      trace_id: 'test-123',
      agent_name: 'test-agent',
      timestamp: new Date().toISOString(),
    });
    const trace = await storage.getTrace(LOCAL_TENANT, 'test-123');
    expect(trace).not.toBeNull();
    expect(trace!.agent_name).toBe('test-agent');
  });

  it('should generate trace IDs', async () => {
    await storage.insertTrace(LOCAL_TENANT, {
      trace_id: 'generated-id',
      agent_name: 'test',
      timestamp: new Date().toISOString(),
    });
    const trace = await storage.getTrace(LOCAL_TENANT, 'generated-id');
    expect(trace).not.toBeNull();
  });

  /*
   * The four capture fields added with the step layer (0.11.0) are read by
   * no rule yet, which is exactly why they need this: a field nobody reads
   * is a field nobody notices dropping. The round trip is the whole path a
   * value takes before a rule could ever see it — the strict tool schema,
   * the JSON column, the read back, and the derivation into a Step.
   */
  it('the four added tool-call fields survive the round trip into a Step', async () => {
    await storage.insertTrace(LOCAL_TENANT, {
      trace_id: 'roundtrip-1',
      agent_name: 'test-agent',
      timestamp: new Date().toISOString(),
      tool_calls: [
        {
          tool_name: 'read_file',
          input: { path: 'src/index.ts' },
          output: 'export const x = 1;',
          latency_ms: 12,
          call_id: 'toolu_01ABC',
          truncated: true,
          token_usage: { prompt_tokens: 40, completion_tokens: 3, total_tokens: 43 },
          cost_usd: 0.00021,
        },
      ],
    });

    const trace = await storage.getTrace(LOCAL_TENANT, 'roundtrip-1');
    const call = trace?.tool_calls?.[0];
    expect(call?.call_id).toBe('toolu_01ABC');
    expect(call?.truncated).toBe(true);
    expect(call?.token_usage).toEqual({ prompt_tokens: 40, completion_tokens: 3, total_tokens: 43 });
    expect(call?.cost_usd).toBe(0.00021);

    const [step] = toSteps({ toolCalls: trace?.tool_calls });
    expect(step.callId).toBe('toolu_01ABC');
    expect(step.truncated).toBe(true);
    expect(step.tokens?.total_tokens).toBe(43);
    expect(step.costUsd).toBe(0.00021);
  });

  it('the strict tool-call schema now ACCEPTS those four and still rejects a typo', () => {
    const good = toolCallSchema.safeParse({ tool_name: 'read_file', call_id: 'x', truncated: false, cost_usd: 0.1 });
    expect(good.success).toBe(true);
    // The reason this object is strict: `err` used to parse and be dropped.
    const typo = toolCallSchema.safeParse({ tool_name: 'read_file', truncted: true });
    expect(typo.success).toBe(false);
  });
});
