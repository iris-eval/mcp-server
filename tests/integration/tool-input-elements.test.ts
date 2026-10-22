/*
 * The tool-input element limit (security.maxToolInputElements).
 *
 * The MCP SDK can count the array elements and object keys in a tool
 * call's arguments before it validates them, and answer a call over a
 * limit with an isError result (GHSA-46jr-4wx8-v453). It counts nothing
 * unless the server sets the limit, and an argument that fails validation
 * is reported element by element, so one 1 MB request could cost the server
 * hundreds of megabytes. Every MCP server Iris builds now sets it: the one
 * stdio serves and each one an HTTP session gets.
 *
 * Held here: a call over the limit is answered, not crashed on, and never
 * reaches the tool; the session keeps serving; a call at the limit passes;
 * the default clears the densest legitimate trace shape measured even when
 * it fills the whole 1 MB request; and an embedder's config without the
 * key still gets the default.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { createHttpTransport } from '../../src/transport/http.js';
import { DEFAULT_MAX_TOOL_INPUT_ELEMENTS, defaultConfig } from '../../src/config/defaults.js';
import { requestSizeLimitBytes } from '../../src/utils/size-limit.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import type { IrisConfig } from '../../src/types/config.js';
import { textOf, type ToolResult } from '../helpers/mcp-results.js';

/** Array elements plus object keys, counted the way the SDK counts them (toolInputElementCount in its server/mcp.js). */
function elements(value: unknown): number {
  let n = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    const children = Array.isArray(node) ? node : Object.values(node);
    n += children.length;
    for (const child of children) if (child !== null && typeof child === 'object') stack.push(child);
  }
  return n;
}

/** A log_trace call of `calls` tool calls, each a read with a short output: the densest legitimate shape measured (5 elements a call, plus 3). */
function trace(calls: number) {
  return {
    agent_name: 'bulk-agent',
    output: 'Done.',
    tool_calls: Array.from({ length: calls }, (_, i) => ({ tool_name: 'read_file', input: { path: `src/f${i}.ts` }, output: 'contents' })),
  };
}

const withLimit = (maxToolInputElements: number): IrisConfig => ({
  ...defaultConfig,
  security: { ...defaultConfig.security, maxToolInputElements },
});

const refusal = (limit: number) => new RegExp(`arguments contain more than the maximum of ${limit} elements`);

