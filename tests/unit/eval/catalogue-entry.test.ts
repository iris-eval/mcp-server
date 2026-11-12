/*
 * A called tool and its entry in the catalogue.
 *
 * The catalogue is documented as "your MCP tools/list result, verbatim",
 * and a server's tools/list names each tool as the server does. A host that
 * reaches its tools through MCP may call them `mcp__<server>__<tool>`
 * instead. Matched by exact name alone, no call on such a host was in a
 * catalogue pasted as documented: valid_tool_arguments failed every call as
 * "not in the catalogue", tool_choice said the right tool was not called,
 * and no hint in the catalogue reached a call.
 *
 * What is held here: the entry is found under the name the call was made
 * by and then under the tool's own, the exact name wins, and each rule that
 * reads the catalogue reads it that way.
 */
import { describe, expect, it } from 'vitest';
import { catalogueEntry, catalogueIndex, ownToolName, readFamilyOf } from '../../../src/eval/catalogue.js';
import { placementOf } from '../../../src/eval/case-history.js';
import { validToolArguments } from '../../../src/eval/rules/completeness.js';
import { toolChoice } from '../../../src/eval/rules/tool-choice.js';
import { noToolLoop } from '../../../src/eval/rules/cost.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import type { EvalContext } from '../../../src/types/eval.js';
import type { ToolCallRecord, ToolDescriptor } from '../../../src/types/trace.js';

/** A shop server's tools, as its tools/list gives them. */
const SHOP: ToolDescriptor[] = [
  { name: 'list_products', description: 'List the products of the shop.', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'get_product', description: 'One product by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'place_order', description: 'Place an order for a product.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, quantity: { type: 'integer' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: false } },
];
const RUN = {
  input: 'Which products does the shop carry, and what does the first one cost?',
  output: 'The shop carries three products. The first, the Kona 250 g bag, costs 18.50 USD.',
};
const calls = (prefix: string): ToolCallRecord[] => [
  { tool_name: `${prefix}list_products`, input: { limit: 3 }, output: { products: [{ id: 'p1', name: 'Kona 250 g bag' }, { id: 'p2' }, { id: 'p3' }] } },
  { tool_name: `${prefix}get_product`, input: { id: 'p1' }, output: { id: 'p1', name: 'Kona 250 g bag', price: 18.5, currency: 'USD' } },
];
const index = (tools: ToolDescriptor[]) => catalogueIndex({ output: '', tools } as EvalContext)!;

describe('the catalogue entry of a called tool', () => {
  it('is found under the name the call was made by, and then under the tool\'s own name', () => {
    const shop = index(SHOP);
    expect(catalogueEntry(shop, 'get_product')?.name).toBe('get_product');
    expect(catalogueEntry(shop, 'mcp__shop__get_product')?.name).toBe('get_product');
    expect(catalogueEntry(shop, 'mcp__claude_ai_Shop__get_product')?.name).toBe('get_product');
    // No entry under either name.
    expect(catalogueEntry(shop, 'mcp__shop__refund_order')).toBeUndefined();
    expect(catalogueEntry(shop, 'refund_order')).toBeUndefined();
  });

  it('only the mcp__<server>__ prefix is taken off: any other prefix is part of the name', () => {
    const shop = index(SHOP);
    for (const name of ['shop__get_product', 'shop.get_product', 'mcp_shop_get_product', 'MCP__shop__get_product', 'functions.get_product']) expect(catalogueEntry(shop, name), name).toBeUndefined();
    expect(ownToolName('mcp__shop__get_product')).toBe('get_product');
    expect(ownToolName('shop__get_product')).toBe('shop__get_product');
  });

  it('the exact name wins, so two servers listed by their full names each get their own entry', () => {
    const both = index([
      { name: 'mcp__a__search', annotations: { readOnlyHint: true } },
      { name: 'mcp__b__search', annotations: { readOnlyHint: false } },
      { name: 'search', annotations: { readOnlyHint: true } },
    ]);
    expect(catalogueEntry(both, 'mcp__a__search')?.annotations?.readOnlyHint).toBe(true);
    expect(catalogueEntry(both, 'mcp__b__search')?.annotations?.readOnlyHint).toBe(false);
    // A third server's tool of the same own name falls to the entry listed under it.
    expect(catalogueEntry(both, 'mcp__c__search')?.name).toBe('search');
  });
});

