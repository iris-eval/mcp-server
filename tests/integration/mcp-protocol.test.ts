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
    // Original 3 (v0.1)
    expect(toolNames).toContain('log_trace');
    expect(toolNames).toContain('evaluate_output');
    expect(toolNames).toContain('get_traces');
    // Added v0.4 — lifecycle management per Glama Tool Count dimension
    expect(toolNames).toContain('list_rules');
    expect(toolNames).toContain('deploy_rule');
    expect(toolNames).toContain('delete_rule');
    expect(toolNames).toContain('delete_trace');
    // Added v0.4 — LLM-as-Judge (8th tool, semantic eval path)
    expect(toolNames).toContain('evaluate_with_llm_judge');
    // Snapshot — if this changes, Glama Server Coherence dimension
    // may reshuffle. Update check-product-claims.sh alongside.
    expect(result.tools.length).toBe(8);
  });

  it('every tool exposes behavioral annotations for agent discovery', async () => {
    // Glama's Tool Definition Quality Score requires MCP annotations:
    // readOnlyHint / destructiveHint / idempotentHint / openWorldHint. The
    // dashboard scanner reads them from tools/list. Missing annotations
    // drop the score from 5/5 → 2/5 on the Behavior dimension. This test
    // makes sure the annotations survive the round-trip for every tool.
    const result = await client.listTools();
    const expectations: Record<
      string,
      {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
      }
    > = {
      log_trace: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      evaluate_output: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      get_traces: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      list_rules: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      deploy_rule: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      delete_rule: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      delete_trace: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      evaluate_with_llm_judge: {
        readOnlyHint: false,      // Writes eval_result + spends money
        destructiveHint: false,   // Creates data; doesn't overwrite/delete
        idempotentHint: false,    // Provider non-determinism; cost varies
        openWorldHint: true,      // External API call to Anthropic/OpenAI
      },
    };
    for (const [name, hints] of Object.entries(expectations)) {
      const tool = result.tools.find((t) => t.name === name);
      expect(tool, `tool ${name} must be registered`).toBeDefined();
      expect(tool!.annotations, `tool ${name} must carry annotations`).toBeDefined();
      expect(tool!.annotations!.readOnlyHint).toBe(hints.readOnlyHint);
      expect(tool!.annotations!.destructiveHint).toBe(hints.destructiveHint);
      expect(tool!.annotations!.idempotentHint).toBe(hints.idempotentHint);
      expect(tool!.annotations!.openWorldHint).toBe(hints.openWorldHint);
    }
  });

  it('every tool description covers behavior, output, usage, and errors', async () => {
    // Glama's TDQS scores Completeness + Usage Guidelines + Behavior.
    // The 5/5 template requires each description to include:
    //   - A Behavior paragraph (side effects, auth, rate limits)
    //   - Output shape
    //   - Use when / Don't use when
    //   - Error modes
    // Check that each section keyword appears per tool.
    const result = await client.listTools();
    const required = ['Behavior', 'Output shape', 'Use when', "Don't use", 'Error modes'];
    const allToolNames = [
      'log_trace',
      'evaluate_output',
      'get_traces',
      'list_rules',
      'deploy_rule',
      'delete_rule',
      'delete_trace',
      'evaluate_with_llm_judge',
    ];
    for (const toolName of allToolNames) {
      const tool = result.tools.find((t) => t.name === toolName);
      expect(tool, `tool ${toolName} must be registered`).toBeDefined();
      const desc = tool!.description ?? '';
      for (const section of required) {
        expect(
          desc,
          `tool ${toolName} description must cover "${section}" section`,
        ).toContain(section);
      }
    }
  });

  it('deploy_rule → list_rules → delete_rule round-trip via MCP', async () => {
    // Verify the rule-management lifecycle works end-to-end through
    // the MCP surface (not just the HTTP dashboard API). An agent that
    // discovers a failure pattern can deploy a rule, list to confirm,
    // then later delete when the rule is obsolete.
    const deployed = await client.callTool({
      name: 'deploy_rule',
      arguments: {
        name: `mcp-test-${Date.now()}`,
        description: 'Asserts output has at least 20 characters',
        evalType: 'completeness',
        severity: 'medium',
        definition: {
          name: 'min-length-20',
          type: 'min_length',
          config: { min: 20 },
        },
      },
    });
    const deployContent = deployed.content as Array<{ type: string; text: string }>;
    const deployParsed = JSON.parse(deployContent[0].text);
    expect(deployParsed.rule.id).toMatch(/^rule-[a-f0-9]+$/);
    const ruleId: string = deployParsed.rule.id;

    // list_rules should include the new rule
    const listed = await client.callTool({ name: 'list_rules', arguments: {} });
    const listContent = listed.content as Array<{ type: string; text: string }>;
    const listParsed = JSON.parse(listContent[0].text);
    const found = listParsed.rules.find((r: { id: string }) => r.id === ruleId);
    expect(found).toBeDefined();

    // delete_rule removes it + returns deleted=true
    const deleted = await client.callTool({
      name: 'delete_rule',
      arguments: { rule_id: ruleId },
    });
    const delContent = deleted.content as Array<{ type: string; text: string }>;
    const delParsed = JSON.parse(delContent[0].text);
    expect(delParsed.deleted).toBe(true);

    // Re-deleting is idempotent-ish: returns deleted=false (not an error)
    const reDeleted = await client.callTool({
      name: 'delete_rule',
      arguments: { rule_id: ruleId },
    });
    const reDelContent = reDeleted.content as Array<{ type: string; text: string }>;
    const reDelParsed = JSON.parse(reDelContent[0].text);
    expect(reDelParsed.deleted).toBe(false);
  });

  it('log_trace → delete_trace round-trip via MCP', async () => {
    // Verify single-trace deletion through MCP. log a trace, confirm
    // via get_traces, then delete and confirm it's gone.
    const logged = await client.callTool({
      name: 'log_trace',
      arguments: { agent_name: 'delete-roundtrip-test' },
    });
    const logContent = logged.content as Array<{ type: string; text: string }>;
    const logParsed = JSON.parse(logContent[0].text);
    const traceId: string = logParsed.trace_id;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);

    // Confirm present
    const before = await client.callTool({
      name: 'get_traces',
      arguments: { agent_name: 'delete-roundtrip-test' },
    });
    const beforeContent = before.content as Array<{ type: string; text: string }>;
    const beforeParsed = JSON.parse(beforeContent[0].text);
    expect(
      beforeParsed.traces.find((t: { trace_id: string }) => t.trace_id === traceId),
    ).toBeDefined();

    // Delete
    const deleted = await client.callTool({
      name: 'delete_trace',
      arguments: { trace_id: traceId },
    });
    const delContent = deleted.content as Array<{ type: string; text: string }>;
    const delParsed = JSON.parse(delContent[0].text);
    expect(delParsed.deleted).toBe(true);

    // Confirm gone
    const after = await client.callTool({
      name: 'get_traces',
      arguments: { agent_name: 'delete-roundtrip-test' },
    });
    const afterContent = after.content as Array<{ type: string; text: string }>;
    const afterParsed = JSON.parse(afterContent[0].text);
    expect(
      afterParsed.traces.find((t: { trace_id: string }) => t.trace_id === traceId),
    ).toBeUndefined();
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
