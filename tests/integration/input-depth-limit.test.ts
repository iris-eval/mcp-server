/*
 * The nesting limit (security.maxInputDepth, #1040).
 *
 * Several rules write an input out with a function that calls itself once
 * for each level, and past a few thousand levels the stack runs out and the
 * rule gives no answer. The bytes and the
 * elements of a request were bounded; the levels were not. So an input
 * nested deeper than the limit is refused at every door, before any rule
 * reads it.
 *
 * Held here: how the levels are counted; a tool call, a JSON body and a
 * protobuf body one level past the limit are refused with the limit named,
 * and nothing is stored; one at the limit passes; the session keeps
 * serving; an embedder's config without the key still gets the default,
 * and one outside the setting's range is held to it; a tool call is
 * measured as it was sent, in front of every tool, before its schema and
 * before the gate, and answered over the stdio and the HTTP transport
 * however deep it nests; and at the default every rule still answers an
 * input, an output and an expected input nested as deep as the door lets in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import type { StoreGate } from '../../src/storage/ready.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { createIrisServer } from '../../src/server.js';
import { createStdioTransport } from '../../src/transport/stdio.js';
import { createHttpTransport } from '../../src/transport/http.js';
import { DEFAULT_MAX_INPUT_DEPTH, DEFAULT_MAX_INPUT_ELEMENTS, defaultConfig, maxInputDepthOf } from '../../src/config/defaults.js';
import { decodeExportTraceServiceRequest, OtlpTooDeepError } from '../../src/otel/protobuf.js';
import { countElements, InputTooDeepError, jsonTextDepth, MAX_EVALUATED_DEPTH, MAX_JSON_TEXT_DEPTH, nestingDepth, tooDeepMessage } from '../../src/utils/element-count.js';
import { jsonByteLength, requestSizeLimitBytes } from '../../src/utils/size-limit.js';
import { toIrisError } from '../../src/tools/errors.js';
import { EvalEngine } from '../../src/eval/engine.js';
import { rulesByType } from '../../src/eval/rules/index.js';
import { toSteps } from '../../src/eval/steps.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import type { IrisConfig } from '../../src/types/config.js';
import { textOf, type ToolResult } from '../helpers/mcp-results.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** `levels` objects, each under the key "a" of the one above, around a number: `levels` levels deep. */
const objects = (levels: number): unknown => JSON.parse(`${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}`);
/** The same in arrays. */
const arrays = (levels: number): unknown => JSON.parse(`${'['.repeat(levels)}1${']'.repeat(levels)}`);

const withDepth = (maxInputDepth: number | undefined): IrisConfig => ({
  ...defaultConfig,
  dashboard: { ...defaultConfig.dashboard, port: 0 },
  security: { ...defaultConfig.security, maxInputDepth },
});

const tooDeep = (what: string, limit: number) => `${what} more than ${limit} levels deep, the limit (security.maxInputDepth, or IRIS_MAX_INPUT_DEPTH)`;

async function mcp(config: IrisConfig, gate?: (storage: SqliteAdapter) => StoreGate): Promise<{ client: Client; storage: SqliteAdapter; stored: () => Promise<number> }> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const { mcpServer } = createIrisServer(config, storage, undefined, { warn: () => {}, ...(gate ? { gate: gate(storage) } : {}) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverSide);
  const client = new Client({ name: 'input-depth-limit', version: '0.1.0' });
  await client.connect(clientSide);
  cleanup.push(async () => {
    await client.close();
    await storage.close();
  });
  return { client, storage, stored: async () => (await storage.queryTraces(LOCAL_TENANT, {})).total };
}

async function dashboard(config: IrisConfig): Promise<{ base: string; stored: () => Promise<number> }> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const server: Server = createDashboardServer(storage, config, quiet, {}).start();
  await new Promise((done) => server.once('listening', done));
  cleanup.push(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((done) => server.close(() => done()));
    await storage.close();
  });
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, stored: async () => (await storage.queryTraces(LOCAL_TENANT, {})).total };
}

const postJson = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** What a raw session got back for one request: the JSON-RPC answer, or that none came. */
type RawAnswer = { result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> }; error?: { code: number; message: string } } | 'no answer';
const NO_ANSWER_MS = 4_000;
/** The text of a tool call's answer, for a session that writes its own requests. */
const rawText = (answer: RawAnswer): string => (answer === 'no answer' ? 'no answer' : (answer.result?.content?.[0]?.text ?? JSON.stringify(answer)));
/** A tools/call request's params as the text a client writes, the arguments given as text: a client's own JSON.stringify cannot write a value nested a few thousand levels deep. */
const callText = (name: string, argumentsText: string): string => `{"name":${JSON.stringify(name)},"arguments":${argumentsText}}`;
const INITIALIZE = JSON.stringify({ protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'input-depth-limit-raw', version: '0.1.0' } });

/**
 * One MCP session over the stdio transport the server runs, with both of
 * its streams held here: every request is written as the line of text a
 * client would write to the server's stdin, and the answers are read off
 * its stdout.
 */
async function rawStdio(config: IrisConfig): Promise<{ ask: (method: string, paramsText: string) => Promise<RawAnswer>; stored: () => Promise<number> }> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const { mcpServer } = createIrisServer(config, storage, undefined, { warn: () => {} });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  // As src/index.ts builds it.
  await mcpServer.connect(createStdioTransport({ stdin, stdout, maxMessageBytes: requestSizeLimitBytes(config.security.requestSizeLimit) }));
  const waiting = new Map<number, (answer: RawAnswer) => void>();
  let buffered = '';
  stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (line.trim() === '') continue;
      const message = JSON.parse(line) as { id?: number } & Exclude<RawAnswer, string>;
      if (typeof message.id === 'number') waiting.get(message.id)?.(message);
    }
  });
  let next = 0;
  const ask = (method: string, paramsText: string): Promise<RawAnswer> => {
    const id = (next += 1);
    const answered = new Promise<RawAnswer>((done) => {
      waiting.set(id, done);
      setTimeout(() => done('no answer'), NO_ANSWER_MS).unref();
    });
    stdin.write(`{"jsonrpc":"2.0","id":${id},"method":${JSON.stringify(method)},"params":${paramsText}}\n`);
    return answered;
  };
  expect(await ask('initialize', INITIALIZE)).toHaveProperty('result');
  stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  cleanup.push(async () => {
    await mcpServer.close();
    await storage.close();
  });
  return { ask, stored: async () => (await storage.queryTraces(LOCAL_TENANT, {})).total };
}

/** One MCP session over the HTTP transport the server runs, each request posted as text. */
async function rawHttp(config: IrisConfig): Promise<{ ask: (method: string, paramsText: string) => Promise<RawAnswer>; stored: () => Promise<number> }> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const httpConfig: IrisConfig = { ...config, transport: { ...config.transport, type: 'http', host: '127.0.0.1', port: 0 } };
  const { newMcpServer } = createIrisServer(httpConfig, storage, undefined, { warn: () => {} });
  const http = await createHttpTransport(newMcpServer, httpConfig, quiet);
  const url = `http://127.0.0.1:${(http.httpServer.address() as { port: number }).port}/mcp`;
  cleanup.push(async () => {
    await http.closeSessions();
    http.httpServer.closeAllConnections?.();
    await new Promise<void>((done) => http.httpServer.close(() => done()));
    await storage.close();
  });
  let session: string | undefined;
  let next = 0;
  const ask = async (method: string, paramsText: string): Promise<RawAnswer> => {
    const id = (next += 1);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION } : {}) },
      body: `{"jsonrpc":"2.0","id":${id},"method":${JSON.stringify(method)},"params":${paramsText}}`,
      signal: AbortSignal.timeout(NO_ANSWER_MS),
    }).catch(() => undefined);
    if (res === undefined) return 'no answer';
    session ??= res.headers.get('mcp-session-id') ?? undefined;
    const text = await res.text();
    // The transport answers as JSON, or as one event of a stream whose data line is that JSON.
    const data = text.trimStart().startsWith('{') ? text : (text.split('\n').find((line) => line.startsWith('data:'))?.slice(5) ?? '');
    return data.trim() === '' ? 'no answer' : (JSON.parse(data) as RawAnswer);
  };
  expect(await ask('initialize', INITIALIZE)).toHaveProperty('result');
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': session ?? '', 'mcp-protocol-version': LATEST_PROTOCOL_VERSION }, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' });
  return { ask, stored: async () => (await storage.queryTraces(LOCAL_TENANT, {})).total };
}

