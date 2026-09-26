/*
 * get_traces q (#7) over a real MCP client: the search reaches the store,
 * results come back ranked with a match on each, the other filters still
 * apply, and the refusals name what was wrong.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../../src/server.js';
import { createCustomRuleStore } from '../../../src/custom-rule-store.js';
import { defaultConfig } from '../../../src/config/defaults.js';

type Content = Array<{ type: string; text: string }>;
const body = (r: unknown) => (r as { content: Content }).content[0].text;
const parse = (r: unknown) => JSON.parse(body(r)) as Record<string, unknown>;

describe('get_traces q over MCP', () => {
  let client: Client;
  let storage: SqliteAdapter;
  let ruleDir: string;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    ruleDir = mkdtempSync(join(tmpdir(), 'iris-search-mcp-'));
    const ruleStore = createCustomRuleStore({ pathFor: () => join(ruleDir, 'custom-rules.json'), auditPath: join(ruleDir, 'audit.log') });
    const { mcpServer } = createIrisServer(defaultConfig, storage, ruleStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: 'search', version: '0.1.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
    rmSync(ruleDir, { recursive: true, force: true });
  });

  const log = (args: Record<string, unknown>) => client.callTool({ name: 'log_trace', arguments: { agent_name: 'support-bot', input: 'q', ...args } });
  const search = (args: Record<string, unknown>) => client.callTool({ name: 'get_traces', arguments: args });

  it('finds the run where the agent said it, ranked, with the snippet and the searched terms', async () => {
    const said = parse(await log({ output: 'I have escalated your refund to the billing team; expect an answer within two days.' }));
    const twice = parse(await log({ output: 'Refund escalated. Refund escalated again after the refund window closed.' }));
    parse(await log({ output: 'Your order shipped yesterday.' }));
    parse(await log({ agent_name: 'other-bot', output: 'refund escalated elsewhere' }));

    const page = parse(await search({ q: 'refund escalated', agent_name: 'support-bot' }));
    expect(page.total).toBe(2);
    expect(page.search).toEqual({ terms: ['refund', 'escalated'], index: 'fts5' });
    const traces = page.traces as Array<{ trace_id: string; match: { field: string; snippet: string; fragments: Array<{ text: string; hit: boolean }> } }>;
    expect(traces.map((t) => t.trace_id)).toEqual([twice.trace_id, said.trace_id]);
    expect(traces[1].match.field).toBe('output');
    expect(traces[1].match.fragments.filter((f) => f.hit).map((f) => f.text)).toEqual(['escalated', 'refund']);

    const phrase = parse(await search({ q: '"billing team"' }));
    expect((phrase.traces as Array<{ trace_id: string }>).map((t) => t.trace_id)).toEqual([said.trace_id]);
  });

  it('takes any text as words: quotes, stars, parentheses and NEAR never error', async () => {
    parse(await log({ output: 'The NEAR clause (and a quote ") are just words here.' }));
    for (const q of ['"near', 'NEAR(', '(clause', 'output:near', 'clause*)', '"unbalanced quote', 'a AND OR NOT b', "it's"]) {
      const r = await search({ q });
      expect((r as { isError?: boolean }).isError, q).toBeFalsy();
      expect(parse(r).search, q).toBeDefined();
    }
    const found = parse(await search({ q: 'NEAR(clause' }));
    expect(found.total).toBe(1);
  });

  it('refuses a q with no word in it, relevance without q, and an overlong q — naming the problem', async () => {
    const noWord = await search({ q: '*** ()' });
    expect((noWord as { isError?: boolean }).isError).toBe(true);
    expect(body(noWord)).toMatch(/has no word to search for/);
    const relevance = await search({ sort_by: 'relevance' });
    expect((relevance as { isError?: boolean }).isError).toBe(true);
    expect(body(relevance)).toMatch(/ranks a search, and this query has no q/);
    const long = await search({ q: 'x'.repeat(501) });
    expect((long as { isError?: boolean }).isError).toBe(true);
    expect(body(long)).toMatch(/at most 500 characters/);
  });

  it('a blank q is no search: every trace, newest first, no match and no search block', async () => {
    parse(await log({ output: 'first', timestamp: '2026-09-01T00:00:00.000Z' }));
    parse(await log({ output: 'second', timestamp: '2026-09-02T00:00:00.000Z' }));
    const page = parse(await search({ q: '   ' }));
    expect(page.total).toBe(2);
    expect(page.search).toBeUndefined();
    expect((page.traces as Array<{ output: string; match?: unknown }>).map((t) => [t.output, t.match])).toEqual([
      ['second', undefined],
      ['first', undefined],
    ]);
  });

  it('advertises q and relevance in the tool schema', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'get_traces')!;
    const props = tool.inputSchema.properties as Record<string, { enum?: string[]; maxLength?: number }>;
    expect(props.q.maxLength).toBe(500);
    expect(props.sort_by.enum).toContain('relevance');
    expect(tool.description).toContain('full-text search');
  });
});
