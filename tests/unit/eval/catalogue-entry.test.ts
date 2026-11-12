/*
 * A called tool and its entry in the catalogue.
 *
 * The catalogue is documented as "your MCP tools/list result, verbatim",
 * and a server's tools/list names each tool as the server does. A host that
 * reaches its tools through MCP may call them `mcp__<server>__<tool>`
 * instead. Matched by exact name alone, no call on such a host was in a
 * catalogue pasted as documented: valid_tool_arguments failed every call as
 * "not in the catalogue" and tool_choice said the right tool was not called.
 *
 * What is held here: the entry is found under the name the call was made
 * by and then under the tool's own, and the exact name wins. A catalogue
 * names no server, so an entry reached by the own name may be another
 * server's tool of that name, and that bounds what it is taken for: its
 * schema and description are read and the result says so; its word that a
 * tool only reads is not taken, and its word that a tool acts is; and when
 * two called names lead to it, no call's arguments are judged by it.
 */
import { describe, expect, it } from 'vitest';
import { catalogueIndex, catalogueMatch, declaredEffect, ownToolName, readFamilyOf } from '../../../src/eval/catalogue.js';
import { placementOf } from '../../../src/eval/case-history.js';
import { validToolArguments } from '../../../src/eval/rules/completeness.js';
import { toolChoice } from '../../../src/eval/rules/tool-choice.js';
import { noToolLoop } from '../../../src/eval/rules/cost.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import type { CaseRun, EvalContext } from '../../../src/types/eval.js';
import type { ToolCallRecord, ToolDescriptor } from '../../../src/types/trace.js';

/** A shop server's tools, as its tools/list gives them. */
const SHOP: ToolDescriptor[] = [
  { name: 'list_products', description: 'List the products of the shop.', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'get_product', description: 'One product by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'place_order', description: 'Place an order for a product.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, quantity: { type: 'integer' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: false } },
];
/** A documentation server's tools/list: one search that takes `query` and nothing else. */
const DOCS: ToolDescriptor[] = [
  { name: 'search', description: 'Search the documentation pages.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'get_page', description: 'One documentation page by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: true } },
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
const judge = (rule: { evaluate: (c: EvalContext) => ReturnType<typeof validToolArguments.evaluate> }, context: Partial<EvalContext>) => rule.evaluate({ ...RUN, ...context } as EvalContext);
const stat = (r: ReturnType<typeof validToolArguments.evaluate>, name: string): number | undefined =>
  (r.evidence ?? []).flatMap((e) => (e.type === 'count' && e.stat === name ? [e.value] : []))[0];

describe('the catalogue entry of a called tool', () => {
  it('is found under the name the call was made by, and then under the tool\'s own name, and says which', () => {
    const shop = index(SHOP);
    expect(catalogueMatch(shop, 'get_product')).toMatchObject({ tool: { name: 'get_product' }, by: 'called' });
    expect(catalogueMatch(shop, 'mcp__shop__get_product')).toMatchObject({ tool: { name: 'get_product' }, by: 'own' });
    expect(catalogueMatch(shop, 'mcp__claude_ai_Shop__get_product')).toMatchObject({ tool: { name: 'get_product' }, by: 'own' });
    // No entry under either name.
    expect(catalogueMatch(shop, 'mcp__shop__refund_order')).toBeUndefined();
    expect(catalogueMatch(shop, 'refund_order')).toBeUndefined();
  });

  it('only the mcp__<server>__ prefix is taken off: any other prefix is part of the name, and so is a prefix with no server in it', () => {
    const shop = index(SHOP);
    for (const name of ['shop__get_product', 'shop.get_product', 'mcp_shop_get_product', 'MCP__shop__get_product', 'functions.get_product', 'mcp____get_product']) expect(catalogueMatch(shop, name), name).toBeUndefined();
    expect(ownToolName('mcp__shop__get_product')).toBe('get_product');
    expect(ownToolName('shop__get_product')).toBe('shop__get_product');
    expect(ownToolName('mcp____get_product')).toBe('mcp____get_product');
    // The server's part ends at the first `__`: what follows is the tool's name, whatever it holds.
    expect(ownToolName('mcp__files__read__all')).toBe('read__all');
    expect(ownToolName('mcp__shop__')).toBe('mcp__shop__');
  });

  it('the exact name wins, so two servers listed by their full names each get their own entry', () => {
    const both = index([
      { name: 'mcp__a__search', annotations: { readOnlyHint: true } },
      { name: 'mcp__b__search', annotations: { readOnlyHint: false } },
      { name: 'search', annotations: { readOnlyHint: true } },
    ]);
    expect(catalogueMatch(both, 'mcp__a__search')).toMatchObject({ tool: { annotations: { readOnlyHint: true } }, by: 'called' });
    expect(catalogueMatch(both, 'mcp__b__search')).toMatchObject({ tool: { annotations: { readOnlyHint: false } }, by: 'called' });
    // A third server's tool of the same own name reaches the entry listed under it, by its own name: the weaker find.
    expect(catalogueMatch(both, 'mcp__c__search')).toMatchObject({ tool: { name: 'search' }, by: 'own' });
  });

  it('a call that carries no name has no entry, and nothing throws', () => {
    const nameless = undefined as unknown as string;
    expect(ownToolName(nameless)).toBeUndefined();
    expect(catalogueMatch(index(SHOP), nameless)).toBeUndefined();
    const judged = judge(validToolArguments, { toolCalls: [{ input: { id: 'p1' }, output: { price: 18.5 } } as unknown as ToolCallRecord], tools: SHOP });
    expect(judged.skipped).toBeUndefined();
    expect(judged.passed).toBe(false);
    expect(judged.message).toContain('not in the catalogue');
    // tool_choice answers too: no tool that fits the ask was called.
    const choice = judge(toolChoice, { toolCalls: [{ input: { id: 'p1' }, output: { price: 18.5 } } as unknown as ToolCallRecord], tools: SHOP });
    expect(choice.skipped).toBeUndefined();
    expect(choice.passed).toBe(false);
  });
});

