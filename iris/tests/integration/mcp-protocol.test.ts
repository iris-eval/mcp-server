import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { defaultConfig } from '../../src/config/defaults.js';

describe('MCP Protocol Integration', () => {
  let client: Client;
  let storage: SqliteAdapter;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();

    const { mcpServer } = createIrisServer(defaultConfig, storage);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '0.1.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
  });

  it('should list available tools', async () => {
    const result = await client.listTools();
    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toContain('log_trace');
    expect(toolNames).toContain('evaluate_output');
    expect(toolNames).toContain('get_traces');
  });

  it('should log a trace via MCP', async () => {
    const result = await client.callTool({
      name: 'log_trace',
      arguments: {
        agent_name: 'mcp-test-agent',
        input: 'Hello',
        output: 'World',
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.trace_id).toBeDefined();
    expect(parsed.status).toBe('stored');
  });

  it('should evaluate output via MCP', async () => {
    const result = await client.callTool({
      name: 'evaluate_output',
      arguments: {
        output: 'This is a complete and good response with multiple sentences. It answers the question well.',
        eval_type: 'completeness',
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.score).toBeGreaterThan(0);
    expect(typeof parsed.passed).toBe('boolean');
    expect(parsed.rule_results).toBeDefined();
  });

  it('should get traces via MCP', async () => {
    // First log a trace
    await client.callTool({
      name: 'log_trace',
      arguments: { agent_name: 'query-test' },
    });

    // Then query
    const result = await client.callTool({
      name: 'get_traces',
      arguments: { agent_name: 'query-test' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.total).toBe(1);
    expect(parsed.traces[0].agent_name).toBe('query-test');
  });

  it('should list resources', async () => {
    const result = await client.listResources();
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain('iris://dashboard/summary');
  });

  it('should read dashboard summary resource', async () => {
    const result = await client.readResource({ uri: 'iris://dashboard/summary' });
    const content = result.contents[0];
    const parsed = JSON.parse(content.text as string);
    expect(parsed.total_traces).toBeDefined();
  });

  it('should complete a full trace-evaluate-query cycle', async () => {
    // Log
    const logResult = await client.callTool({
      name: 'log_trace',
      arguments: {
        agent_name: 'cycle-test',
        output: 'A comprehensive and well-formed response.',
      },
    });
    const traceId = JSON.parse((logResult.content as Array<{ text: string }>)[0].text).trace_id;

    // Evaluate
    await client.callTool({
      name: 'evaluate_output',
      arguments: {
        output: 'A comprehensive and well-formed response.',
        eval_type: 'completeness',
        trace_id: traceId,
      },
    });

    // Query
    const queryResult = await client.callTool({
      name: 'get_traces',
      arguments: { agent_name: 'cycle-test', include_summary: true },
    });
    const parsed = JSON.parse((queryResult.content as Array<{ text: string }>)[0].text);
    expect(parsed.total).toBe(1);
    expect(parsed.summary).toBeDefined();
  });
});