describe('how the levels of an input are counted', () => {
  it('a scalar is no level, and an array or an object is one more than the deepest thing it holds', () => {
    for (const scalar of ['text', 0, 1.5, true, false, null, undefined]) expect(nestingDepth(scalar, 100)).toBe(0);
    expect(nestingDepth({}, 100)).toBe(1);
    expect(nestingDepth([], 100)).toBe(1);
    expect(nestingDepth({ a: 1, b: 'x', c: null }, 100)).toBe(1);
    expect(nestingDepth({ a: { a: 1 } }, 100)).toBe(2);
    expect(nestingDepth([[1], [[2]], 3], 100)).toBe(3);
    expect(nestingDepth({ a: [{ b: [] }], c: {} }, 100)).toBe(4);
    for (const levels of [1, 2, 7, 64, 255, 256, 257]) {
      expect(nestingDepth(objects(levels), 10_000), `${levels} objects`).toBe(levels);
      expect(nestingDepth(arrays(levels), 10_000), `${levels} arrays`).toBe(levels);
    }
    // The deepest branch decides, wherever it stands among its neighbours.
    expect(nestingDepth([objects(3), arrays(9), objects(5)], 100)).toBe(10);
    expect(nestingDepth({ first: arrays(9), second: 1, third: objects(2) }, 100)).toBe(10);
  });

  it('bytes are not a level, as they are not elements', () => {
    expect(nestingDepth(Buffer.from('abc'), 100)).toBe(0);
    expect(nestingDepth(new Uint8Array(8), 100)).toBe(0);
    expect(nestingDepth({ body: Buffer.from('abc'), more: [new Float64Array(2)] }, 100)).toBe(2);
    // Alone under a key, and alone in an array: the object or the array is the one level there is.
    expect(nestingDepth({ body: Buffer.from('abc') }, 100)).toBe(1);
    expect(nestingDepth([new Uint8Array(4)], 100)).toBe(1);
  });

  it('only what an object holds itself is a level of it, as only its own keys are elements of it', () => {
    const inherits = Object.assign(Object.create({ inherited: [[[1]]] }) as Record<string, unknown>, { own: 1 });
    expect(nestingDepth(inherits, 100)).toBe(1);
    expect(nestingDepth({ holds: inherits }, 100)).toBe(2);
  });

  it('stops at the first thing it finds past the limit, and says one more than the limit', () => {
    expect(nestingDepth(objects(256), 256)).toBe(256);
    expect(nestingDepth(objects(257), 256)).toBe(257);
    expect(nestingDepth(objects(5_000), 256)).toBe(257);
    expect(nestingDepth(arrays(5_000), 256)).toBe(257);
    expect(nestingDepth([1, 2, arrays(40)], 3)).toBe(4);
  });

  it('an input nested deeper than the stack holds is measured like any other, and a wide one is not a deep one', () => {
    // JSON.parse builds these without calling itself; a function that called itself once a level would not come back from them.
    expect(nestingDepth(objects(200_000), Infinity)).toBe(200_000);
    expect(nestingDepth(arrays(200_000), Infinity)).toBe(200_000);
    expect(nestingDepth(arrays(200_000), 256)).toBe(257);
    const wide = Array.from({ length: 100_000 }, (_, n) => [n]);
    expect(nestingDepth(wide, 256)).toBe(2);
    // An object of a hundred thousand keys, each an object that holds one of those arrays: three levels.
    expect(nestingDepth(Object.fromEntries(wide.map((value, n) => [`k${n}`, { value }])), 256)).toBe(3);
  });
});

