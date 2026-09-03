import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { createCustomRule } from '../../../src/eval/rules/index.js';
import { registerEvaluateOutputTool } from '../../../src/tools/evaluate-output.js';

/*
 * The evaluate_output RESPONSE, driven through a real MCP client — not the
 * engine. The engine has reported `critical_skipped` since v0.5.0 and the
 * engine tests pin it; what nobody tested was the JSON the tool handler
 * actually hands back, which spread `critical_failures` and dropped
 * `critical_skipped` on the floor. The tool description told users twice
 * to fail closed on that field. A gate written to the docs keyed on
 * something that never arrived, and read passed:true as clean on output a
 * critical rule was defeated by rather than cleared.
 *
 * Skips here are provoked with a broken regex config (configError →
 * skipped, deterministic, no sandbox worker) and with a cost_threshold rule
 * called without cost data — the two skip paths a deployed critical rule
 * can take without any hostile input at all.
 */

interface EvaluateResponse {
  passed: boolean;
  critical_failures?: string[];
  critical_skipped?: string[];
  rule_results: Array<{ ruleName: string; skipped?: boolean; skipReason?: string }>;
  insufficient_data: boolean;
}

describe('evaluate_output response carries critical_skipped', () => {
  let client: Client;
  let storage: SqliteAdapter;
  let evalEngine: EvalEngine;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    evalEngine = new EvalEngine(0.7);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerEvaluateOutputTool(server, storage, evalEngine);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
  });

  async function evaluate(args: Record<string, unknown>): Promise<EvaluateResponse> {
    const res = await client.callTool({ name: 'evaluate_output', arguments: args });
    const content = res.content as Array<{ type: string; text: string }>;
    return JSON.parse(content[0].text) as EvaluateResponse;
  }

  function cheapPassingRule() {
    return createCustomRule(
      { name: 'cheap_check', type: 'min_length', config: { min_length: 5 } },
      'low',
    );
  }

  it('names a critical rule that skipped on a broken config', async () => {
    // severity 'critical' is what deploy_rule sets for a hard-failing rule;
    // `(` never compiles, so the rule skips with configInvalid on every call.
    evalEngine.registerRule(
      'custom',
      createCustomRule({ name: 'policy_regex', type: 'regex_no_match', config: { pattern: '(' } }, 'critical'),
      'rule-broken',
    );
    evalEngine.registerRule('custom', cheapPassingRule(), 'rule-cheap');

    const res = await evaluate({ output: 'an ordinary agent response', eval_type: 'custom' });

    expect(res.insufficient_data).toBe(false);
    expect(res.passed).toBe(true);
    expect(res.critical_failures).toBeUndefined();
    // The seam, now visible to the caller: passed:true AND a named critical
    // rule that never judged the output.
    expect(res.critical_skipped).toEqual(['policy_regex']);
  });

  it('names a critical cost_threshold rule when the call omits cost_usd', async () => {
    evalEngine.registerRule(
      'safety',
      createCustomRule({ name: 'cost_ceiling', type: 'cost_threshold', config: { max_cost: 0.5 } }, 'critical'),
      'rule-cost',
    );

    const res = await evaluate({ output: 'a clean response with no PII at all', eval_type: 'safety' });

    const costRule = res.rule_results.find((r) => r.ruleName === 'cost_ceiling');
    expect(costRule?.skipped).toBe(true);
    expect(costRule?.skipReason).toContain('costUsd');
    expect(res.critical_failures).toBeUndefined();
    expect(res.critical_skipped).toEqual(['cost_ceiling']);
  });

  it('vetoes through the same response when cost_usd is present and over the ceiling', async () => {
    evalEngine.registerRule(
      'safety',
      createCustomRule({ name: 'cost_ceiling', type: 'cost_threshold', config: { max_cost: 0.5 } }, 'critical'),
      'rule-cost',
    );

    const res = await evaluate({
      output: 'a clean response with no PII at all',
      eval_type: 'safety',
      cost_usd: 0.75,
    });

    expect(res.passed).toBe(false);
    expect(res.critical_failures).toEqual(['cost_ceiling']);
    expect(res.critical_skipped).toBeUndefined();
  });

  it('omits critical_skipped when every critical rule actually ran', async () => {
    evalEngine.registerRule(
      'custom',
      createCustomRule({ name: 'linear_forbidden', type: 'regex_no_match', config: { pattern: 'zzz' } }, 'critical'),
      'rule-linear',
    );

    const res = await evaluate({ output: 'a perfectly ordinary agent response', eval_type: 'custom' });

    expect(res.passed).toBe(true);
    expect(res.critical_skipped).toBeUndefined();
    expect(res.critical_failures).toBeUndefined();
  });
});
