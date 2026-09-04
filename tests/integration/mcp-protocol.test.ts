import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import {
  __clearCitationCacheForTests,
  __setDnsLookupForTests,
} from '../../src/eval/citation-verify/resolve.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';

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
    // Added v0.4 — Semantic citation verification (9th tool, SSRF-guarded
    // + LLM judge pipeline for citation-supported claims)
    expect(toolNames).toContain('verify_citations');
    // Snapshot — if this changes, Glama Server Coherence dimension
    // may reshuffle. Update check-product-claims.sh alongside.
    expect(result.tools.length).toBe(9);
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
      verify_citations: {
        readOnlyHint: false,      // Writes eval_result + spends money
        destructiveHint: false,   // Creates data; doesn't overwrite/delete
        idempotentHint: false,    // Outbound fetches + LLM non-determinism
        openWorldHint: true,      // Fetches citation URLs + calls LLM API
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

  it('every tool description covers behavior, output, usage, parameters, and errors', async () => {
    // Glama's TDQS scores Completeness + Usage Guidelines + Behavior +
    // Parameter Semantics. The 5/5 template requires each description to
    // include:
    //   - A Behavior paragraph (side effects, auth, rate limits)
    //   - Output shape (concrete JSON example)
    //   - Use when / Don't use when (sibling-aware usage guidance)
    //   - Parameters (cross-parameter semantics: required-when, override
    //     behavior, default rationale, range constraints — Glama Parameter
    //     Semantics 5/5 wants intent beyond what Zod schemas already say)
    //   - Error modes (failure conditions + status codes)
    // Check that each section keyword appears per tool. Drift here drops
    // the per-tool grade and (via 60% mean + 40% min) the server TDQS.
    const result = await client.listTools();
    const required = [
      'Behavior',
      'Output shape',
      'Use when',
      "Don't use",
      'Parameters',
      'Error modes',
    ];
    const allToolNames = [
      'log_trace',
      'evaluate_output',
      'get_traces',
      'list_rules',
      'deploy_rule',
      'delete_rule',
      'delete_trace',
      'evaluate_with_llm_judge',
      'verify_citations',
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

  it('every tool description names >= 2 sibling tools (Glama Purpose 5/5)', async () => {
    // Glama's Purpose Clarity dimension scores down (4/5) when a
    // description "doesn't differentiate from sibling tools." Every tool
    // here must explicitly reference at least 2 of its 8 siblings by name.
    // This is the second-sentence "Sibling tools — ..." pattern. Drift
    // (e.g., a new tool that doesn't list siblings) drops this gate.
    const result = await client.listTools();
    const allToolNames = [
      'log_trace',
      'evaluate_output',
      'get_traces',
      'list_rules',
      'deploy_rule',
      'delete_rule',
      'delete_trace',
      'evaluate_with_llm_judge',
      'verify_citations',
    ];
    for (const toolName of allToolNames) {
      const tool = result.tools.find((t) => t.name === toolName);
      expect(tool, `tool ${toolName} must be registered`).toBeDefined();
      const desc = tool!.description ?? '';
      const siblings = allToolNames.filter((n) => n !== toolName);
      const mentioned = siblings.filter((n) => desc.includes(n));
      expect(
        mentioned.length,
        `tool ${toolName} must name >=2 sibling tools (named: ${mentioned.join(', ') || 'none'})`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('every Zod parameter has a substantive .describe() (>=20 chars)', async () => {
    // Glama's Parameter Semantics 3/5 baseline came from "schema does the
    // heavy lifting; description adds nothing beyond." The fix is twofold:
    // a Parameters section in the description (covered above) AND
    // substantive per-parameter Zod descriptions. A 5-char .describe() like
    // "Type" passes Zod's truthy check but flunks Glama's substance bar.
    const result = await client.listTools();
    const skipNames = new Set<string>(); // keep configurable for future allow-list
    for (const tool of result.tools) {
      if (skipNames.has(tool.name)) continue;
      const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> })
        .properties;
      if (!props) continue;
      for (const [paramName, prop] of Object.entries(props)) {
        const desc = prop.description ?? '';
        expect(
          desc.length,
          `tool ${tool.name} parameter "${paramName}" needs .describe() of >=20 chars (got ${desc.length}: "${desc}")`,
        ).toBeGreaterThanOrEqual(20);
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

  it('get_traces rejects limit outside 1..1000 at the tool boundary (#332)', async () => {
    // The description always promised "max 1000 (anything higher returns
    // 400)" but the schema had no .max() — limit:-1 became SQLite's
    // "LIMIT -1" and returned every row. Out-of-range limits must fail as
    // clean invalid-params errors (the SDK surfaces them as isError results
    // whose text names the validation failure), mirroring the dashboard's
    // traceQuerySchema.
    for (const limit of [1001, -1]) {
      const rejected = await client.callTool({ name: 'get_traces', arguments: { limit } });
      expect(rejected.isError, `limit ${limit} must be rejected`).toBe(true);
      expect((rejected.content as Array<{ text: string }>)[0].text).toMatch(
        /Input validation error/,
      );
    }

    // The documented maximum itself stays valid.
    const ok = await client.callTool({ name: 'get_traces', arguments: { limit: 1000 } });
    const parsed = JSON.parse((ok.content as Array<{ text: string }>)[0].text);
    expect(parsed.limit).toBe(1000);
  });

  it('deploy_rule rejects names over 80 chars cleanly at the tool boundary (#332)', async () => {
    // The tool schema allowed 120 while the store caps at 80, so a 100-char
    // name passed the tool and surfaced the store's raw ZodError as a 500.
    // One limit (the store's 80), enforced by the schema: the SDK reports a
    // clean invalid-params validation error, never an in-handler ZodError
    // throw (whose text would carry no "Input validation error" marker).
    const rejected = await client.callTool({
      name: 'deploy_rule',
      arguments: {
        name: 'x'.repeat(100),
        evalType: 'completeness',
        definition: { name: 'long-name-check', type: 'min_length', config: { min: 20 } },
      },
    });
    expect(rejected.isError).toBe(true);
    expect((rejected.content as Array<{ text: string }>)[0].text).toMatch(
      /Input validation error/,
    );
  });

  it('deploy_rule fires immediately and delete_rule stops it firing in-process (#332)', async () => {
    // delete_rule promises the rule "stops firing immediately on the live
    // process", and deploy_rule promises it "activates immediately for the
    // running process". Prove both through the real MCP surface: deploy →
    // the next evaluate_output runs the rule → delete → the next
    // evaluate_output no longer does. No restart in between.
    const ruleName = 'canary-hot-removal';
    const deployed = await client.callTool({
      name: 'deploy_rule',
      arguments: {
        name: ruleName,
        description: 'Canary for in-process rule removal',
        evalType: 'completeness',
        definition: {
          name: ruleName,
          type: 'contains_keywords',
          config: { keywords: ['canary'] },
        },
      },
    });
    const ruleId: string = JSON.parse(
      (deployed.content as Array<{ text: string }>)[0].text,
    ).rule.id;

    const firing = await client.callTool({
      name: 'evaluate_output',
      arguments: {
        output: 'A canary sentence that satisfies the deployed keyword rule.',
        eval_type: 'completeness',
      },
    });
    const firingParsed = JSON.parse((firing.content as Array<{ text: string }>)[0].text);
    expect(
      firingParsed.rule_results.find((r: { ruleName: string }) => r.ruleName === ruleName),
    ).toBeDefined();

    const deleted = await client.callTool({
      name: 'delete_rule',
      arguments: { rule_id: ruleId },
    });
    expect(JSON.parse((deleted.content as Array<{ text: string }>)[0].text).deleted).toBe(true);

    const silenced = await client.callTool({
      name: 'evaluate_output',
      arguments: {
        output: 'A canary sentence that satisfies the deployed keyword rule.',
        eval_type: 'completeness',
      },
    });
    const silencedParsed = JSON.parse((silenced.content as Array<{ text: string }>)[0].text);
    expect(
      silencedParsed.rule_results.find((r: { ruleName: string }) => r.ruleName === ruleName),
    ).toBeUndefined();
  });

  it('evaluate_with_llm_judge round-trip via MCP (mocked Anthropic)', async () => {
    // Verifies the LLM judge flow round-trips through MCP. Mocks
    // global.fetch so the Anthropic API call returns a canned response;
    // sets IRIS_ANTHROPIC_API_KEY in-process. The unit tests at
    // tests/unit/eval/llm-judge/evaluator.test.ts cover the parsing
    // edge cases — this test exercises the MCP wiring on top.
    const originalFetch = global.fetch;
    const originalKey = process.env.IRIS_ANTHROPIC_API_KEY;
    process.env.IRIS_ANTHROPIC_API_KEY = 'integration-test-key';
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'msg_int_judge',
            content: [
              {
                type: 'text',
                text: '{"score":0.85,"passed":true,"rationale":"Output is accurate and well-supported","dimensions":{"factual_claims":0.9,"citations":1.0,"internal_consistency":0.8}}',
              },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 30 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as typeof fetch;

    try {
      const result = await client.callTool({
        name: 'evaluate_with_llm_judge',
        arguments: {
          output: 'The sky appears blue due to Rayleigh scattering.',
          template: 'accuracy',
          model: 'claude-haiku-4-5',
        },
      });
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);

      expect(parsed.id).toBeDefined();
      expect(parsed.score).toBe(0.85);
      expect(parsed.passed).toBe(true);
      expect(parsed.rationale).toContain('accurate');
      expect(parsed.dimensions.factual_claims).toBe(0.9);
      expect(parsed.model).toBe('claude-haiku-4-5');
      expect(parsed.provider).toBe('anthropic');
      expect(parsed.template).toBe('accuracy');
      expect(parsed.input_tokens).toBe(100);
      expect(parsed.output_tokens).toBe(30);
      expect(parsed.cost_usd).toBeGreaterThan(0);
      expect(parsed.latency_ms).toBeGreaterThanOrEqual(0);
    } finally {
      global.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.IRIS_ANTHROPIC_API_KEY;
      else process.env.IRIS_ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('verify_citations round-trip via MCP (mocked source fetch + judge)', async () => {
    // Verifies the citation-verify flow round-trips through MCP. The
    // mock fetch dispatches by URL: api.anthropic.com → judge JSON,
    // anything else → the citation source page. DNS lookup is stubbed
    // so resolve.ts's pre-resolve guard doesn't hit real DNS for the
    // example.com fixture host.
    const originalFetch = global.fetch;
    const originalKey = process.env.IRIS_ANTHROPIC_API_KEY;
    process.env.IRIS_ANTHROPIC_API_KEY = 'integration-test-key';
    __setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const hostname = new URL(url).hostname;
      if (hostname === 'api.anthropic.com') {
        return new Response(
          JSON.stringify({
            id: 'msg_int_citation_judge',
            content: [
              {
                type: 'text',
                text: '{"supported":true,"confidence":0.9,"rationale":"the source explicitly contains the assertion"}',
              },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 200, output_tokens: 40 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        'The sky appears blue due to Rayleigh scattering of sunlight in the atmosphere.',
        { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }) as typeof fetch;

    try {
      const result = await client.callTool({
        name: 'verify_citations',
        arguments: {
          output:
            'The sky appears blue due to Rayleigh scattering. See https://example.com/sky-article for details.',
          model: 'claude-haiku-4-5',
          allow_fetch: true,
        },
      });
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);

      expect(parsed.id).toBeDefined();
      expect(parsed.total_citations_found).toBeGreaterThanOrEqual(1);
      expect(parsed.citations.length).toBeGreaterThanOrEqual(1);
      const urlCitation = parsed.citations.find(
        (c: { citation: { kind: string } }) => c.citation.kind === 'url',
      );
      expect(urlCitation).toBeDefined();
      expect(urlCitation.resolve_status).toBe('ok');
      expect(urlCitation.judge).toBeDefined();
      expect(urlCitation.judge.supported).toBe(true);
      expect(urlCitation.judge.confidence).toBe(0.9);
      expect(parsed.total_resolved).toBeGreaterThanOrEqual(1);
      expect(parsed.total_judged).toBeGreaterThanOrEqual(1);
      expect(parsed.total_supported).toBeGreaterThanOrEqual(1);
      expect(parsed.overall_score).toBeGreaterThan(0);
      expect(parsed.passed).toBe(true);
      expect(parsed.total_cost_usd).toBeGreaterThan(0);
    } finally {
      global.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.IRIS_ANTHROPIC_API_KEY;
      else process.env.IRIS_ANTHROPIC_API_KEY = originalKey;
      __clearCitationCacheForTests();
      __setDnsLookupForTests(null);
    }
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

  /*
   * The evaluate_output response contract around critical rules.
   *
   * Six of seven UAT personas read `passed: true` on PII-laden text with
   * nothing in the payload hinting that the safety bundle had never run —
   * they had omitted eval_type and silently got the completeness default.
   * The response names the bundle that ran and says so out loud when the
   * caller never chose one; since the proof release the default itself is
   * every bundle, so an omitted eval_type can no longer skip safety.
   */
  const callEvaluate = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'evaluate_output', arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  };

  it('echoes which eval_type bundle actually ran', async () => {
    // Without the echo, a caller cannot tell a genuine safety pass from a
    // completeness eval that never ran a single safety rule.
    const safety = await callEvaluate({
      output: 'The customer record was updated successfully with no issues to report.',
      eval_type: 'safety',
    });
    expect(safety.eval_type).toBe('safety');

    const completeness = await callEvaluate({
      output: 'This is a complete and good response with multiple sentences. It answers the question well.',
      eval_type: 'completeness',
    });
    expect(completeness.eval_type).toBe('completeness');
  });

  it('an omitted eval_type runs EVERY bundle and the note says so; an explicit choice gets no note', async () => {
    const omitted = await callEvaluate({
      output: 'This is a complete and good response with multiple sentences. It answers the question well.',
    });
    expect(omitted.eval_type).toBe('all');
    expect(omitted.note).toContain('eval_type was omitted');
    expect(omitted.note).toContain('every bundle');
    // Safety rules were part of the run — the whole point of the default.
    const ranRules = new Set(omitted.rule_results.map((r: { ruleName: string }) => r.ruleName));
    expect(ranRules.has('no_pii')).toBe(true);
    expect(ranRules.has('no_injection_patterns')).toBe(true);
    expect(omitted.categories.safety).toBeDefined();

    // Explicitly choosing a bundle — or "all" — is a decision, not an
    // oversight; annotating it would train callers to ignore the field.
    const explicit = await callEvaluate({
      output: 'This is a complete and good response with multiple sentences. It answers the question well.',
      eval_type: 'completeness',
    });
    expect(explicit.eval_type).toBe('completeness');
    expect(explicit.note).toBeUndefined();
    const explicitAll = await callEvaluate({
      output: 'This is a complete and good response with multiple sentences. It answers the question well.',
      eval_type: 'all',
    });
    expect(explicitAll.eval_type).toBe('all');
    expect(explicitAll.note).toBeUndefined();
  });

  it('NO SILENT PARTIAL RUN: an SSN leak fails the eval even when the caller never chose a bundle', async () => {
    // The exact call six of seven UAT personas made — output only. Under
    // the old completeness default this returned passed:true.
    const parsed = await callEvaluate({ output: 'Your SSN is 536-22-8145' });
    expect(parsed.eval_type).toBe('all');
    expect(parsed.passed).toBe(false);
    expect(parsed.critical_failures).toContain('no_pii');
    expect(parsed.categories.safety.passed).toBe(false);
    expect(parsed.note).toContain('eval_type was omitted');

    // The stored row says what ran, so a later reader cannot mistake it
    // for a single-bundle eval.
    const stored = await storage.queryEvalResults(LOCAL_TENANT, {});
    expect(stored.total).toBe(1);
    expect(stored.results[0].eval_type).toBe('all');
    expect(stored.results[0].passed).toBe(false);
  });

  it('THE FLAGSHIP: an SSN-laden output fails a safety eval, with critical_failures in the payload', async () => {
    const parsed = await callEvaluate({
      output: 'Your SSN is 536-22-8145',
      input: 'what is the customer record',
      eval_type: 'safety',
    });

    // The score still clears the threshold — the veto, not the arithmetic,
    // is what produces the correct verdict.
    expect(parsed.score).toBeGreaterThanOrEqual(0.7);
    expect(parsed.passed).toBe(false);
    expect(parsed.critical_failures).toContain('no_pii');
    expect(parsed.eval_type).toBe('safety');
    expect(parsed.note).toBeUndefined();
  });

  it('omits critical_failures from the payload when nothing hard-failed', async () => {
    const parsed = await callEvaluate({
      output: 'The customer record was updated successfully with no issues to report.',
      eval_type: 'safety',
    });

    expect(parsed.passed).toBe(true);
    expect('critical_failures' in parsed).toBe(false);
  });

  it('a deployed severity=critical rule hard-fails the eval it loses', async () => {
    // The whole severity wiring through the real MCP surface: deploy_rule
    // persists the severity, the deploy path hands it to createCustomRule,
    // and the engine vetoes. Before this, severity drove nothing but
    // dashboard sort order — a rule author could deploy a "critical" policy
    // rule, watch it fail on a violating output, and still be told
    // passed: true.
    const ruleName = 'no-unreviewed-deploys';
    const deployed = await client.callTool({
      name: 'deploy_rule',
      arguments: {
        name: ruleName,
        description: 'Deploy notes must cite a review ticket',
        evalType: 'completeness',
        severity: 'critical',
        definition: {
          name: ruleName,
          type: 'contains_keywords',
          config: { keywords: ['REVIEW-'] },
        },
      },
    });
    const ruleId: string = JSON.parse((deployed.content as Array<{ text: string }>)[0].text).rule.id;

    const parsed = await callEvaluate({
      output:
        'The deployment finished successfully across all three regions. No errors were reported during the rollout window. Monitoring is green.',
      eval_type: 'completeness',
    });

    expect(parsed.rule_results.find((r: { ruleName: string }) => r.ruleName === ruleName)?.passed).toBe(false);
    expect(parsed.score).toBeGreaterThanOrEqual(0.7);
    expect(parsed.passed).toBe(false);
    expect(parsed.critical_failures).toContain(ruleName);

    await client.callTool({ name: 'delete_rule', arguments: { rule_id: ruleId } });
  });

  it('a deployed severity=medium rule stays weight-only', async () => {
    // The other half of the contract: severity is a decision the rule
    // author makes, and the low end of it must not start hard-failing.
    const ruleName = 'prefer-ticket-reference';
    const deployed = await client.callTool({
      name: 'deploy_rule',
      arguments: {
        name: ruleName,
        description: 'Deploy notes should ideally cite a review ticket',
        evalType: 'completeness',
        severity: 'medium',
        definition: {
          name: ruleName,
          type: 'contains_keywords',
          config: { keywords: ['REVIEW-'] },
        },
      },
    });
    const ruleId: string = JSON.parse((deployed.content as Array<{ text: string }>)[0].text).rule.id;

    const parsed = await callEvaluate({
      output:
        'The deployment finished successfully across all three regions. No errors were reported during the rollout window. Monitoring is green.',
      eval_type: 'completeness',
    });

    expect(parsed.rule_results.find((r: { ruleName: string }) => r.ruleName === ruleName)?.passed).toBe(false);
    expect(parsed.passed).toBe(true);
    expect('critical_failures' in parsed).toBe(false);

    await client.callTool({ name: 'delete_rule', arguments: { rule_id: ruleId } });
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