describe('a tool call nested deeper than the limit', () => {
  // { output, tool_calls: [{ tool_name, input }] }: the arguments, the list and the call are three levels, and the input begins at the fourth.
  const call = (input: unknown) => ({ output: 'The file was read.', tool_calls: [{ tool_name: 'read_file', input }] });

  it('is answered with an error that names the limit, and one at the limit is evaluated', async () => {
    const { client } = await mcp(withDepth(6));
    const at = (await client.callTool({ name: 'evaluate_output', arguments: call(objects(3)) })) as ToolResult;
    expect(at.isError ?? false).toBe(false);
    for (const input of [objects(4), arrays(4), objects(400), arrays(50_000)]) {
      const past = (await client.callTool({ name: 'evaluate_output', arguments: call(input) })) as ToolResult;
      expect(past.isError).toBe(true);
      const body = JSON.parse(textOf(past)) as { error: { code: string; message: string; recovery: string[]; retryable: boolean } };
      expect(body.error.code).toBe('IRIS_INVALID_ARGUMENT');
      expect(body.error.message).toContain(tooDeep("This call's arguments nest", 6));
      expect(body.error.retryable).toBe(false);
      expect(body.error.recovery.join(' ')).toContain('IRIS_MAX_INPUT_DEPTH');
    }
    // The session still serves.
    const after = (await client.callTool({ name: 'evaluate_output', arguments: call({ path: 'src/a.ts' }) })) as ToolResult;
    expect(after.isError ?? false).toBe(false);
  });

  it('never reaches the tool: a trace nested too deep is not stored, and one at the limit is', async () => {
    const { client, stored } = await mcp(withDepth(6));
    const trace = (input: unknown) => ({ agent_name: 'deep-agent', output: 'Done.', tool_calls: [{ tool_name: 'read_file', input }] });
    const past = (await client.callTool({ name: 'log_trace', arguments: trace(objects(4)) })) as ToolResult;
    expect(past.isError).toBe(true);
    expect(await stored()).toBe(0);
    const at = (await client.callTool({ name: 'log_trace', arguments: trace(objects(3)) })) as ToolResult;
    expect(at.isError ?? false).toBe(false);
    expect(await stored()).toBe(1);
  });

  it('is measured in an output and in an expected input as in an input', async () => {
    const { client } = await mcp(withDepth(8));
    const refused = async (args: Record<string, unknown>): Promise<boolean> => ((await client.callTool({ name: 'evaluate_output', arguments: args })) as ToolResult).isError === true;
    // A call's output begins at the fourth level, as its input does.
    expect(await refused({ output: 'x', tool_calls: [{ tool_name: 't', input: {}, output: objects(5) }] })).toBe(false);
    expect(await refused({ output: 'x', tool_calls: [{ tool_name: 't', input: {}, output: objects(6) }] })).toBe(true);
    // { expected_trajectory: { tool_calls: [{ tool_name, input }] } }: an expected input begins at the fifth.
    const expecting = (input: unknown) => ({ output: 'x', tool_calls: [{ tool_name: 't', input: {} }], expected_trajectory: { tool_calls: [{ tool_name: 't', input }] } });
    expect(await refused(expecting(objects(4)))).toBe(false);
    expect(await refused(expecting(objects(5)))).toBe(true);
  });

  it('takes the default when the config was built without the key', async () => {
    const { client } = await mcp(withDepth(undefined));
    const at = (await client.callTool({ name: 'evaluate_output', arguments: call(objects(DEFAULT_MAX_INPUT_DEPTH - 3)) })) as ToolResult;
    expect(at.isError ?? false).toBe(false);
    const past = (await client.callTool({ name: 'evaluate_output', arguments: call(objects(DEFAULT_MAX_INPUT_DEPTH - 2)) })) as ToolResult;
    expect(past.isError).toBe(true);
    expect(textOf(past)).toContain(tooDeep("This call's arguments nest", DEFAULT_MAX_INPUT_DEPTH));
  });

  it('stands in front of every tool the server registers, whatever key of the arguments holds the nesting', async () => {
    const { client, stored } = await mcp(withDepth(6));
    // The server's own list, so a tool added later is asked too.
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['evaluate_output', 'log_trace', 'evaluate_runs', 'get_traces', 'deploy_rule', 'delete_rule', 'list_rules']));
    for (const name of names) {
      // Under a key no tool names, in a list, and in the keys the two ingesting tools read: the arguments are one level, so six more are past the limit.
      for (const args of [{ anything: objects(6) }, { anything: arrays(6) }, { metadata: objects(6) }, { spans: [{ attributes: objects(4) }] }, { tools: [{ name: 't', inputSchema: objects(4) }] }, { custom_rules: [{ config: objects(4) }] }]) {
        expect(nestingDepth(args, Infinity), name).toBe(7);
        const past = (await client.callTool({ name, arguments: args })) as ToolResult;
        expect(past.isError, `${name} ${Object.keys(args)[0]}`).toBe(true);
        expect(textOf(past), `${name} ${Object.keys(args)[0]}`).toContain(tooDeep("This call's arguments nest", 6));
      }
    }
    expect(await stored()).toBe(0);
  });

  it('is measured as it was sent, before the tool\'s schema reads it: a catalogue nested thousands of levels deep is answered with the limit named', async () => {
    // The catalogue's own check writes the catalogue out, a function that calls itself once for each level. Read before it was measured, a catalogue nested 6,000 levels ran the stack out there, and the caller was told only that.
    const { client, stored } = await mcp(withDepth(DEFAULT_MAX_INPUT_DEPTH));
    for (const levels of [DEFAULT_MAX_INPUT_DEPTH, 3_000, 6_000, 50_000]) {
      for (const name of ['evaluate_output', 'log_trace']) {
        const past = (await client.callTool({ name, arguments: { agent_name: 'a', output: 'x', tools: [{ name: 't', inputSchema: objects(levels) }] } })) as ToolResult;
        expect(past.isError, `${name} ${levels}`).toBe(true);
        const body = JSON.parse(textOf(past)) as { error: { code: string; message: string } };
        expect(body.error.code, `${name} ${levels}`).toBe('IRIS_INVALID_ARGUMENT');
        expect(body.error.message, `${name} ${levels}`).toContain(tooDeep("This call's arguments nest", DEFAULT_MAX_INPUT_DEPTH));
      }
    }
    expect(await stored()).toBe(0);
  });

  it('measures what was sent and not what the tool keeps: a value under a key the tool does not read is refused like any other', async () => {
    const { client, stored } = await mcp(withDepth(DEFAULT_MAX_INPUT_DEPTH));
    const kept = (await client.callTool({ name: 'log_trace', arguments: { agent_name: 'a', output: 'x', token_usage: { prompt_tokens: 1, unread: objects(DEFAULT_MAX_INPUT_DEPTH - 2) } } })) as ToolResult;
    expect(kept.isError ?? false).toBe(false);
    const past = (await client.callTool({ name: 'log_trace', arguments: { agent_name: 'a', output: 'x', token_usage: { prompt_tokens: 1, unread: objects(DEFAULT_MAX_INPUT_DEPTH - 1) } } })) as ToolResult;
    expect(past.isError).toBe(true);
    expect(textOf(past)).toContain(tooDeep("This call's arguments nest", DEFAULT_MAX_INPUT_DEPTH));
    expect(await stored()).toBe(1);
  });

  it('is refused before it waits at the gate, where an ordinary call is held', async () => {
    let waited = 0;
    // A store that is not serving yet, and does not come to serve while this test runs.
    const shut = (storage: SqliteAdapter): StoreGate => ({
      storage,
      ready: new Promise<void>(() => {}),
      hold: () => {},
      wait: () => {
        waited += 1;
        return new Promise<void>(() => {});
      },
      open: false,
    });
    const { client } = await mcp(withDepth(6), shut);
    const past = (await client.callTool({ name: 'evaluate_output', arguments: call(objects(4)) })) as ToolResult;
    expect(past.isError).toBe(true);
    expect(textOf(past)).toContain(tooDeep("This call's arguments nest", 6));
    expect(waited).toBe(0);
    // The probe can tell the two apart: a call at the limit reaches the gate and is held there.
    const held = client.callTool({ name: 'evaluate_output', arguments: call(objects(3)) }).then(
      () => 'answered',
      () => 'closed',
    );
    expect(await Promise.race([held, new Promise((done) => setTimeout(() => done('held'), 200))])).toBe('held');
    expect(waited).toBe(1);
  });

  it('counts the elements first: arguments over that limit are answered by the count, and the levels are measured inside it', async () => {
    const { client } = await mcp({ ...withDepth(6), security: { ...withDepth(6).security, maxInputElements: 50 } });
    const calls = (n: number) => ({ output: 'x', tool_calls: Array.from({ length: n }, () => ({ tool_name: 't', input: objects(4) })) });
    // Thirty calls nested past the limit hold more than fifty elements: the count answers, as it does for a flat call that size.
    const both = (await client.callTool({ name: 'evaluate_output', arguments: calls(30) })) as ToolResult;
    expect(both.isError).toBe(true);
    expect(textOf(both)).toMatch(/arguments contain more than the maximum of 50 elements/);
    // One such call is within the count, and the levels answer.
    const deep = (await client.callTool({ name: 'evaluate_output', arguments: calls(1) })) as ToolResult;
    expect(deep.isError).toBe(true);
    expect(textOf(deep)).toContain(tooDeep("This call's arguments nest", 6));
    // At the count's edge: arguments of exactly fifty elements are within it, so their levels are measured; fifty-one are the count's.
    const padded = (total: number): Record<string, unknown> => {
      const args = { output: 'x', tool_calls: [{ tool_name: 't', input: objects(4) }], metadata: {} as Record<string, number> };
      for (let n = 0, pad = total - countElements(args, Infinity); n < pad; n += 1) args.metadata[`k${n}`] = n;
      return args;
    };
    expect(countElements(padded(50), Infinity)).toBe(50);
    expect(nestingDepth(padded(50), Infinity)).toBe(7);
    expect(textOf((await client.callTool({ name: 'evaluate_output', arguments: padded(50) })) as ToolResult)).toContain(tooDeep("This call's arguments nest", 6));
    expect(textOf((await client.callTool({ name: 'evaluate_output', arguments: padded(51) })) as ToolResult)).toMatch(/arguments contain more than the maximum of 50 elements/);
  });

  it('says to raise the limit only where it can be raised', async () => {
    // Below the most the setting can be, the answer says so and names how high it goes.
    const low = (await (await mcp(withDepth(6))).client.callTool({ name: 'evaluate_output', arguments: call(objects(4)) })) as ToolResult;
    const lowBody = JSON.parse(textOf(low)) as { error: { message: string; recovery: string[] } };
    expect(lowBody.error.message).toContain('Nothing was read or stored.');
    expect(lowBody.error.message).toContain('or raise the limit.');
    expect(lowBody.error.recovery.join(' ')).toContain(`can be set as high as ${MAX_EVALUATED_DEPTH}`);
    // So it does from the default up to one below the most.
    for (const limit of [DEFAULT_MAX_INPUT_DEPTH, MAX_EVALUATED_DEPTH - 1]) {
      const between = (await (await mcp(withDepth(limit))).client.callTool({ name: 'evaluate_output', arguments: call(objects(limit - 2)) })) as ToolResult;
      const body = JSON.parse(textOf(between)) as { error: { message: string; recovery: string[] } };
      expect(body.error.message, String(limit)).toContain(tooDeep("This call's arguments nest", limit));
      expect(body.error.message, String(limit)).toContain('or raise the limit.');
      expect(body.error.recovery.join(' '), String(limit)).toContain(`can be set as high as ${MAX_EVALUATED_DEPTH}`);
    }
    // At the most, raising it is not on offer.
    const top = (await (await mcp(withDepth(MAX_EVALUATED_DEPTH))).client.callTool({ name: 'evaluate_output', arguments: call(objects(MAX_EVALUATED_DEPTH - 2)) })) as ToolResult;
    expect(top.isError).toBe(true);
    const topBody = JSON.parse(textOf(top)) as { error: { message: string; recovery: string[] } };
    expect(topBody.error.message).toContain(tooDeep("This call's arguments nest", MAX_EVALUATED_DEPTH));
    expect(topBody.error.message).not.toContain('raise the limit');
    expect(topBody.error.message).toContain(`no evaluation reads an input nested deeper than ${MAX_EVALUATED_DEPTH} levels`);
    expect(topBody.error.recovery.join(' ')).not.toContain('raises');
    expect(tooDeepMessage('The request body nests', MAX_EVALUATED_DEPTH)).not.toContain('raise the limit');
    expect(tooDeepMessage('The request body nests', MAX_EVALUATED_DEPTH - 1)).toContain('or raise the limit.');
  });

  it('holds a config that did not come through the loader to the setting\'s range: the door never lets in what the engine refuses', async () => {
    // An embedder's own config object: never deeper than an evaluation reads, and the default for what is not a whole number of at least 1.
    const HELD: Array<[set: unknown, held: number]> = [[5_000, MAX_EVALUATED_DEPTH], [MAX_EVALUATED_DEPTH + 1, MAX_EVALUATED_DEPTH], [Infinity, MAX_EVALUATED_DEPTH], [NaN, DEFAULT_MAX_INPUT_DEPTH], [1.5, DEFAULT_MAX_INPUT_DEPTH], [MAX_EVALUATED_DEPTH + 0.5, DEFAULT_MAX_INPUT_DEPTH], [0, DEFAULT_MAX_INPUT_DEPTH], [-5, DEFAULT_MAX_INPUT_DEPTH], ['300', DEFAULT_MAX_INPUT_DEPTH], [null, DEFAULT_MAX_INPUT_DEPTH]];
    for (const [set, held] of HELD) expect(maxInputDepthOf({ maxInputDepth: set as number }), String(set)).toBe(held);
    for (const within of [1, 6, DEFAULT_MAX_INPUT_DEPTH, 300, MAX_EVALUATED_DEPTH]) expect(maxInputDepthOf({ maxInputDepth: within })).toBe(within);
    for (const set of [5_000, Infinity, NaN]) {
      const { client, stored } = await mcp(withDepth(set));
      // Logged and judged in one call: let in by a door standing past the engine, the trace was stored and the call then answered with the engine's refusal.
      const past = (await client.callTool({ name: 'log_trace', arguments: { agent_name: 'a', output: 'Done.', evaluate: true, tool_calls: [{ tool_name: 't', input: objects(600) }] } })) as ToolResult;
      expect(past.isError, String(set)).toBe(true);
      expect(textOf(past), String(set)).toContain("This call's arguments nest more than");
      expect(await stored(), String(set)).toBe(0);
    }
  });
});

