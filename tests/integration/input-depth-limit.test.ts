/*
 * The nesting limit (security.maxInputDepth, #1040).
 *
 * Several rules write an input out with a function that calls itself once
 * for each level, and past a few thousand levels the stack runs out: the
 * rule gives no answer and takes no part in the verdict. The bytes and the
 * elements of a request were bounded; the levels were not. So an input
 * nested deeper than the limit is refused at every door, before any rule
 * reads it.
 *
 * Held here: how the levels are counted; a tool call, a JSON body and a
 * protobuf body one level past the limit are refused with the limit named,
 * and nothing is stored; one at the limit passes; the session keeps
 * serving; an embedder's config without the key still gets the default;
 * and at the default every rule still answers an input, an output and an
 * expected input nested as deep as the door lets in.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { createIrisServer } from '../../src/server.js';
import { DEFAULT_MAX_INPUT_DEPTH, defaultConfig } from '../../src/config/defaults.js';
import { decodeExportTraceServiceRequest, OtlpTooDeepError } from '../../src/otel/protobuf.js';
import { InputTooDeepError, jsonTextDepth, MAX_EVALUATED_DEPTH, MAX_JSON_TEXT_DEPTH, nestingDepth } from '../../src/utils/element-count.js';
import { EvalEngine } from '../../src/eval/engine.js';
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

async function mcp(config: IrisConfig): Promise<{ client: Client; storage: SqliteAdapter; stored: () => Promise<number> }> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const { mcpServer } = createIrisServer(config, storage, undefined, { warn: () => {} });
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

  it('its depth is read off the text: what the value it parses to would measure, whatever its strings hold', () => {
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
