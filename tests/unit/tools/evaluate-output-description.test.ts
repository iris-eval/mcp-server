import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { registerEvaluateOutputTool } from '../../../src/tools/evaluate-output.js';
import { relevanceRules } from '../../../src/eval/rules/relevance.js';

/*
 * The description a model reads must match what the rules do.
 *
 * It said `expected` was REQUIRED for eval_type="relevance" and was the
 * keyword-overlap target. Both relevance rules read `input` and skip
 * without it; `expected` is never consulted. A caller who followed the
 * description — {output, expected, eval_type: "relevance"} — got
 * rules_skipped=2, insufficient_data=true and a skipReason blaming a
 * missing input, the opposite of what the docs promised. These tests pin
 * the description to the code on both sides of the mismatch.
 */

describe('evaluate_output description — relevance inputs', () => {
  let client: Client;
  let storage: SqliteAdapter;
  let engine: EvalEngine;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    engine = new EvalEngine(0.7);
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerEvaluateOutputTool(server, storage, engine);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
  });

  async function tool() {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'evaluate_output');
    if (!t) throw new Error('evaluate_output not registered');
    return t;
  }

  it('says input — not expected — is required for eval_type="relevance"', async () => {
    const t = await tool();
    const description = t.description ?? '';
    expect(description).toMatch(/input is REQUIRED when eval_type="relevance"/);
    expect(description).not.toMatch(/expected is REQUIRED when eval_type="relevance"/);

    const props = (t.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.input.description).toMatch(/REQUIRED when eval_type="relevance"/);
    expect(props.expected.description).not.toMatch(/REQUIRED when eval_type="relevance"/);
    expect(props.expected.description).toMatch(/expected_coverage/);
  });

  it('matches what the relevance rules actually do', () => {
    // Every relevance rule skips without input, and none reads expected.
    for (const rule of relevanceRules) {
      const withoutInput = rule.evaluate({ output: 'a long enough output about weather today', expected: 'weather' });
      expect(withoutInput.skipped, rule.name).toBe(true);
      expect(withoutInput.skipReason, rule.name).toContain('input');
      const withInput = rule.evaluate({
        output: 'The weather today is sunny and warm with clear skies',
        input: 'What is the weather today?',
      });
      expect(withInput.skipped, rule.name).toBeUndefined();
    }
  });
});