describe('a tool call nested deeper than the limit, through the transports a client uses', () => {
  // A request is written here as text, as a client writes it: the arguments of one call, its input nested in arrays.
  const deepCall = (levels: number): string => callText('evaluate_output', `{"output":"The file was read.","tool_calls":[{"tool_name":"read_file","input":${'['.repeat(levels)}1${']'.repeat(levels)}}]}`);
  const ordinary = callText('evaluate_output', '{"output":"The file was read.","tool_calls":[{"tool_name":"read_file","input":{"path":"src/a.ts"}}]}');
  const refusal = tooDeep("This call's arguments nest", DEFAULT_MAX_INPUT_DEPTH);
  const OVER_THE_COUNT = `arguments contain more than the maximum of ${DEFAULT_MAX_INPUT_ELEMENTS} elements`;

  it('over stdio it is answered with the limit named however deep it nests, and the session goes on', async () => {
    // The transport measures every message in bytes by writing it out, which calls itself once for each level: from about 4,800 levels that threw, and the request was never answered.
    const { ask, stored } = await rawStdio(withDepth(DEFAULT_MAX_INPUT_DEPTH));
    for (const levels of [DEFAULT_MAX_INPUT_DEPTH, 4_700, 4_800, 5_000, 50_000, 90_000]) {
      const answer = await ask('tools/call', deepCall(levels));
      expect(rawText(answer), `${levels} arrays`).toContain(refusal);
      expect(answer === 'no answer' ? undefined : answer.result?.isError, `${levels} arrays`).toBe(true);
    }
    // Deeper still it holds more elements than a call may: answered all the same, by the count, which is taken first.
    expect(rawText(await ask('tools/call', deepCall(200_000)))).toContain(OVER_THE_COUNT);
    // A catalogue nested as deep, which the tool's schema would write out.
    for (const levels of [6_000, 50_000]) {
      const answer = await ask('tools/call', callText('log_trace', `{"agent_name":"a","output":"x","tools":[{"name":"t","inputSchema":${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}}]}`));
      expect(rawText(answer), `a catalogue of ${levels} objects`).toContain(refusal);
    }
    const after = await ask('tools/call', ordinary);
    expect(after === 'no answer' ? undefined : (after.result?.isError ?? false)).toBe(false);
    expect(await stored()).toBe(0);
  }, 30_000);

  it('over stdio a message over the byte limit is still refused for its size when it is nested too deep to write out, with its size given', async () => {
    const { ask } = await rawStdio({ ...withDepth(DEFAULT_MAX_INPUT_DEPTH), security: { ...defaultConfig.security, requestSizeLimit: '20kb' } });
    // 10,000 arrays are 20,000 bytes of brackets alone: over 20 KiB with what stands around them, and nested deeper than the message can be written out.
    const params = deepCall(10_240);
    const answer = await ask('tools/call', params);
    const id = 2;
    const bytes = Buffer.byteLength(`{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":${params}}`);
    expect(bytes).toBeGreaterThan(20 * 1024);
    expect(answer === 'no answer' ? 'no answer' : answer.error?.message).toContain(`Request too large: ${bytes} bytes, over the 20480-byte limit (security.requestSizeLimit)`);
    // Under the limit and as deep, it goes on to the door.
    expect(rawText(await ask('tools/call', deepCall(5_000)))).toContain(refusal);
  });

  it('over HTTP it is answered with the limit named however deep it nests, and the session goes on', async () => {
    const { ask, stored } = await rawHttp(withDepth(DEFAULT_MAX_INPUT_DEPTH));
    for (const levels of [DEFAULT_MAX_INPUT_DEPTH, 5_000, 50_000, 90_000]) {
      const answer = await ask('tools/call', deepCall(levels));
      expect(rawText(answer), `${levels} arrays`).toContain(refusal);
    }
    expect(rawText(await ask('tools/call', deepCall(200_000)))).toContain(OVER_THE_COUNT);
    for (const levels of [6_000, 50_000]) {
      const answer = await ask('tools/call', callText('log_trace', `{"agent_name":"a","output":"x","tools":[{"name":"t","inputSchema":${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}}]}`));
      expect(rawText(answer), `a catalogue of ${levels} objects`).toContain(refusal);
    }
    const after = await ask('tools/call', ordinary);
    expect(after === 'no answer' ? undefined : (after.result?.isError ?? false)).toBe(false);
    expect(await stored()).toBe(0);
  }, 30_000);

  it('at the limit it is let in over both, and judged', async () => {
    // { output, tool_calls: [{ tool_name, input }] }: three levels around the input.
    const at = deepCall(DEFAULT_MAX_INPUT_DEPTH - 3);
    for (const session of [await rawStdio(withDepth(DEFAULT_MAX_INPUT_DEPTH)), await rawHttp(withDepth(DEFAULT_MAX_INPUT_DEPTH))]) {
      const answer = await session.ask('tools/call', at);
      expect(answer === 'no answer' ? undefined : (answer.result?.isError ?? false)).toBe(false);
      expect((JSON.parse(rawText(answer)) as { rule_results: unknown[] }).rule_results.length).toBeGreaterThan(20);
    }
  });
});

