import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { defaultConfig } from '../../src/config/defaults.js';

/*
 * A host that calls its MCP tools `mcp__<server>__<tool>`, and a catalogue
 * pasted from that server's tools/list, over the real MCP surface.
 *
 * The rules are held by tests/unit/eval/catalogue-entry.test.ts. What is
 * held here is the path a caller takes: `tools` as the documentation asks
 * for it, on evaluate_output directly and on a stored trace judged later.
 * Matched by exact name alone, this run failed its verdict on both.
 */

type RuleRow = { ruleName: string; state: string; passed: boolean; skipped?: boolean; message: string };
type Evaluation = { rule_results: RuleRow[]; passed: boolean; verdict: { state: string; basis: string; by: string[] } };

/** The server's tools as its tools/list gives them. */
const TOOLS = [
  { name: 'list_products', description: 'List the products of the shop.', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'get_product', description: 'One product by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: true } },
];
const RUN = {
  input: 'Which products does the shop carry, and what does the first one cost?',
  output: 'The shop carries three products. The first, the Kona 250 g bag, costs 18.50 USD.',
};
const callsNamed = (prefix: string) => [
  { tool_name: `${prefix}list_products`, input: { limit: 3 }, output: { products: [{ id: 'p1', name: 'Kona 250 g bag' }, { id: 'p2' }, { id: 'p3' }] } },
  { tool_name: `${prefix}get_product`, input: { id: 'p1' }, output: { id: 'p1', name: 'Kona 250 g bag', price: 18.5, currency: 'USD' } },
];

describe('prefixed tool calls against a catalogue pasted from tools/list', () => {
  let client: Client;
  let storage: SqliteAdapter;

  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = (await client.callTool({ name, arguments: args })) as { structuredContent?: Record<string, unknown>; content: Array<{ text: string }> };
    return (res.structuredContent ?? (JSON.parse(res.content[0].text) as Record<string, unknown>)) as Record<string, unknown>;
  };
  const row = (e: Evaluation, name: string): RuleRow => e.rule_results.find((r) => r.ruleName === name)!;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const { mcpServer } = createIrisServer(defaultConfig, storage);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: 'prefixed-catalogue-test', version: '0.1.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
  });

  it('evaluate_output passes the run it passes with unprefixed calls, and checks the arguments', async () => {
    const plain = (await call('evaluate_output', { ...RUN, eval_type: 'all', tool_calls: callsNamed(''), tools: TOOLS })) as unknown as Evaluation;
    const prefixed = (await call('evaluate_output', { ...RUN, eval_type: 'all', tool_calls: callsNamed('mcp__shop__'), tools: TOOLS })) as unknown as Evaluation;
    expect(plain.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    expect(prefixed.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    expect(row(prefixed, 'valid_tool_arguments')).toMatchObject({ state: 'pass', passed: true });
    expect(row(prefixed, 'valid_tool_arguments').message).toContain('2 of 2 checked');
    expect(row(prefixed, 'tool_choice').state).toBe(row(plain, 'tool_choice').state);
  });

  it('a wrong argument on a prefixed call is still found, by the schema of the tool it names', async () => {
    const calls = [{ tool_name: 'mcp__shop__get_product', input: { id: 7 }, output: 'not found' }];
    const judged = (await call('evaluate_output', { ...RUN, eval_type: 'all', tool_calls: calls, tools: TOOLS })) as unknown as Evaluation;
    const args = row(judged, 'valid_tool_arguments');
    expect(args.passed).toBe(false);
    expect(args.message).toContain('mcp__shop__get_product');
    expect(args.message).not.toContain('not in the catalogue');
  });

  it('a stored trace carries its catalogue, and is judged the same way later', async () => {
    const stored = await call('log_trace', { agent_name: 'shopper', ...RUN, tool_calls: callsNamed('mcp__shop__'), tools: TOOLS });
    const judged = (await call('evaluate_output', { output: RUN.output, eval_type: 'all', trace_id: stored.trace_id })) as unknown as Evaluation;
    expect(judged.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    expect(row(judged, 'valid_tool_arguments')).toMatchObject({ state: 'pass', passed: true });
  });
});