describe('each rule that reads the catalogue reads it that way', () => {
  const judge = (rule: { evaluate: (c: EvalContext) => ReturnType<typeof validToolArguments.evaluate> }, context: Partial<EvalContext>) => rule.evaluate({ ...RUN, ...context } as EvalContext);

  it('valid_tool_arguments checks a prefixed call against its tool\'s schema, and still says when a tool is in neither form', () => {
    const ok = judge(validToolArguments, { toolCalls: calls('mcp__shop__'), tools: SHOP });
    expect([ok.skipped, ok.passed]).toEqual([undefined, true]);
    expect(ok.message).toContain('2 of 2 checked');
    // The schema is the one applied: a wrong argument on a prefixed call is found.
    const bad = judge(validToolArguments, { toolCalls: [{ tool_name: 'mcp__shop__get_product', input: { id: 7 }, output: 'x' }], tools: SHOP });
    expect(bad.passed).toBe(false);
    expect(bad.message).toContain('mcp__shop__get_product');
    expect(bad.message).not.toContain('not in the catalogue');
    // A tool the server does not have is still not in the catalogue, prefixed or not.
    const invented = judge(validToolArguments, { toolCalls: [{ tool_name: 'mcp__shop__refund_order', input: {}, output: 'x' }], tools: SHOP });
    expect(invented.passed).toBe(false);
    expect(invented.message).toContain('mcp__shop__refund_order (not in the catalogue)');
  });

  it('tool_choice counts a prefixed call as a call to its tool', () => {
    const prefixed = judge(toolChoice, { toolCalls: calls('mcp__shop__'), tools: SHOP });
    const plain = judge(toolChoice, { toolCalls: calls(''), tools: SHOP });
    expect([prefixed.skipped, prefixed.passed]).toEqual([plain.skipped, plain.passed]);
    expect(prefixed.passed).toBe(true);
    expect(prefixed.value).toEqual(plain.value);
    // And it still fires when the tool that fits was left uncalled.
    const wrong = judge(toolChoice, { input: 'Place an order for product p1.', toolCalls: [{ tool_name: 'mcp__shop__list_products', input: {}, output: 'x' }], tools: SHOP });
    expect(wrong.passed).toBe(false);
    expect(wrong.message).toContain('place_order');
  });

  it('a read-only hint reaches a prefixed call: in the reread count, and in what no_unusual_action counts', () => {
    // Four reads of one file, no two calls alike, through a tool the catalogue calls read-only: only the hint makes them rereads.
    const files: ToolDescriptor[] = [{ name: 'read_file', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }];
    const reread = (name: string) => Array.from({ length: 4 }, (_, i): ToolCallRecord => ({ tool_name: name, input: { path: 'notes/plan.md', offset: i * 100 }, output: 'x' }));
    const plain = noToolLoop.evaluate({ ...RUN, toolCalls: reread('read_file'), tools: files } as EvalContext);
    const prefixed = noToolLoop.evaluate({ ...RUN, toolCalls: reread('mcp__files__read_file'), tools: files } as EvalContext);
    expect(plain.passed).toBe(false);
    expect(plain.value).toEqual({ stat: 'reads_of_one_target', unit: 'reads', value: 4 });
    expect(prefixed.passed).toBe(false);
    expect(prefixed.value).toEqual(plain.value);
    // With no entry under either name the hint is not there to read, and the calls are four different calls.
    expect(noToolLoop.evaluate({ ...RUN, toolCalls: reread('mcp__files__open_file'), tools: files } as EvalContext).passed).toBe(true);
    // The catalogue's word comes before the name's, under either name: a look-up named for an action, and an action named for a look-up.
    expect(placementOf('mcp__shop__place_order', [{ name: 'place_order', annotations: { readOnlyHint: true } }])).toBe('reads');
    expect(placementOf('mcp__shop__get_product', [{ name: 'get_product', annotations: { readOnlyHint: false } }])).toBe('acts');
    expect(placementOf('mcp__shop__status', [{ name: 'status', annotations: { destructiveHint: true } }])).toBe('acts');
    // The exact entry wins over the own-name entry.
    expect(placementOf('mcp__shop__get_product', [{ name: 'get_product', annotations: { readOnlyHint: false } }, { name: 'mcp__shop__get_product', annotations: { readOnlyHint: true } }])).toBe('reads');
    expect(readFamilyOf({ index: 0, name: 'mcp__shop__place_order' } as never, [{ name: 'place_order', annotations: { readOnlyHint: true } }])).toBe('read');
  });
});

describe('a correct run on a host that prefixes its tools', () => {
  it('gets the verdict it gets with unprefixed calls, against the catalogue as tools/list gives it', async () => {
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const plain = await engine.evaluateAll({ ...RUN, toolCalls: calls(''), tools: SHOP });
    const prefixed = await engine.evaluateAll({ ...RUN, toolCalls: calls('mcp__shop__'), tools: SHOP });
    expect(plain.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    expect(prefixed.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    const state = (r: typeof plain, name: string) => r.rule_results.find((x) => x.ruleName === name)?.state;
    for (const name of ['valid_tool_arguments', 'tool_choice']) expect(state(prefixed, name), name).toBe(state(plain, name));
  });
});