describe('the bytes of a message, counted without writing it out', () => {
  it('are the bytes JSON.stringify would write, for a value of any shape', () => {
    const VALUES: unknown[] = [
      null, true, false, 0, -0, 1, -1, 1.5, 1e21, 1.5e-7, 2 ** 53, '', 'plain', 'é', '日本語', '😀', 'a"b', 'a\\b', 'line\nbreak\ttab', '\u0000\u001f', '\ud800', '</script>', '  ',
      [], {}, [[]], [{}], { a: [] }, [1, 'two', null, true, [3, [4, { five: 5 }]]], { 'k"ey': 'v', 'é': { '😀': ['\\'] }, '': 0 },
      { a: undefined, b: 1 }, { a: undefined }, [undefined, 1, undefined], { __proto__: null, a: 1 }, JSON.parse('{"__proto__":{"a":[1]},"b":2}'),
      objects(40), arrays(40), Array.from({ length: 500 }, (_, n) => ({ n, text: `value ${n}`, more: [n, n + 0.5, String(n)] })),
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'evaluate_output', arguments: { output: 'The file was read.', tool_calls: [{ tool_name: 'read_file', input: { path: 'src/a.ts' } }] } } },
    ];
    for (const value of VALUES) expect(jsonByteLength(value), JSON.stringify(value)?.slice(0, 60)).toBe(Buffer.byteLength(JSON.stringify(value), 'utf8'));
    // Generated: nested lists and objects of every scalar, with keys and strings that need escaping.
    let seed = 0x2f6e2b1;
    const random = (): number => {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) | 0;
      return ((seed ^ (seed >>> 13)) >>> 0) / 0x1_0000_0000;
    };
    const SCALARS: unknown[] = [null, true, false, 0, 7, -3.25, 1e300, '', 'x', 'two words', 'q"uote', 'back\\slash', '\n', 'é😀', '\u0007'];
    const build = (depth: number): unknown => {
      const pick = random();
      if (depth === 0 || pick < 0.4) return SCALARS[Math.floor(random() * SCALARS.length)];
      const size = Math.floor(random() * 5);
      if (pick < 0.7) return Array.from({ length: size }, () => build(depth - 1));
      return Object.fromEntries(Array.from({ length: size }, (_, n) => [`${String(SCALARS[3 + Math.floor(random() * (SCALARS.length - 3))])}${n}`, build(depth - 1)]));
    };
    for (let n = 0; n < 2_000; n += 1) {
      const value = build(6);
      expect(jsonByteLength(value)).toBe(Buffer.byteLength(JSON.stringify(value), 'utf8'));
    }
  });

  it('measures a value nested deeper than JSON.stringify can write', () => {
    // `levels` arrays around a 1: two brackets each, and the 1.
    for (const levels of [10_000, 200_000]) {
      expect(() => JSON.stringify(arrays(levels))).toThrow(RangeError);
      expect(jsonByteLength(arrays(levels))).toBe(2 * levels + 1);
      // `{"a":` and `}` for each object: six bytes a level.
      expect(jsonByteLength(objects(levels))).toBe(6 * levels + 1);
    }
  });
});

describe('a request body nested deeper than the limit', () => {
  // { agent_name, output, tool_calls: [{ tool_name, input }] }: the input begins at the fourth level.
  const trace = (input: unknown) => ({ agent_name: 'a', output: 'x', tool_calls: [{ tool_name: 't', input }] });

  it('is answered 413 on POST /api/v1/traces before the schema reads it, and nothing is stored; one at the limit is', async () => {
    const { base, stored } = await dashboard(withDepth(6));
    const past = await postJson(`${base}/api/v1/traces`, trace(objects(4)));
    const text = await past.text();
    expect(past.status).toBe(413);
    expect(JSON.parse(text)).toEqual({ error: expect.stringContaining(tooDeep('The request body nests', 6)), limit: 6 });
    expect(Buffer.byteLength(text)).toBeLessThan(400);
    expect(await stored()).toBe(0);
    expect((await postJson(`${base}/api/v1/traces`, trace(objects(3)))).status).toBe(201);
    expect(await stored()).toBe(1);
  });

  it('is answered 413 on every JSON route, not only trace ingest, and however deep it is', async () => {
    const { base } = await dashboard(withDepth(5));
    const datasets = await postJson(`${base}/api/v1/datasets`, { label: 'd', case_keys: arrays(5) });
    expect(datasets.status).toBe(413);
    expect(((await datasets.json()) as { limit: number }).limit).toBe(5);
    // Whatever the method: a body that is changed is measured as one that is created.
    for (const [method, path] of [['PATCH', '/api/v1/preferences'], ['PATCH', '/api/v1/runs/some-run'], ['PUT', '/api/v1/preferences'], ['DELETE', '/api/v1/datasets/some-dataset']] as const) {
      const changed = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ anything: arrays(5) }) });
      expect(changed.status, `${method} ${path}`).toBe(413);
      expect(((await changed.json()) as { error: string }).error, `${method} ${path}`).toContain(tooDeep('The request body nests', 5));
    }
    // 50,000 levels of arrays are 100 KB and 50,000 elements: within the bytes, within the elements, and deeper than any stack.
    const deep = await fetch(`${base}/api/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"agent_name":"a","output":"x","metadata":${'['.repeat(50_000)}${']'.repeat(50_000)}}` });
    expect(deep.status).toBe(413);
    expect(((await deep.json()) as { error: string }).error).toContain(tooDeep('The request body nests', 5));
  });

  it('is answered 413 on POST /v1/traces as JSON', async () => {
    const { base, stored } = await dashboard(withDepth(DEFAULT_MAX_INPUT_DEPTH));
    // An attribute's value nested in arrays: { arrayValue: { values: [ ... ] } } is three levels for each one.
    let value: unknown = { intValue: '1' };
    for (let n = 0; n < 100; n += 1) value = { arrayValue: { values: [value] } };
    const span = { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', name: 's', startTimeUnixNano: '1', endTimeUnixNano: '2', attributes: [{ key: 'k', value }] };
    const res = await postJson(`${base}/v1/traces`, { resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toContain(tooDeep('The request body nests', DEFAULT_MAX_INPUT_DEPTH));
    expect(await stored()).toBe(0);
  });
});

describe('a protobuf body nested deeper than the limit', () => {
  const varint = (n: number): number[] => {
    const out: number[] = [];
    while (n > 127) {
      out.push((n & 127) | 128);
      n >>>= 7;
    }
    out.push(n);
    return out;
  };
  /**
   * An ExportTraceServiceRequest of one span with one attribute, whose value is an integer inside `levels` arrays:
   * AnyValue { array_value: ArrayValue { values: [AnyValue ...] } }, two messages for each array. Built from the
   * inside out by lengths, so that a hundred thousand levels are built in one pass.
   */
  function nestedArrays(levels: number): Buffer {
    const prefixes: number[][] = [];
    let length = 2; // AnyValue { int_value: 1 }: tag 0x18, then 1.
    const wrap = (tag: number): void => {
      const prefix = [tag, ...varint(length)];
      prefixes.push(prefix);
      length += prefix.length;
    };
    for (let n = 0; n < levels; n += 1) {
      wrap(0x0a); // ArrayValue.values
      wrap(0x2a); // AnyValue.array_value
    }
    wrap(0x12); // KeyValue.value
    wrap(0x4a); // Span.attributes
    wrap(0x12); // ScopeSpans.spans
    wrap(0x12); // ResourceSpans.scope_spans
    wrap(0x0a); // ExportTraceServiceRequest.resource_spans
    return Buffer.from([...prefixes.reverse().flat(), 0x18, 0x01]);
  }
  const postProtobuf = (url: string, body: Buffer) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body });

  it('decodes to the object a JSON body of the same shape is: three levels for each array, ten around them', () => {
    for (const levels of [0, 1, 2, 30]) {
      const decoded = decodeExportTraceServiceRequest(nestedArrays(levels));
      expect(nestingDepth(decoded, Infinity), `${levels} arrays`).toBe(10 + 3 * levels);
    }
  });

  it('is answered 413 once decoded, and one at the limit goes on to the schema', async () => {
    const { base, stored } = await dashboard(withDepth(DEFAULT_MAX_INPUT_DEPTH));
    // 82 arrays decode to 256 levels, and 83 to 259.
    expect(10 + 3 * 82).toBe(DEFAULT_MAX_INPUT_DEPTH);
    const at = await postProtobuf(`${base}/v1/traces`, nestedArrays(82));
    expect(at.status).not.toBe(413);
    const past = await postProtobuf(`${base}/v1/traces`, nestedArrays(83));
    expect(past.status).toBe(413);
    expect(await past.json()).toEqual({ error: expect.stringContaining(tooDeep('The request body nests', DEFAULT_MAX_INPUT_DEPTH)), limit: DEFAULT_MAX_INPUT_DEPTH });
    expect(await stored()).toBe(0);
  });

  it('is refused as it decodes when its messages nest deeper than the limit, however deep: the decoder does not run the stack out', async () => {
    // The decoder calls itself once for each message. Fifty thousand arrays are a hundred thousand messages and 400 KB.
    const deep = nestedArrays(50_000);
    expect(deep.length).toBeLessThan(1_048_576);
    expect(() => decodeExportTraceServiceRequest(deep, { maxDepth: DEFAULT_MAX_INPUT_DEPTH })).toThrow(OtlpTooDeepError);
    // A message may stand inside as many others as the limit says, and no more: five stand around the first array's, and each array is two.
    expect(() => decodeExportTraceServiceRequest(nestedArrays(10), { maxDepth: 5 + 2 * 10 })).not.toThrow();
    expect(() => decodeExportTraceServiceRequest(nestedArrays(10), { maxDepth: 5 + 2 * 10 - 1 })).toThrow(OtlpTooDeepError);
    const { base, stored } = await dashboard(withDepth(DEFAULT_MAX_INPUT_DEPTH));
    const res = await postProtobuf(`${base}/v1/traces`, deep);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toContain(tooDeep('The request body nests', DEFAULT_MAX_INPUT_DEPTH));
    expect(await stored()).toBe(0);
  });

  it('takes the setting and not the default: a lowered limit refuses a protobuf body the default lets in', async () => {
    const { base } = await dashboard(withDepth(40));
    // Ten arrays decode to 40 levels, and eleven to 43.
    expect((await postProtobuf(`${base}/v1/traces`, nestedArrays(10))).status).not.toBe(413);
    const past = await postProtobuf(`${base}/v1/traces`, nestedArrays(11));
    expect(past.status).toBe(413);
    expect(((await past.json()) as { limit: number }).limit).toBe(40);
  });

  it('lets the real protobuf exports in tests/fixtures/otlp through at the default, far inside it', async () => {
    const { base } = await dashboard(withDepth(DEFAULT_MAX_INPUT_DEPTH));
    for (const name of ['python-plain.pb', 'python-genai.pb']) {
      const body = readFileSync(resolve(__dirname, '../fixtures/otlp', name));
      expect(nestingDepth(decodeExportTraceServiceRequest(body), Infinity), name).toBeLessThan(DEFAULT_MAX_INPUT_DEPTH / 5);
      expect((await postProtobuf(`${base}/v1/traces`, body)).status, name).toBe(200);
    }
  });
});