describe('the element limit on the MCP server stdio serves', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function connect(config: IrisConfig): Promise<{ client: Client; storage: SqliteAdapter }> {
    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const { mcpServer } = createIrisServer(config, storage, undefined, { warn: () => {} });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverSide);
    const client = new Client({ name: 'element-limit', version: '0.1.0' });
    await client.connect(clientSide);
    cleanup.push(async () => {
      await client.close();
      await storage.close();
    });
    return { client, storage };
  }

  const stored = async (storage: SqliteAdapter) => (await storage.queryTraces(LOCAL_TENANT, {})).total;

  it('answers a call over the limit with an isError result, before the tool runs, and keeps serving', async () => {
    const { client, storage } = await connect(withLimit(50));
    expect(elements(trace(10))).toBe(53);

    const over = (await client.callTool({ name: 'log_trace', arguments: trace(10) })) as ToolResult;
    expect(over.isError).toBe(true);
    expect(textOf(over)).toMatch(refusal(50));
    expect(await stored(storage)).toBe(0);

    const under = (await client.callTool({ name: 'log_trace', arguments: trace(9) })) as ToolResult;
    expect(under.isError).toBeFalsy();
    expect(await stored(storage)).toBe(1);
  });

  it('passes a call of exactly the limit, and refuses one element more', async () => {
    const exact = elements(trace(9));
    expect((await (await connect(withLimit(exact))).client.callTool({ name: 'log_trace', arguments: trace(9) })).isError).toBeFalsy();
    const refused = (await (await connect(withLimit(exact - 1))).client.callTool({ name: 'log_trace', arguments: trace(9) })) as ToolResult;
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(refusal(exact - 1));
  });

  it('at the default, stores the densest legitimate trace shape measured, filled to the whole 1 MB request size limit', async () => {
    const { client, storage } = await connect(defaultConfig);
    // The most such calls one request within security.requestSizeLimit can carry.
    const limitBytes = requestSizeLimitBytes(defaultConfig.security.requestSizeLimit);
    const request = (calls: number) =>
      Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'log_trace', arguments: trace(calls) } }));
    let calls = Math.floor(limitBytes / 80);
    while (request(calls + 100) <= limitBytes) calls += 100;
    const args = trace(calls);
    expect(request(calls)).toBeLessThanOrEqual(limitBytes);
    // About 67,000 here (the paths lengthen as they count up); the proof corpus case it copies reaches 68,506 at 1 MB.
    expect(elements(args)).toBeGreaterThan(60_000);
    expect(elements(args)).toBeLessThan(DEFAULT_MAX_TOOL_INPUT_ELEMENTS);

    const result = (await client.callTool({ name: 'log_trace', arguments: args })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(await stored(storage)).toBe(1);
  }, 30_000);

  it('at the default, refuses a payload built to be dense before validating it', async () => {
    const { client, storage } = await connect(defaultConfig);
    expect(DEFAULT_MAX_TOOL_INPUT_ELEMENTS).toBe(100_000);
    // 100,001 zeros where spans are expected: 200 KB, and one validation error each without the limit.
    const result = (await client.callTool({
      name: 'log_trace',
      arguments: { agent_name: 'a', output: 'x', spans: Array(DEFAULT_MAX_TOOL_INPUT_ELEMENTS + 1).fill(0) },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(refusal(DEFAULT_MAX_TOOL_INPUT_ELEMENTS));
    expect(await stored(storage)).toBe(0);
  });

  it('gives a config built without the key (an embedder\'s) the default', async () => {
    const security: Partial<IrisConfig['security']> = { ...defaultConfig.security };
    delete security.maxToolInputElements;
    const { client } = await connect({ ...defaultConfig, security } as IrisConfig);
    const result = (await client.callTool({
      name: 'log_trace',
      arguments: { agent_name: 'a', output: 'x', spans: Array(DEFAULT_MAX_TOOL_INPUT_ELEMENTS + 1).fill(0) },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(refusal(DEFAULT_MAX_TOOL_INPUT_ELEMENTS));
  });
});

describe('the element limit on the MCP servers the HTTP transport serves', () => {
  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  let httpServer: Server | undefined;
  let storage: SqliteAdapter | undefined;

  afterEach(async () => {
    if (httpServer) {
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      httpServer = undefined;
    }
    await storage?.close();
    storage = undefined;
  });

  it('answers a call over the limit with an isError result, and the session goes on', async () => {
    const config: IrisConfig = {
      ...withLimit(50),
      transport: { ...defaultConfig.transport, type: 'http', host: '127.0.0.1', port: 0 },
    };
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const { newMcpServer } = createIrisServer(config, storage, undefined, { warn: () => {} });
    const http = await createHttpTransport(newMcpServer, config, logger);
    httpServer = http.httpServer;
    const url = new URL(`http://127.0.0.1:${(httpServer.address() as { port: number }).port}/mcp`);
    const client = new Client({ name: 'element-limit-http', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(url));

    const over = (await client.callTool({ name: 'log_trace', arguments: trace(10) })) as ToolResult;
    expect(over.isError).toBe(true);
    expect(textOf(over)).toMatch(refusal(50));

    const under = (await client.callTool({ name: 'log_trace', arguments: trace(9) })) as ToolResult;
    expect(under.isError).toBeFalsy();
    expect((await storage.queryTraces(LOCAL_TENANT, {})).total).toBe(1);
    await client.close();
    await http.closeSessions();
  });
});