describe('what the catalogue says a tool does, by how its entry was found', () => {
  it('under the called name its word is taken either way', () => {
    expect(placementOf('place_order', [{ name: 'place_order', annotations: { readOnlyHint: true } }])).toBe('reads');
    expect(placementOf('mcp__shop__place_order', [{ name: 'mcp__shop__place_order', annotations: { readOnlyHint: true } }])).toBe('reads');
    expect(placementOf('get_product', [{ name: 'get_product', annotations: { readOnlyHint: false } }])).toBe('acts');
    expect(placementOf('status', [{ name: 'status', annotations: { destructiveHint: true } }])).toBe('acts');
  });

  it('under the tool\'s own name, its word that the tool acts is taken', () => {
    expect(placementOf('mcp__shop__get_product', [{ name: 'get_product', annotations: { readOnlyHint: false } }])).toBe('acts');
    expect(placementOf('mcp__shop__status', [{ name: 'status', annotations: { destructiveHint: true } }])).toBe('acts');
    expect(declaredEffect({ tool: { name: 'status', annotations: { destructiveHint: true } }, by: 'own' })).toBe('acts');
  });

  it('under the tool\'s own name, its word that the tool only reads is not taken: the call is placed by its name', () => {
    // A read replica's tools/list marks run_query read-only. The agent's write goes through another server's tool of that name.
    const replica: ToolDescriptor[] = [{ name: 'run_query', annotations: { readOnlyHint: true } }];
    expect(placementOf('run_query', replica)).toBe('reads');
    expect(placementOf('mcp__db_admin__run_query', replica)).toBe('acts');
    // A name that says nothing stays unplaced, where the hint would have called it a look-up.
    expect(placementOf('mcp__shop__status', [{ name: 'status', annotations: { readOnlyHint: true } }])).toBe('unplaced');
    expect(declaredEffect({ tool: { name: 'status', annotations: { readOnlyHint: true } }, by: 'own' })).toBeNull();
    expect(declaredEffect({ tool: { name: 'status', annotations: { readOnlyHint: true } }, by: 'called' })).toBe('reads');
    // The exact entry wins over the own-name entry, and is believed.
    expect(placementOf('mcp__shop__get_product', [{ name: 'get_product', annotations: { readOnlyHint: false } }, { name: 'mcp__shop__get_product', annotations: { readOnlyHint: true } }])).toBe('reads');
    // readFamilyOf, the describing reader, takes the same line, and reads the tool's words and not the server's.
    expect(readFamilyOf({ index: 0, name: 'mcp__shop__place_order' } as never, [{ name: 'place_order', annotations: { readOnlyHint: true } }])).toBe('unknown');
    expect(readFamilyOf({ index: 0, name: 'mcp__shop__get_product' } as never, [{ name: 'get_product', annotations: { readOnlyHint: false } }])).toBe('not_read');
    expect(readFamilyOf({ index: 0, name: 'mcp__search__delete_thing' } as never, [])).toBe('unknown');
    expect(readFamilyOf({ index: 0, name: 'mcp__files__read_file' } as never, [])).toBe('read');
  });

  it('a first-time write through another server is an unusual action, whatever a same-named entry says of its own tool', async () => {
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const ci: ToolDescriptor[] = [
      { name: 'run_query', annotations: { readOnlyHint: true } },
      { name: 'get_pipeline', annotations: { readOnlyHint: true } },
      { name: 'list_jobs', annotations: { readOnlyHint: true } },
    ];
    const earlier: CaseRun[] = Array.from({ length: 6 }, () => ({ tools: ['mcp__ci__get_pipeline', 'mcp__ci__list_jobs'] }));
    const judged = await engine.evaluateAll({
      input: 'Why did pipeline 7 fail?',
      output: 'Pipeline 7 failed in its second job, the integration tests, on a timeout.',
      toolCalls: [
        { tool_name: 'mcp__ci__get_pipeline', input: { id: 7 }, output: { id: 7, status: 'failed' } },
        { tool_name: 'mcp__ci__list_jobs', input: { pipeline: 7 }, output: { jobs: [{ name: 'unit', status: 'passed' }, { name: 'integration', status: 'failed', reason: 'timeout' }] } },
        { tool_name: 'mcp__db_admin__run_query', input: { sql: 'DELETE FROM jobs WHERE pipeline = 7' }, output: { rows: 2 } },
      ],
      tools: ci,
      caseHistory: earlier,
    });
    const unusual = judged.rule_results.find((r) => r.ruleName === 'no_unusual_action')!;
    expect(unusual.passed).toBe(false);
    expect(unusual.message).toContain('mcp__db_admin__run_query');
    expect(judged.verdict).toMatchObject({ state: 'fail', by: ['wrong_trajectory'] });
  });

  it('the count of wasted reads takes a read-only word from the entry under the called name only', () => {
    // One file read twice through each of two tools: four reads of one target, no call made more than twice.
    const files: ToolDescriptor[] = [
      { name: 'read_file', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'cat_file', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    ];
    const reads = (prefix: string): ToolCallRecord[] => ['read_file', 'cat_file', 'read_file', 'cat_file'].map((tool) => ({ tool_name: `${prefix}${tool}`, input: { path: 'notes/plan.md' }, output: 'x' }));
    const plain = noToolLoop.evaluate({ ...RUN, toolCalls: reads(''), tools: files } as EvalContext);
    expect(plain.passed).toBe(false);
    expect(plain.value).toEqual({ stat: 'reads_of_one_target', unit: 'reads', value: 4 });
    // Under a prefixed name the entries are reached by the tools' own names, and their read-only word is not taken.
    const prefixed = noToolLoop.evaluate({ ...RUN, toolCalls: reads('mcp__files__'), tools: files } as EvalContext);
    expect(prefixed.passed).toBe(true);
    expect(prefixed.message).toContain('looked read-shaped but the catalogue does not say so');
    // Listed by the names the agent calls, the count is made.
    const listed = files.map((tool) => ({ ...tool, name: `mcp__files__${tool.name}` }));
    expect(noToolLoop.evaluate({ ...RUN, toolCalls: reads('mcp__files__'), tools: listed } as EvalContext).passed).toBe(false);
  });
});

describe('valid_tool_arguments on a host that prefixes', () => {
  it('checks a prefixed call against its tool\'s schema and says the entry was reached by the tool\'s own name', () => {
    const ok = judge(validToolArguments, { toolCalls: calls('mcp__shop__'), tools: SHOP });
    expect([ok.skipped, ok.passed]).toEqual([undefined, true]);
    expect(ok.message).toContain('2 of 2 checked');
    expect(ok.message).toContain("2 matched to the catalogue by the tool's own name");
    expect(stat(ok, 'calls_matched_by_own_name')).toBe(2);
    // With unprefixed calls nothing is said: every entry is the call's own.
    const plain = judge(validToolArguments, { toolCalls: calls(''), tools: SHOP });
    expect(plain.message).not.toContain('own name');
    expect(stat(plain, 'calls_matched_by_own_name')).toBeUndefined();
  });

  it('finds a wrong argument on a prefixed call, and names the entry whose schema refused it', () => {
    const bad = judge(validToolArguments, { toolCalls: [{ tool_name: 'mcp__shop__get_product', input: { id: 7 }, output: 'x' }], tools: SHOP });
    expect(bad.passed).toBe(false);
    expect(bad.message).toContain("mcp__shop__get_product (/id type, by the schema of the catalogue's get_product)");
    expect(bad.message).not.toContain('not in the catalogue');
    expect((bad.evidence ?? []).some((e) => e.type === 'toolCall' && e.label.includes("by the schema of the catalogue's get_product"))).toBe(true);
    // A tool the server does not have is still not in the catalogue, prefixed or not.
    const invented = judge(validToolArguments, { toolCalls: [{ tool_name: 'mcp__shop__refund_order', input: {}, output: 'x' }], tools: SHOP });
    expect(invented.passed).toBe(false);
    expect(invented.message).toContain('mcp__shop__refund_order (not in the catalogue)');
  });

  it('two called names that lead to one entry: it is the tool of at most one of them, and neither call is judged by it', () => {
    // The tickets server's search takes `jql`; the catalogue is the documentation server's, whose search takes `query`.
    const two: ToolCallRecord[] = [
      { tool_name: 'mcp__docs__search', input: { query: 'refunds' }, output: 'two pages' },
      { tool_name: 'mcp__tickets__search', input: { jql: 'status = Open AND text ~ refund' }, output: 'four tickets' },
      { tool_name: 'mcp__docs__get_page', input: { id: 'refund-policy' }, output: 'the policy' },
    ];
    const judged = judge(validToolArguments, { toolCalls: two, tools: DOCS });
    expect(judged.passed).toBe(true);
    expect(judged.message).toContain('1 of 3 checked');
    expect(judged.message).toContain('2 calls not checked');
    expect(stat(judged, 'calls_unchecked')).toBe(2);
    // Alone, the tickets call would have been refused by the documentation tool's schema: the reason it must not be judged by it.
    const alone = judge(validToolArguments, { toolCalls: [two[1]], tools: DOCS });
    expect(alone.passed).toBe(false);
    expect(alone.message).toContain("by the schema of the catalogue's search");
    // Listed under the names they are called by, each is checked against its own.
    const listed: ToolDescriptor[] = [
      { ...DOCS[0], name: 'mcp__docs__search' },
      { name: 'mcp__tickets__search', inputSchema: { type: 'object', properties: { jql: { type: 'string' } }, required: ['jql'], additionalProperties: false } },
      DOCS[1],
    ];
    const exact = judge(validToolArguments, { toolCalls: two, tools: listed });
    expect(exact.passed).toBe(true);
    expect(exact.message).toContain('3 of 3 checked');
    expect(stat(exact, 'calls_matched_by_own_name')).toBe(1);
  });

  it('a call under the entry\'s exact name is checked; another called name that reaches the same entry by its own name is not', () => {
    const mixed: ToolCallRecord[] = [
      { tool_name: 'search', input: { query: 'refunds' }, output: 'two pages' },
      { tool_name: 'mcp__tickets__search', input: { jql: 'status = Open' }, output: 'four tickets' },
    ];
    const judged = judge(validToolArguments, { toolCalls: mixed, tools: DOCS });
    expect(judged.passed).toBe(true);
    expect(judged.message).toContain('1 of 2 checked');
    expect(judged.message).toContain('mcp__tickets__search');
    expect(stat(judged, 'calls_matched_by_own_name')).toBeUndefined();
  });
});

describe('tool_choice on a host that prefixes', () => {
  it('counts a prefixed call as a call to its tool, and names the entry beside the call', () => {
    const prefixed = judge(toolChoice, { toolCalls: calls('mcp__shop__'), tools: SHOP });
    const plain = judge(toolChoice, { toolCalls: calls(''), tools: SHOP });
    expect([prefixed.skipped, prefixed.passed]).toEqual([plain.skipped, plain.passed]);
    expect(prefixed.passed).toBe(true);
    expect(prefixed.value).toEqual(plain.value);
    expect(prefixed.message).toContain("mcp__shop__list_products, read as the catalogue's list_products; mcp__shop__get_product, read as the catalogue's get_product");
    expect(plain.message).toContain('(list_products, get_product)');
    // And it still fires when the tool that fits was left uncalled.
    const wrong = judge(toolChoice, { input: 'Place an order for product p1.', toolCalls: [{ tool_name: 'mcp__shop__list_products', input: {}, output: 'x' }], tools: SHOP });
    expect(wrong.passed).toBe(false);
    expect(wrong.message).toContain('place_order');
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