describe('a string that holds JSON, which is no level to a door', () => {
  const text = (levels: number): string => `${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}`;

  it('where an object writes one key twice the text nests deeper than the value it parses to; over two thousand texts built at random, never the other way', () => {
    // JSON.parse keeps the last value of a key written twice, so the text's brackets can outnumber the value's levels. The scan errs to the side of reading such a text as the text it is.
    const TWICE: Array<[text: string, textDepth: number, valueDepth: number]> = [
      [`{"a":${text(300)},"a":1}`, 301, 1],
      [`{"a":1,"a":${text(300)}}`, 301, 301],
      [`{"k":{"a":${text(4)},"a":[]}}`, 6, 3],
      [`[{"a":[[[1]]],"a":2},[[3]]]`, 5, 3],
    ];
    for (const [written, textDepth, valueDepth] of TWICE) {
      expect(jsonTextDepth(written, Infinity), written.slice(0, 40)).toBe(textDepth);
      expect(nestingDepth(JSON.parse(written), Infinity), written.slice(0, 40)).toBe(valueDepth);
      expect(jsonTextDepth(written, Infinity)).toBeGreaterThanOrEqual(nestingDepth(JSON.parse(written), Infinity));
    }
    // Texts built at random from a fixed seed, their objects drawing each key from two, so most write one key twice.
    let seed = 7;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return (seed >>> 16) % n;
    };
    const build = (levels: number): string => {
      if (levels === 0 || next(4) === 0) return String(next(10));
      const items = Array.from({ length: 1 + next(3) }, () => build(levels - 1));
      return next(2) === 0 ? `[${items.join(',')}]` : `{${items.map((item) => `"${'ab'[next(2)]}":${item}`).join(',')}}`;
    };
    let twice = 0;
    for (let n = 0; n < 2_000; n += 1) {
      const written = build(8);
      const valueDepth = nestingDepth(JSON.parse(written), Infinity);
      expect(jsonTextDepth(written, Infinity), written).toBeGreaterThanOrEqual(valueDepth);
      if (jsonTextDepth(written, Infinity) > valueDepth) twice += 1;
    }
    // The texts reach the case the scan errs on, not only the one it reads exactly.
    expect(twice).toBeGreaterThan(100);
  });

  it('its depth is read off the text: for a text that writes no key twice, what the value it parses to would measure, whatever its strings hold', () => {
    // A JSON text is read as the value it encodes down to as many levels as a door lets in by default.
    expect(MAX_JSON_TEXT_DEPTH).toBe(256);
    expect(MAX_JSON_TEXT_DEPTH).toBe(DEFAULT_MAX_INPUT_DEPTH);
    for (const levels of [1, 2, 9, 256, 257, 5_000]) expect(jsonTextDepth(text(levels), Infinity), `${levels}`).toBe(levels);
    const VALUES: unknown[] = [
      1, 'plain', null, true, [], {}, [[]], { a: [] }, [1, [2, [3, [4]]], { a: { b: [{}] } }],
      // Brackets, braces, quotation marks and backslashes inside strings and keys are text, not levels.
      ['[[[[', '{{{{', ']]]]', '}}}}'], { '[': '{', ']': '}' }, ['say "[" then "]"', 'a\\', '\\"[', 'tab\there', 'é[[', '\\\\['],
      { 'k"[': [{ '\\': ['"]'] }] }, [[['"'], '\\'], '[', [[[']']]]],
      objects(40), arrays(40), [objects(3), arrays(9), { deep: arrays(12), flat: '[[[[[[[[[[[[[[[[[[[[' }],
    ];
    for (const value of VALUES) {
      for (const written of [JSON.stringify(value), JSON.stringify(value, null, 2)]) {
        expect(jsonTextDepth(written, Infinity), written.slice(0, 60)).toBe(nestingDepth(JSON.parse(written), Infinity));
      }
    }
    // Texts JSON.stringify does not write: a bracket spelled as an escape, an escaped quotation mark in a key, white space between everything.
    for (const written of ['["\\u005b\\u005b"]', '{"a\\"[":["\\\\"]}', ' [ { "a" : [ ] } ,\n\t[ [ ] ] ] ']) {
      expect(jsonTextDepth(written, Infinity), written).toBe(nestingDepth(JSON.parse(written), Infinity));
    }
    // It stops at the first bracket past the limit, and says one more than the limit.
    expect(jsonTextDepth(text(5_000), 256)).toBe(257);
    expect(jsonTextDepth(`${'['.repeat(1_000_000)}`, 256)).toBe(257);
  });

  it('a span\'s arguments written as JSON are read as the value they encode down to the limit, and as the text they are past it', () => {
    const span = (args: string) => ({ trace_id: 't'.repeat(32), span_id: 's1', name: 'tool.apply_patch', kind: 'TOOL' as const, status_code: 'UNSET' as const, start_time: '2026-01-01T00:00:00.000Z', attributes: { 'gen_ai.tool.name': 'apply_patch', 'gen_ai.tool.call.arguments': args } });
    const inputOf = (args: string): unknown => toSteps({ spans: [span(args)] })[0]?.input;
    expect(inputOf('{"path":"src/a.ts","lines":[1,2]}')).toEqual({ path: 'src/a.ts', lines: [1, 2] });
    expect(nestingDepth(inputOf(text(MAX_JSON_TEXT_DEPTH)), Infinity)).toBe(MAX_JSON_TEXT_DEPTH);
    for (const levels of [MAX_JSON_TEXT_DEPTH + 1, 3_000, 50_000]) expect(inputOf(text(levels)), `${levels} levels`).toBe(text(levels));
  });

  it('a run whose spans carry arguments nested thousands of levels deep, as a string, is judged by every rule asked', async () => {
    // Read as a value, such arguments left the rules that write an input out with no answer; a run that repeated one call was passed.
    const { client } = await mcp(withDepth(DEFAULT_MAX_INPUT_DEPTH));
    for (const levels of [MAX_JSON_TEXT_DEPTH, MAX_JSON_TEXT_DEPTH + 1, 3_000, 20_000]) {
      const spans = Array.from({ length: 6 }, (_, n) => ({ span_id: `s${levels}-${n}`, name: 'tool.apply_patch', kind: 'TOOL', start_time: `2026-01-01T00:00:0${n}.000Z`, attributes: { 'gen_ai.tool.name': 'apply_patch', 'gen_ai.tool.call.arguments': text(levels) } }));
      const logged = (await client.callTool({ name: 'log_trace', arguments: { agent_name: 'a', output: 'The patch was applied and the tests pass.', spans } })) as ToolResult;
      expect(logged.isError ?? false, `${levels} levels`).toBe(false);
      const traceId = (JSON.parse(textOf(logged)) as { trace_id: string }).trace_id;
      const result = (await client.callTool({ name: 'evaluate_output', arguments: { trace_id: traceId } })) as ToolResult;
      expect(result.isError ?? false, `${levels} levels`).toBe(false);
      const body = JSON.parse(textOf(result)) as { rule_results: Array<{ ruleName: string; threw?: boolean }> };
      expect(body.rule_results.length, `${levels} levels`).toBeGreaterThan(20);
      expect(body.rule_results.filter((r) => r.threw === true).map((r) => r.ruleName), `${levels} levels`).toEqual([]);
    }
  });

  it('an output a custom schema rule reads as JSON is judged down to the limit, and past it the rule answers that the shape was not judged', async () => {
    // A schema that refers to itself is checked by a validator that calls itself for each level of the value: on an output nested a few thousand levels deep the rule gave no answer.
    const engine = new EvalEngine();
    const shape = { name: 'shape', type: 'json_schema' as const, config: { schema: { type: ['object', 'number'], properties: { a: { $ref: '#' } } } }, severity: 'high' as const };
    const answerOf = async (output: string) => (await engine.evaluate('custom', { output }, [shape])).rule_results.find((r) => r.ruleName === 'shape');
    expect(await answerOf(text(MAX_JSON_TEXT_DEPTH))).toMatchObject({ passed: true, message: 'Output matches the configured JSON Schema' });
    for (const levels of [MAX_JSON_TEXT_DEPTH + 1, 4_400, 20_000]) {
      const answer = await answerOf(text(levels));
      expect(answer?.threw, `${levels} levels`).toBeUndefined();
      expect(answer, `${levels} levels`).toMatchObject({ passed: false, skipped: true, skipReason: `the output could not be checked: it nests more than ${MAX_JSON_TEXT_DEPTH} levels deep` });
    }
  });
});

