/*
 * More than one MCP client on the HTTP endpoint.
 *
 * The endpoint created one transport for the life of the process. The first
 * client to `initialize` owned it; a second got `400 Server already
 * initialized`; and after the first ended its session every later client
 * got `404 Session not found` until the server was restarted. Each client
 * now gets a session of its own over the same engine and store.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { createCustomRuleStore } from '../../src/custom-rule-store.js';
import { createHttpTransport, type HttpTransportResult } from '../../src/transport/http.js';
import { defaultConfig } from '../../src/config/defaults.js';
import type { IrisConfig } from '../../src/types/config.js';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const config: IrisConfig = {
  ...defaultConfig,
  transport: { ...defaultConfig.transport, type: 'http', host: '127.0.0.1', port: 0 },
  // The default is 20 MCP requests a minute per address; these tests make more from one.
  security: { ...defaultConfig.security, rateLimit: { ...defaultConfig.security.rateLimit, mcp: 10_000 } },
};

type Json = Record<string, unknown>;
const body = (result: unknown): Json => JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as Json;

describe('several MCP clients on one HTTP endpoint', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function boot(limits?: { maxSessions?: number; sessionIdleMs?: number }): Promise<{ url: URL; http: HttpTransportResult }> {
    const dir = mkdtempSync(join(tmpdir(), 'iris-http-clients-'));
    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const rules = createCustomRuleStore({ pathFor: () => join(dir, 'custom-rules.json'), auditPath: join(dir, 'audit.log') });
    const { newMcpServer } = createIrisServer(config, storage, rules, { warn: () => {} });
    const http = await createHttpTransport(newMcpServer, config, logger, {}, undefined, limits);
    cleanup.push(async () => {
      await http.closeSessions();
      await close(http.httpServer);
      await storage.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    return { url: new URL(`http://127.0.0.1:${portOf(http.httpServer)}/mcp`), http };
  }

  const portOf = (server: Server): number => (server.address() as { port: number }).port;
  const close = (server: Server): Promise<void> =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });

  async function connect(url: URL, name: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name, version: '0.1.0' });
    await client.connect(transport);
    return { client, transport };
  }

  const post = (url: URL, payload: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(payload) });
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } };

  it('two clients connect at once, each with its own session, over one store', async () => {
    const { url, http } = await boot();
    const a = await connect(url, 'client-a');
    const b = await connect(url, 'client-b');
    expect(http.sessionCount()).toBe(2);
    expect(a.transport.sessionId).toBeTruthy();
    expect(b.transport.sessionId).not.toBe(a.transport.sessionId);

    expect((await a.client.listTools()).tools.map((t) => t.name)).toContain('log_trace');
    expect((await b.client.listTools()).tools.map((t) => t.name)).toContain('log_trace');

    // What A stores, B reads: two sessions, one store.
    const logged = body(await a.client.callTool({ name: 'log_trace', arguments: { agent_name: 'agent-a', output: 'Paris is the capital of France.' } }));
    const seen = body(await b.client.callTool({ name: 'get_traces', arguments: { agent_name: 'agent-a' } }));
    expect(JSON.stringify(seen)).toContain(String(logged.trace_id));

    // A rule deployed in A's session decides B's next evaluation.
    await a.client.callTool({ name: 'deploy_rule', arguments: { name: 'no-competitor', eval_type: 'custom', severity: 'high', definition: { type: 'regex_no_match', config: { pattern: 'Acme' } } } });
    const judged = body(await b.client.callTool({ name: 'evaluate_output', arguments: { output: 'We recommend Acme.', eval_type: 'custom' } }));
    expect(judged.passed).toBe(false);

    await a.client.close();
    await b.client.close();
  }, 60_000);

  it('after one client ends its session, another connects, and the one still open keeps working', async () => {
    const { url, http } = await boot();
    const a = await connect(url, 'client-a');
    const b = await connect(url, 'client-b');
    await a.transport.terminateSession();
    await a.client.close();
    expect(http.sessionCount()).toBe(1);

    const c = await connect(url, 'client-c');
    expect((await c.client.listTools()).tools.length).toBeGreaterThan(0);
    expect((await b.client.listTools()).tools.length).toBeGreaterThan(0);
    expect(http.sessionCount()).toBe(2);
    await b.client.close();
    await c.client.close();
  }, 60_000);

  it('a request with a session id the server does not hold is 404, and one with none is 400; neither opens a session', async () => {
    const { url, http } = await boot();
    const unknown = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': 'not-a-session' });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { message: string } }).error.message).toMatch(/Session not found.*send initialize again/);
    const none = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error: { message: string } }).error.message).toMatch(/no Mcp-Session-Id header/);
    expect(http.sessionCount()).toBe(0);
  });

  it('an initialize the transport refuses opens no session', async () => {
    const { url, http } = await boot();
    const refused = await post(url, initialize, { origin: 'https://evil.example.com' });
    expect(refused.status).toBe(403);
    expect(http.sessionCount()).toBe(0);
    // And the endpoint still serves the next client.
    const a = await connect(url, 'client-a');
    expect(http.sessionCount()).toBe(1);
    await a.client.close();
  });

  it('at the session limit a new client takes the place of the one quiet longest; when none is quiet it is told to retry', async () => {
    const { url, http } = await boot({ maxSessions: 2, sessionIdleMs: 300 });
    const a = await connect(url, 'client-a');
    const b = await connect(url, 'client-b');

    // Both just spoke: no session is quiet, so a third is refused and nothing is dropped.
    const full = await post(url, initialize);
    expect(full.status).toBe(503);
    expect(full.headers.get('retry-after')).toBe('1');
    expect(((await full.json()) as { error: { message: string } }).error.message).toMatch(/has 2 MCP sessions open and every one is in use/);
    expect(http.sessionCount()).toBe(2);

    // Still connected and quiet is still in use: a client holding its event stream keeps its session.
    await new Promise((r) => setTimeout(r, 400));
    expect((await post(url, initialize)).status).toBe(503);

    // A leaves without ending its session (no DELETE), as clients often do; B keeps talking.
    const left = String(a.transport.sessionId);
    await a.client.close();
    await new Promise((r) => setTimeout(r, 400));
    await b.client.listTools();
    const c = await connect(url, 'client-c');
    expect(http.sessionCount()).toBe(2);
    expect((await c.client.listTools()).tools.length).toBeGreaterThan(0);
    expect((await b.client.listTools()).tools.length).toBeGreaterThan(0);

    // A's session was given away: its next call is refused with 404, which a client answers by initializing again.
    const gone = await post(url, { jsonrpc: '2.0', id: 9, method: 'tools/list' }, { 'mcp-session-id': left });
    expect(gone.status).toBe(404);
    await b.client.close();
    await c.client.close();
  }, 60_000);

  it('given one MCP server instead of a function, it serves one client at a time and the next once the first has ended', async () => {
    const server = new McpServer({ name: 'one-instance', version: '0.0.0' });
    server.registerTool('ping', { description: 'Answers pong.' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
    const http = await createHttpTransport(server, config, logger);
    cleanup.push(async () => {
      await http.closeSessions();
      await close(http.httpServer);
    });
    const url = new URL(`http://127.0.0.1:${portOf(http.httpServer)}/mcp`);

    const a = await connect(url, 'client-a');
    expect((await a.client.listTools()).tools.map((t) => t.name)).toEqual(['ping']);
    const second = await post(url, initialize);
    expect(second.status).toBe(503);
    expect(((await second.json()) as { error: { message: string } }).error.message).toMatch(/speaks to one MCP client at a time and that client is connected/);

    await a.transport.terminateSession();
    await a.client.close();
    const b = await connect(url, 'client-b');
    expect((await b.client.listTools()).tools.map((t) => t.name)).toEqual(['ping']);
    await b.client.close();
  }, 60_000);

  it('closing the sessions at shutdown ends them all', async () => {
    const { url, http } = await boot();
    const a = await connect(url, 'client-a');
    const b = await connect(url, 'client-b');
    expect(http.sessionCount()).toBe(2);
    await http.closeSessions();
    expect(http.sessionCount()).toBe(0);
    await a.client.close().catch(() => undefined);
    await b.client.close().catch(() => undefined);
  });
});
