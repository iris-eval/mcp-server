import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';

/*
 * Unknown tool arguments must be REJECTED, never silently dropped.
 *
 * Source defect (UAT, adversarially confirmed): evaluate_output called
 * with criteria:["safety"] — a plausible LLM guess — or the one-character
 * typo eval_typ:"safety" plus a junk bogus_param returned SUCCESS with
 * passed:true on text containing an SSN, a credit card, and an AWS key.
 * Zod's default unknown-key stripping meant the DEFAULT completeness
 * bundle ran, no safety rule fired, and nothing in the response said the
 * arguments were ignored. Meanwhile a MISSING required field produced a
 * precise Zod error — inconsistent as well as unsafe.
 *
 * The fix registers every tool with a strict schema (src/tools/
 * strict-input.ts). These tests drive the REAL MCP surface: the SDK's
 * own input validation is the gate under test, not our helper in
 * isolation.
 */

const PII_LADEN_OUTPUT =
  'Customer record: SSN 536-22-8145, card 4111 1111 1111 1111, ' +
  'AWS key AKIAIOSFODNN7EXAMPLE.';

describe('unknown tool arguments are rejected (strict schemas)', () => {
  let client: Client;
  let storage: SqliteAdapter;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();

    const { mcpServer } = createIrisServer(defaultConfig, storage);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);

    client = new Client({ name: 'unknown-args-test', version: '0.1.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
  });

  it('evaluate_output rejects a guessed argument name instead of scoring the wrong bundle', async () => {
    // The exact reported shape: a plausible guess (criteria) + junk. Before
    // the fix this returned passed:true on PII-laden text.
    const result = await client.callTool({
      name: 'evaluate_output',
      arguments: {
        output: PII_LADEN_OUTPUT,
        criteria: ['safety'],
        bogus_param: 'junk',
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    // Well-formed and actionable: names every offending key AND lists the
    // valid ones so the caller can self-correct on the next attempt.
    expect(text).toContain('"criteria"');
    expect(text).toContain('"bogus_param"');
    expect(text).toContain('Valid arguments:');
    expect(text).toContain('eval_type');
    expect(text).toContain('output');

    // And nothing was scored: a rejected call must not write an eval row.
    const { total } = await storage.queryEvalResults(LOCAL_TENANT, {});
    expect(total).toBe(0);
  });

  it('evaluate_output rejects the one-character typo eval_typ', async () => {
    const result = await client.callTool({
      name: 'evaluate_output',
      arguments: { output: PII_LADEN_OUTPUT, eval_typ: 'safety' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('"eval_typ"');
    expect(text).toContain('eval_type');
  });

  it('the corrected call then runs the safety bundle and flags the PII', async () => {
    // The rejection is only actionable if fixing the argument name works —
    // the same content with the correct spelling must reach the safety rules.
    const result = await client.callTool({
      name: 'evaluate_output',
      arguments: { output: PII_LADEN_OUTPUT, eval_type: 'safety' },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    const pii = parsed.rule_results.find((r: { ruleName: string }) => r.ruleName === 'no_pii');
    expect(pii).toBeDefined();
    expect(pii.passed).toBe(false);

    // Asserted at the RULE, not the top-level `passed`. Whether one failed
    // safety rule should hard-fail the whole result is a separate defect
    // (the aggregate is a score threshold — src/eval/engine.ts) fixed on its
    // own branch. Pinning the aggregate here would couple this test to that
    // fix and break on whichever lands second.
  });

  it('accepts every documented argument — strictness must not cost legitimate calls', async () => {
    // The risk with a strict schema is over-correction: rejecting real
    // arguments. These two calls populate EVERY optional field the schemas
    // document, including the nested shapes (custom_rules, token_usage,
    // spans, tool_calls) and the deliberately free-form record fields
    // (metadata, attributes, config) whose arbitrary keys must still pass.
    const traceResult = await client.callTool({
      name: 'log_trace',
      arguments: {
        agent_name: 'strict-test',
        framework: 'custom',
        input: 'ping',
        output: 'pong',
        tool_calls: [{ tool_name: 'search', input: { q: 'x' }, output: 'ok', latency_ms: 5 }],
        latency_ms: 42,
        token_usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost_usd: 0.0001,
        metadata: { anything_goes: true, requestId: 'r-1' },
        spans: [
          {
            name: 'root',
            kind: 'LLM',
            status_code: 'OK',
            start_time: new Date().toISOString(),
            end_time: new Date().toISOString(),
            attributes: { free_form: 'yes' },
            events: [{ name: 'first-token', timestamp: new Date().toISOString() }],
          },
        ],
        timestamp: new Date().toISOString(),
      },
    });
    expect(traceResult.isError).toBeFalsy();

    // Chain the real trace_id rather than a fabricated one: trace_id is a
    // foreign key, so inventing a value fails on the constraint and would
    // tell us nothing about strictness either way.
    const { trace_id } = JSON.parse((traceResult.content as Array<{ text: string }>)[0].text);

    const evalResult = await client.callTool({
      name: 'evaluate_output',
      arguments: {
        output: 'The capital of France is Paris.',
        eval_type: 'custom',
        expected: 'Paris',
        input: 'What is the capital of France?',
        trace_id,
        custom_rules: [
          { name: 'mentions-paris', type: 'contains_keywords', config: { keywords: ['Paris'] }, weight: 2 },
        ],
        cost_usd: 0.0012,
        token_usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      },
    });
    expect(evalResult.isError).toBeFalsy();
  });

  it('every tool rejects an unknown argument and names it', async () => {
    // Minimal OTHERWISE-VALID arguments per tool, plus one junk key. The
    // junk key must be the reason the call fails — validation happens
    // before the handler, so even the API-key-gated tools reject cleanly.
    const calls: Record<string, Record<string, unknown>> = {
      log_trace: { agent_name: 'strict-test' },
      evaluate_output: { output: 'hello there, world' },
      get_traces: {},
      list_rules: {},
      deploy_rule: {
        name: 'strict-test-rule',
        evalType: 'completeness',
        definition: { name: 'strict-test-rule', type: 'min_length', config: { min: 1 } },
      },
      delete_rule: { rule_id: 'rule-abc123' },
      delete_trace: { trace_id: 'a'.repeat(32) },
      evaluate_with_llm_judge: {
        output: 'judged text',
        template: 'accuracy',
        model: 'claude-haiku-4-5',
      },
      verify_citations: { output: 'cited text', model: 'claude-haiku-4-5' },
    };

    // Guard against drift: if a tool is added or renamed, this matrix must
    // follow it — the strictness guarantee covers the WHOLE surface.
    const { tools } = await client.listTools();
    expect(new Set(Object.keys(calls))).toEqual(new Set(tools.map((t) => t.name)));

    for (const [name, args] of Object.entries(calls)) {
      const result = await client.callTool({
        name,
        arguments: { ...args, bogus_param: 'junk' },
      });
      expect(result.isError, `${name} must reject an unknown argument`).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text, `${name} must name the offending key`).toContain('"bogus_param"');
      expect(text, `${name} must list the valid arguments`).toContain('Valid arguments:');
    }
  });

  it('tools/list advertises additionalProperties:false so clients see the contract', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(
        (tool.inputSchema as { additionalProperties?: boolean }).additionalProperties,
        `tool ${tool.name} must advertise a closed input schema`,
      ).toBe(false);
    }
  });
});