describe('an input no door stood in front of', () => {
  it('the engine refuses an evaluation whose input nests deeper than it evaluates, and says so; one at that depth is judged by every rule', async () => {
    // An embedder's own call. { output, toolCalls: [{ tool_name, input }] }: the input begins at the fourth level.
    const engine = new EvalEngine();
    const context = (input: unknown) => ({ output: 'The file was read and the report written.', toolCalls: [{ tool_name: 't', input }, { tool_name: 't', input }] });
    for (const at of [objects(MAX_EVALUATED_DEPTH - 3), arrays(MAX_EVALUATED_DEPTH - 3)]) {
      expect(nestingDepth(context(at), Infinity)).toBe(MAX_EVALUATED_DEPTH);
      const result = await engine.evaluateAll(context(at));
      expect(result.rule_results.length).toBeGreaterThan(20);
      expect(result.rule_results.filter((r) => r.threw === true).map((r) => r.ruleName)).toEqual([]);
    }
    for (const past of [objects(MAX_EVALUATED_DEPTH - 2), arrays(MAX_EVALUATED_DEPTH - 2), objects(20_000)]) {
      const refused = await engine.evaluateAll(context(past)).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(InputTooDeepError);
      expect((refused as InputTooDeepError).message).toContain(`nests more than ${MAX_EVALUATED_DEPTH} levels deep`);
      expect((refused as InputTooDeepError).limit).toBe(MAX_EVALUATED_DEPTH);
      // One bundle is refused as every bundle is.
      await expect(engine.evaluate('cost', context(past))).rejects.toBeInstanceOf(InputTooDeepError);
    }
  });

  it('the engine measures the whole of what a rule can be handed, wherever the nesting stands in it', async () => {
    const engine = new EvalEngine();
    const base = { output: 'The file was read and the report written.', toolCalls: [{ tool_name: 'read_file', input: { path: 'src/a.ts' } }] };
    // Each places an object nested `under` levels where the whole context then nests one level past what the engine reads.
    const PLACES: Array<[where: string, around: number, context: (deep: unknown) => Record<string, unknown>]> = [
      ['a call\'s input', 3, (deep) => ({ ...base, toolCalls: [{ tool_name: 'read_file', input: deep }] })],
      ['a call\'s output', 3, (deep) => ({ ...base, toolCalls: [{ tool_name: 'read_file', input: {}, output: deep }] })],
      ['a span\'s attribute', 4, (deep) => ({ ...base, spans: [{ span_id: 's1', name: 'tool.read_file', kind: 'TOOL', attributes: { args: deep } }] })],
      ['a catalogue\'s schema', 3, (deep) => ({ ...base, tools: [{ name: 'read_file', inputSchema: deep }] })],
      ['an expected input', 4, (deep) => ({ ...base, expectedTrajectory: { tool_calls: [{ tool_name: 'read_file', input: deep }] } })],
      ['the metadata', 2, (deep) => ({ ...base, metadata: { extra: deep } })],
      ['a setting sent with the call', 2, (deep) => ({ ...base, customConfig: { extra: deep } })],
      ['an earlier run of the case', 4, (deep) => ({ ...base, caseHistory: [{ tools: [deep] }] })],
    ];
    for (const [where, around, context] of PLACES) {
      const at = context(objects(MAX_EVALUATED_DEPTH - around));
      expect(nestingDepth(at, Infinity), where).toBe(MAX_EVALUATED_DEPTH);
      await expect(engine.evaluateAll(at as never), where).resolves.toHaveProperty('rule_results');
      const past = context(objects(MAX_EVALUATED_DEPTH - around + 1));
      expect(nestingDepth(past, Infinity), where).toBe(MAX_EVALUATED_DEPTH + 1);
      await expect(engine.evaluateAll(past as never), where).rejects.toBeInstanceOf(InputTooDeepError);
    }
  });

  it('the engine refuses before the first rule is asked: no rule is handed any part of such an input', async () => {
    const engine = new EvalEngine();
    const asked = Object.values(rulesByType)
      .flat()
      .map((rule) => vi.spyOn(rule, 'evaluate'));
    const calls = (): number => asked.reduce((total, spy) => total + spy.mock.calls.length, 0);
    try {
      // The probe can see a rule being asked: an ordinary run asks more than twenty.
      await engine.evaluateAll({ output: 'The file was read.', toolCalls: [{ tool_name: 'read_file', input: { path: 'src/a.ts' } }] });
      expect(calls()).toBeGreaterThan(20);
      for (const spy of asked) spy.mockClear();
      await expect(engine.evaluateAll({ output: 'The file was read.', toolCalls: [{ tool_name: 'read_file', input: objects(MAX_EVALUATED_DEPTH - 2) }] })).rejects.toBeInstanceOf(InputTooDeepError);
      await expect(engine.evaluate('safety', { output: 'The file was read.', metadata: { extra: objects(MAX_EVALUATED_DEPTH) } })).rejects.toBeInstanceOf(InputTooDeepError);
      expect(calls()).toBe(0);
    } finally {
      for (const spy of asked) spy.mockRestore();
    }
  });

  it('the engine\'s refusal names its own limit, which no setting moves, and sends its reader to no setting', () => {
    const refusal = new InputTooDeepError(MAX_EVALUATED_DEPTH);
    expect(refusal.message).toContain(`nests more than ${MAX_EVALUATED_DEPTH} levels deep, the deepest an evaluation reads`);
    expect(refusal.message).toContain('so no rule read it');
    expect(refusal.message).toContain('No setting raises this limit');
    expect(refusal.message).not.toMatch(/maxInputDepth|IRIS_MAX_INPUT_DEPTH/);
    const answered = toIrisError(refusal).envelope;
    expect(answered.code).toBe('IRIS_INVALID_ARGUMENT');
    expect(answered.recovery.join(' ')).toContain('Send the nested value flatter, or as text; a trace stored with a value this deep can be logged again without it.');
    expect(answered.recovery.join(' ')).not.toMatch(/maxInputDepth|IRIS_MAX_INPUT_DEPTH|raise/);
  });

  it('a trace stored before the limit existed is not half-judged when it is read back: the call is answered with the limit named', async () => {
    const { client, storage } = await mcp(withDepth(DEFAULT_MAX_INPUT_DEPTH));
    // Written to the store as an earlier version would have left it: six identical calls, each input nested three thousand levels deep.
    const calls = Array.from({ length: 6 }, () => ({ tool_name: 'apply_patch', input: objects(3_000) }));
    const now = new Date().toISOString();
    await storage.insertTrace(LOCAL_TENANT, { trace_id: 'f'.repeat(32), agent_name: 'old', output: 'The patch was applied and the tests pass.', tool_calls: calls, timestamp: now, created_at: now });
    const result = (await client.callTool({ name: 'evaluate_output', arguments: { trace_id: 'f'.repeat(32) } })) as ToolResult;
    expect(result.isError).toBe(true);
    const body = JSON.parse(textOf(result)) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('IRIS_INVALID_ARGUMENT');
    expect(body.error.message).toContain(`nests more than ${MAX_EVALUATED_DEPTH} levels deep`);
    // The session still serves, and a trace of ordinary depth is read back and judged.
    await storage.insertTrace(LOCAL_TENANT, { trace_id: 'e'.repeat(32), agent_name: 'old', output: 'The file was read.', tool_calls: [{ tool_name: 'read_file', input: { path: 'src/a.ts' } }], timestamp: now, created_at: now });
    const after = (await client.callTool({ name: 'evaluate_output', arguments: { trace_id: 'e'.repeat(32) } })) as ToolResult;
    expect(after.isError ?? false).toBe(false);
  });

  it('a run that holds such a trace is scored again without it: the trace is named among those that could not be scored, and the rest are judged', async () => {
    const { client, storage } = await mcp(withDepth(DEFAULT_MAX_INPUT_DEPTH));
    const now = new Date().toISOString();
    await storage.insertTrace(LOCAL_TENANT, { trace_id: 'd'.repeat(32), agent_name: 'old', output: 'The patch was applied.', tool_calls: [{ tool_name: 'apply_patch', input: objects(3_000) }], run_id: 'before-the-limit', case_key: 'deep', timestamp: now, created_at: now });
    await storage.insertTrace(LOCAL_TENANT, { trace_id: 'c'.repeat(32), agent_name: 'old', output: 'The file was read.', tool_calls: [{ tool_name: 'read_file', input: { path: 'src/a.ts' } }], run_id: 'before-the-limit', case_key: 'plain', timestamp: now, created_at: now });
    const result = (await client.callTool({ name: 'evaluate_runs', arguments: { run: 'before-the-limit' } })) as ToolResult;
    expect(result.isError ?? false, textOf(result).slice(0, 300)).toBe(false);
    const body = JSON.parse(textOf(result)) as { traces: number; evaluated: number; failed: Array<{ trace_id: string; reason: string }> };
    expect(body.traces).toBe(2);
    expect(body.evaluated).toBe(1);
    expect(body.failed).toEqual([{ trace_id: 'd'.repeat(32), reason: `the trace nests more than ${MAX_EVALUATED_DEPTH} levels deep, so no rule read it` }]);
  });

  it('the dashboard answers 422, with the limit named, when it is asked to score such a trace again', async () => {
    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const server: Server = createDashboardServer(storage, withDepth(DEFAULT_MAX_INPUT_DEPTH), quiet, { evalEngine: new EvalEngine() }).start();
    await new Promise((done) => server.once('listening', done));
    cleanup.push(async () => {
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
      await storage.close();
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const now = new Date().toISOString();
    // A trace and its verdict as an earlier version left them, and beside them an ordinary pair.
    await storage.insertTrace(LOCAL_TENANT, { trace_id: 'b'.repeat(32), agent_name: 'old', output: 'The patch was applied.', tool_calls: [{ tool_name: 'apply_patch', input: objects(3_000) }], timestamp: now, created_at: now });
    await storage.insertEvalResult(LOCAL_TENANT, { id: 'before-the-limit', trace_id: 'b'.repeat(32), eval_type: 'all', output_text: 'The patch was applied.', score: 1, passed: true, rule_results: [] });
    await storage.insertTrace(LOCAL_TENANT, { trace_id: 'a'.repeat(32), agent_name: 'old', output: 'The file was read.', tool_calls: [{ tool_name: 'read_file', input: { path: 'src/a.ts' } }], timestamp: now, created_at: now });
    await storage.insertEvalResult(LOCAL_TENANT, { id: 'ordinary', trace_id: 'a'.repeat(32), eval_type: 'all', output_text: 'The file was read.', score: 1, passed: true, rule_results: [] });
    const refused = await fetch(`${base}/api/v1/evaluations/before-the-limit/reevaluate`, { method: 'POST' });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toContain(`nests more than ${MAX_EVALUATED_DEPTH} levels deep`);
    expect((await fetch(`${base}/api/v1/evaluations/ordinary/reevaluate`, { method: 'POST' })).status).toBe(201);
  });

  it('the refusal carries the limit and a status a web server can answer with', () => {
    const refusal = new InputTooDeepError(MAX_EVALUATED_DEPTH);
    expect(refusal.name).toBe('InputTooDeepError');
    expect(refusal.limit).toBe(512);
    expect(refusal.status).toBe(422);
  });
});

describe('at the limit, every rule still answers', () => {
  it('an input, an output and an expected input nested as deep as the default lets in are judged by every rule asked', async () => {
    const { client } = await mcp(withDepth(DEFAULT_MAX_INPUT_DEPTH));
    const D = DEFAULT_MAX_INPUT_DEPTH;
    const REQUESTS: Array<[what: string, args: Record<string, unknown>]> = [
      ['an input, objects', { output: 'The file was read and the report written.', tool_calls: [{ tool_name: 't', input: objects(D - 3) }, { tool_name: 't', input: objects(D - 3) }] }],
      ['an input, arrays', { output: 'The file was read and the report written.', tool_calls: [{ tool_name: 't', input: arrays(D - 3) }, { tool_name: 't', input: arrays(D - 3) }] }],
      ['an output, objects', { output: 'The file was read and the report written.', tool_calls: [{ tool_name: 'read_file', input: { path: 'src/a.ts' }, output: objects(D - 3) }] }],
      ['an output, arrays', { output: 'The file was read and the report written.', tool_calls: [{ tool_name: 'read_file', input: { path: 'src/a.ts' }, output: arrays(D - 3) }] }],
      ['an expected input and the call\'s, objects', { output: 'Done.', tool_calls: [{ tool_name: 't', input: objects(D - 4) }], expected_trajectory: { tool_calls: [{ tool_name: 't', input: objects(D - 4) }] } }],
      ['an expected input and the call\'s, exact', { output: 'Done.', tool_calls: [{ tool_name: 't', input: arrays(D - 4) }], expected_trajectory: { tool_calls: [{ tool_name: 't', input: arrays(D - 4) }], args: 'exact' } }],
    ];
    for (const [what, args] of REQUESTS) {
      expect(nestingDepth(args, Infinity), what).toBe(D);
      const result = (await client.callTool({ name: 'evaluate_output', arguments: args })) as ToolResult;
      expect(result.isError ?? false, what).toBe(false);
      const body = JSON.parse(textOf(result)) as { rule_results: Array<{ ruleName: string; threw?: boolean }> };
      // Every rule of every bundle was asked, and none of them gave no answer.
      expect(body.rule_results.length, what).toBeGreaterThan(20);
      expect(body.rule_results.filter((r) => r.threw === true).map((r) => r.ruleName), what).toEqual([]);
    }
  });
});
