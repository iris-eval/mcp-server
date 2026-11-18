/*
 * Every failure a tool can produce is a code from ONE catalogue — and the
 * catalogue is exactly the set of codes that can be provoked.
 *
 * Three locks: a source scan (no bare `throw new Error(` under src/tools —
 * a thrown Error reaches the client as one flattened line), a provocation
 * of every catalogue code over a real transport with the envelope parsed
 * out of the content, and the assertion that the provoked set EQUALS the
 * catalogue, so a code nothing raises cannot linger and a new throw site
 * cannot ship without one.
 *
 * Every code is provoked through a client that has listed the tools first,
 * as a client does. A client built on the MCP SDK then holds each tool's
 * output schema and checks the structured content of every later result
 * against it, an error result's too: while the envelope went out as
 * structured content, such a client threw the result away and never saw
 * the code. So an error result carries none, and the last block holds the
 * SDK to the behaviour that rests on.
 */
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../../src/server.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { createCustomRuleStore } from '../../../src/custom-rule-store.js';
import { registerEvaluateOutputTool } from '../../../src/tools/evaluate-output.js';
import { ERROR_CODE_CATALOGUE, irisError, toIrisError } from '../../../src/tools/errors.js';
import { errorEnvelopeSchema, guarded } from '../../../src/tools/respond.js';
import { toolGuide } from '../../../src/tools/guide.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import { LLMJudgeError } from '../../../src/eval/llm-judge/client.js';
import { __setDnsLookupForTests, __clearCitationCacheForTests } from '../../../src/eval/citation-verify/resolve.js';
import type { EvalEngine } from '../../../src/eval/engine.js';
import type { IStorageAdapter } from '../../../src/types/query.js';

const root = resolve(__dirname, '..', '..', '..');

type Result = { content?: unknown; isError?: boolean; structuredContent?: unknown };
const text = (r: Result) => (r.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')!.text!;
function envelope(r: Result) {
  expect(r.isError).toBe(true);
  // The envelope is the text. As structured content it would be checked against the tool's output schema, which describes the tool's answer.
  expect(r.structuredContent).toBeUndefined();
  const parsed = errorEnvelopeSchema.safeParse(JSON.parse(text(r)));
  expect(parsed.success, text(r)).toBe(true);
  return parsed.success ? parsed.data.error : (undefined as never);
}
/** What a promise can reject with that has no message: nothing at all, an object that cannot be made a string (no prototype; a toString that answers no string), an error whose message is not text. */
const NOTHING_TO_SAY: readonly unknown[] = [null, undefined, Object.create(null), { toString: () => ({}) }, Object.assign(new Error('replaced below'), { message: 5 })];

describe('no tool throws a bare Error past its handler', () => {
  it('src/tools has zero `throw new Error(`', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(join(root, 'src', 'tools')).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(root, 'src', 'tools', f), 'utf8');
      // respond.ts and describe.ts throw on programming errors (a response its
      // own schema rejects; an undescribed output field; an overlong
      // description) — registration-time guards, never a handler path.
      if (f === 'respond.ts' || f === 'describe.ts') continue;
      for (const m of src.matchAll(/throw new Error\(/g)) offenders.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('the API reference lists the codes an envelope carries', () => {
  it('every code of the catalogue stands in its list, and no other', () => {
    const paragraph = readFileSync(join(root, 'docs', 'api-reference.md'), 'utf8')
      .split(/\r?\n/)
      .find((line) => line.startsWith('- **Structured errors.**'));
    expect(paragraph).toBeDefined();
    const list = paragraph!.slice(paragraph!.indexOf('Codes:'), paragraph!.indexOf('An argument the input schema rejects'));
    expect([...list.matchAll(/`(IRIS_[A-Z_]+)`/g)].map((m) => m[1]).sort()).toEqual([...ERROR_CODE_CATALOGUE].sort());
  });
});

describe('every catalogue code can be provoked, and nothing else can', () => {
  let client: Client;
  let storage: SqliteAdapter;
  let ruleDir: string;
  const provoked = new Set<string>();
  const savedKey = process.env.IRIS_ANTHROPIC_API_KEY;
  const savedFetch = global.fetch;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    ruleDir = mkdtempSync(join(tmpdir(), 'iris-error-codes-'));
    const ruleStore = createCustomRuleStore({ pathFor: () => join(ruleDir, 'custom-rules.json'), auditPath: join(ruleDir, 'audit.log') });
    const { mcpServer } = createIrisServer(defaultConfig, storage, ruleStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: 'codes', version: '0.1.0' });
    await client.connect(clientTransport);
    // As a client does before it calls anything: from here on the SDK checks every result against the tool's output schema.
    expect((await client.listTools()).tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);
    delete process.env.IRIS_ANTHROPIC_API_KEY;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await client.close();
    await storage.close();
    rmSync(ruleDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (savedKey === undefined) delete process.env.IRIS_ANTHROPIC_API_KEY;
    else process.env.IRIS_ANTHROPIC_API_KEY = savedKey;
    global.fetch = savedFetch;
    __setDnsLookupForTests(null);
    __clearCitationCacheForTests();
  });

  it('IRIS_INVALID_ARGUMENT — the protocol layer refuses an unknown argument and names the code in its text', async () => {
    const r = (await client.callTool({ name: 'evaluate_output', arguments: { output: 'x', bogus: 1 } })) as Result;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('IRIS_INVALID_ARGUMENT');
    expect(text(r)).toContain('"bogus"');
    provoked.add('IRIS_INVALID_ARGUMENT');
  });

  it('IRIS_INVALID_ARGUMENT — the same code as an envelope, when the tool itself refuses an argument its schema let in', async () => {
    const e = envelope((await client.callTool({ name: 'log_trace', arguments: { agent_name: 'codes', input: 'x', evaluate: true } })) as Result);
    expect(e.code).toBe('IRIS_INVALID_ARGUMENT');
    expect(e.field).toBe('output');
    expect(e.recovery.length).toBeGreaterThan(0);
    // Refused before anything was stored: this test's store began empty.
    expect((await storage.queryTraces(LOCAL_TENANT, {})).total).toBe(0);
  });

  it('what the input schema refuses is plain text: an unknown argument names the code and the valid arguments; a wrong type, a missing argument and a refused value say why and carry no code', async () => {
    for (const name of ['get_traces', 'list_rules']) {
      const r = (await client.callTool({ name, arguments: { bogus: 1 } })) as Result;
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('IRIS_INVALID_ARGUMENT');
      expect(text(r)).toContain('"bogus"');
      expect(text(r)).toContain('Valid arguments');
    }
    const refusals: Array<[string, Record<string, unknown>, string]> = [
      ['evaluate_output', { output: { not: 'the type' } }, 'output'],
      ['log_trace', { input: 'x' }, 'agent_name'],
      ['compare_runs', { before: '', after: 'run-b' }, 'before'],
    ];
    for (const [name, args, argument] of refusals) {
      const r = (await client.callTool({ name, arguments: args })) as Result;
      expect(r.isError).toBe(true);
      // The argument as the refusal names its place: every refusal of a tool begins with the tool's name, which can hold the argument's.
      expect(text(r)).toContain(` at ${argument}`);
      expect(text(r)).not.toContain('IRIS_');
      // Plain text: nothing here parses as an envelope.
      expect(() => JSON.parse(text(r)) as unknown).toThrow();
    }
  });

  it("compare_runs, evaluate_runs and log_trace: what each description names under Errors is what its tool answers, and what the input schema refuses is plain text", async () => {
    const listed = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool.description ?? '']));
    const errorsOf = (tool: string): string => listed.get(tool)!.split('Errors.')[1] ?? '';
    const namedBy = (tool: string): string[] => [...new Set(errorsOf(tool).match(/IRIS_[A-Z_]+/g) ?? [])].sort();
    // Each refusal a description calls the tool's own, and the envelope it comes back as.
    const own: Array<[string, Record<string, unknown>, string]> = [
      ['compare_runs', { after: 'run-b' }, 'IRIS_INVALID_ARGUMENT'],
      ['compare_runs', { before: 'run-a', after: 'run-b', dataset: 'no-such-dataset' }, 'IRIS_INVALID_ARGUMENT'],
      ['evaluate_runs', { run: 'run-s', into: 'run-s' }, 'IRIS_INVALID_ARGUMENT'],
      ['evaluate_runs', { run: 'no-such-run' }, 'IRIS_UNKNOWN_TRACE'],
      ['log_trace', { agent_name: 'codes', evaluate: true }, 'IRIS_INVALID_ARGUMENT'],
    ];
    const answered = new Map<string, Set<string>>();
    for (const [tool, args, code] of own) {
      const e = envelope((await client.callTool({ name: tool, arguments: args })) as Result);
      expect(e.code, `${tool} ${JSON.stringify(args)}`).toBe(code);
      answered.set(tool, new Set([...(answered.get(tool) ?? []), e.code]));
    }
    // The codes each description names: the ones its tool answered above, and the store's, which every tool that reads or writes the store can answer (provoked through evaluate_output below).
    for (const tool of ['compare_runs', 'evaluate_runs', 'log_trace']) {
      expect(namedBy(tool), tool).toEqual([...(answered.get(tool) ?? []), 'IRIS_STORAGE_ERROR'].sort());
    }
    // Each refusal the input schema makes: plain text that names no code and parses as no envelope.
    const schemas: Array<[string, Record<string, unknown>, string]> = [
      ['compare_runs', { before: '', after: 'run-b' }, 'before'],
      ['compare_runs', { before: 'run-a', after: '' }, 'after'],
      ['compare_runs', { before: 'run-a', after: 'run-b', equivalence_margin: 0 }, 'equivalence_margin'],
      ['compare_runs', { before: 'run-a', after: 'run-b', equivalence_margin: 2 }, 'equivalence_margin'],
      ['evaluate_runs', { run: '' }, 'run'],
      ['evaluate_runs', { run: 'run-s', into: '' }, 'into'],
      ['log_trace', { agent_name: 'codes', spans: [{ span_id: 's1', start_time: '2026-11-18T00:00:00.000Z' }] }, 'spans[0].name'],
      ['log_trace', { agent_name: 'codes', tool_calls: [{ input: {} }] }, 'tool_calls[0].tool_name'],
    ];
    for (const [tool, args, place] of schemas) {
      const r = (await client.callTool({ name: tool, arguments: args })) as Result;
      expect(r.isError, `${tool} ${place}`).toBe(true);
      expect(text(r), `${tool} ${place}`).toContain(` at ${place}`);
      expect(text(r), `${tool} ${place}`).not.toContain('IRIS_');
      expect(() => JSON.parse(text(r)) as unknown, `${tool} ${place}`).toThrow();
    }
    // What each description and each line of the long form says of these refusals, word for word: the cases above are what it says.
    expect(errorsOf('compare_runs')).toContain('IRIS_INVALID_ARGUMENT (no baseline pinned, or no such dataset); IRIS_STORAGE_ERROR.');
    expect(errorsOf('evaluate_runs')).toContain('IRIS_INVALID_ARGUMENT (into names the run being re-evaluated); IRIS_UNKNOWN_TRACE (source run empty); IRIS_STORAGE_ERROR.');
    const guide = toolGuide();
    expect(guide.compare_runs.errors).toContain('IRIS_INVALID_ARGUMENT when no baseline is pinned for an omitted before, or dataset names none. An empty run id, or an equivalence_margin outside (0, 1], is refused by the input schema in plain text.');
    expect(guide.evaluate_runs.errors).toContain('IRIS_INVALID_ARGUMENT when into names the run being re-evaluated. An empty run id is refused by the input schema in plain text. IRIS_UNKNOWN_TRACE when the source run has no traces.');
    expect(guide.log_trace.errors).toContain('An unknown argument is refused before the handler runs, naming the valid keys; a malformed span or tool_calls entry is refused saying what is wrong.');
    // What log_trace's description says of the rest, as its tool does it: an unknown argument names the valid ones, a malformed one says why.
    expect(errorsOf('log_trace')).toContain('Unknown arguments are refused naming the valid keys; malformed ones, saying why.');
    const unknown = text((await client.callTool({ name: 'log_trace', arguments: { agent_name: 'codes', bogus: 1 } })) as Result);
    expect(unknown).toContain('Valid arguments');
    expect(text((await client.callTool({ name: 'log_trace', arguments: { agent_name: 5 } })) as Result)).not.toContain('Valid arguments');
  });

  it('the server instructions say of a refused argument what holds of every refusal', () => {
    const said = client.getInstructions() ?? '';
    expect(said).toContain('An argument the schema rejects comes back as plain text saying why; an unknown one also lists the valid arguments.');
    expect(said).not.toContain('plain text naming IRIS_INVALID_ARGUMENT');
  });

  it('the API reference says, word for word, what the cases above show: the input schema in plain text, the code a tool refuses with, and what timeout_ms bounds', () => {
    const reference = readFileSync(join(root, 'docs', 'api-reference.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(reference).toContain('Codes: `IRIS_INVALID_ARGUMENT` (an argument the tool itself refuses, once the input schema has let it in),');
    expect(reference).toContain(
      'An argument the input schema rejects never reaches the handler: the protocol layer answers with plain text and no envelope. For an unknown argument the text names it, the valid arguments and `IRIS_INVALID_ARGUMENT`; for a wrong type, a required argument left out or a value a check refuses, it names the argument and what was expected, and carries no code.',
    );
    expect(reference).toContain('`timeout_ms` on `evaluate_with_llm_judge` (default 60,000) bounds the wait for each reply to begin;');
  });

  it('IRIS_UNKNOWN_TRACE — nothing scored or written', async () => {
    const e = envelope((await client.callTool({ name: 'evaluate_output', arguments: { output: 'x', trace_id: 'f'.repeat(32) } })) as Result);
    expect(e.code).toBe('IRIS_UNKNOWN_TRACE');
    expect(e.field).toBe('trace_id');
    expect(e.message).toContain('does not match any stored trace');
    expect(e.recovery.length).toBeGreaterThan(0);
    provoked.add(e.code);
  });

  it('IRIS_DUPLICATE_RULE — the second deploy of a name, with the recovery naming replace', async () => {
    const args = { name: 'dup', eval_type: 'completeness', definition: { type: 'min_length', config: { min_length: 3 } } };
    expect(((await client.callTool({ name: 'deploy_rule', arguments: args })) as Result).isError).toBeFalsy();
    const e = envelope((await client.callTool({ name: 'deploy_rule', arguments: args })) as Result);
    expect(e.code).toBe('IRIS_DUPLICATE_RULE');
    expect(e.recovery.join(' ')).toMatch(/replace: true/);
    provoked.add(e.code);
  });

  it('IRIS_INVALID_RULE_CONFIG — a regex the sandbox refuses, naming the field, nothing deployed', async () => {
    const e = envelope(
      (await client.callTool({
        name: 'deploy_rule',
        arguments: { name: 'bad', eval_type: 'safety', definition: { type: 'regex_match', config: { pattern: '(a+)+$' } } },
      })) as Result,
    );
    expect(e.code).toBe('IRIS_INVALID_RULE_CONFIG');
    expect(e.message).toMatch(/pattern|regex/i);
    const listed = JSON.parse(text((await client.callTool({ name: 'list_rules', arguments: {} })) as Result)) as { total: number };
    expect(listed.total).toBe(0);
    provoked.add(e.code);
  });

  it('IRIS_JUDGE_NOT_ENABLED — no key reached this process; recovery is the enable workflow', async () => {
    const e = envelope((await client.callTool({ name: 'evaluate_with_llm_judge', arguments: { output: 'x', template: 'accuracy', model: 'claude-haiku-4-5' } })) as Result);
    expect(e.code).toBe('IRIS_JUDGE_NOT_ENABLED');
    expect(e.field).toBe('IRIS_ANTHROPIC_API_KEY');
    expect(e.recovery.some((s) => s.includes('IRIS_ANTHROPIC_API_KEY'))).toBe(true);
    expect(e.recovery.some((s) => /restart/i.test(s))).toBe(true);
    expect(e.see).toBe('iris://capabilities');
    provoked.add(e.code);
  });

  it('IRIS_JUDGE_UNKNOWN_MODEL — with the valid list', async () => {
    const e = envelope((await client.callTool({ name: 'verify_citations', arguments: { output: 'x [1]', model: 'gpt-99' } })) as Result);
    expect(e.code).toBe('IRIS_JUDGE_UNKNOWN_MODEL');
    expect(e.field).toBe('model');
    expect(e.valid).toContain('claude-haiku-4-5');
    provoked.add(e.code);
  });

  it('IRIS_BUDGET_EXCEEDED — refused before any spend, both numbers in the message', async () => {
    process.env.IRIS_ANTHROPIC_API_KEY = 'test-key';
    const fetchSpy = vi.fn(async () => { throw new Error('provider must not be called'); });
    global.fetch = fetchSpy as unknown as typeof fetch;
    const e = envelope(
      (await client.callTool({
        name: 'evaluate_with_llm_judge',
        arguments: { output: 'x'.repeat(2000), template: 'accuracy', model: 'claude-opus-4-7', max_cost_usd: 0.000001 },
      })) as Result,
    );
    expect(e.code).toBe('IRIS_BUDGET_EXCEEDED');
    expect(e.message).toMatch(/exceeds cap/);
    expect(fetchSpy).not.toHaveBeenCalled();
    provoked.add(e.code);
  });

  it('IRIS_PROVIDER_ERROR — the provider refuses the key; kind auth, not retryable', async () => {
    process.env.IRIS_ANTHROPIC_API_KEY = 'test-key';
    global.fetch = vi.fn(async () => new Response('{"error":"bad key"}', { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const e = envelope((await client.callTool({ name: 'evaluate_with_llm_judge', arguments: { output: 'x', template: 'accuracy', model: 'claude-haiku-4-5' } })) as Result);
    expect(e.code).toBe('IRIS_PROVIDER_ERROR');
    expect(e.kind).toBe('auth');
    expect(e.retryable).toBe(false);
    provoked.add(e.code);
  });

  it('IRIS_PROVIDER_ERROR — a rate limit keeps its code whatever the provider says to wait: the delay is told when it is a number, and left out when its milliseconds are not', async () => {
    process.env.IRIS_ANTHROPIC_API_KEY = 'test-key';
    const cases: Array<[string, number | undefined]> = [
      ['0.01', 10],
      // A thousand times this many seconds is not a number, and JSON has no way to write one.
      ['1e306', undefined],
    ];
    for (const [retryAfter, told] of cases) {
      const provider = vi.fn(async () => new Response('{"error":"slow down"}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': retryAfter } }));
      global.fetch = provider as unknown as typeof fetch;
      const e = envelope((await client.callTool({ name: 'evaluate_with_llm_judge', arguments: { output: 'x', template: 'accuracy', model: 'claude-haiku-4-5' } })) as Result);
      expect(e.code).toBe('IRIS_PROVIDER_ERROR');
      expect(e.kind).toBe('rate_limit');
      expect(e.retryable).toBe(true);
      expect(e.retryAfterMs).toBe(told);
      expect(e.recovery.length).toBeGreaterThan(0);
    }
  });

  it('IRIS_JUDGE_FAILED — citations resolved but the judge failed on every one; nothing stored', async () => {
    process.env.IRIS_ANTHROPIC_API_KEY = 'test-key';
    // The operator turns fetching on; an argument cannot (src/tools/operator-ceilings.ts).
    vi.stubEnv('IRIS_CITATION_ALLOW_FETCH', '1');
    __setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      // Route by hostname, not by substring: the provider host gets the
      // failing judge, the cited source gets a page (CodeQL js/incomplete-url-substring-sanitization).
      const { hostname } = new URL(input instanceof Request ? input.url : String(input));
      if (hostname === 'api.anthropic.com' || hostname.endsWith('.anthropic.com')) return new Response('{"error":"down"}', { status: 500 });
      return new Response('<html><body>A source about the claim.</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    const e = envelope(
      (await client.callTool({
        name: 'verify_citations',
        arguments: { output: 'The claim is supported by https://example.org/paper.', model: 'claude-haiku-4-5' },
      })) as Result,
    );
    expect(e.code).toBe('IRIS_JUDGE_FAILED');
    expect((await storage.queryEvalResults(defaultConfig as never, {}).catch(() => ({ total: 0 }))).total ?? 0).toBe(0);
    provoked.add(e.code);
  });

  it('IRIS_STORAGE_ERROR — the database refuses the write', async () => {
    const failing = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === 'insertEvalResult') {
          return async () => {
            const err = new Error('database is locked') as Error & { code?: string };
            err.code = 'SQLITE_BUSY';
            throw err;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as IStorageAdapter;
    const e = envelope(await callIsolated(failing, undefined, { output: 'x' }));
    expect(e.code).toBe('IRIS_STORAGE_ERROR');
    expect(e.retryable).toBe(true);
    provoked.add(e.code);
  });

  it("IRIS_STORAGE_ERROR — the built-in SQLite's failures are the store's, and a database another connection holds is one to retry", async () => {
    // Node's own SQLite names every failure ERR_SQLITE_ERROR, with SQLite's number beside it: real failures, not their shape copied.
    const { DatabaseSync } = await import('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'iris-node-sqlite-'));
    const path = join(dir, 'held.db');
    const a = new DatabaseSync(path);
    const b = new DatabaseSync(path, { timeout: 0 });
    const caught = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (err) {
        return err;
      }
      throw new Error('it did not fail');
    };
    try {
      a.exec('CREATE TABLE t (x INTEGER)');
      const missing = caught(() => a.prepare('SELECT * FROM missing').all());
      a.exec('BEGIN EXCLUSIVE');
      const locked = caught(() => b.exec('INSERT INTO t VALUES (1)'));
      a.exec('ROLLBACK');
      expect(toIrisError(missing).envelope).toMatchObject({ code: 'IRIS_STORAGE_ERROR', retryable: false, message: 'Iris storage failed: no such table: missing' });
      expect(toIrisError(locked).envelope).toMatchObject({ code: 'IRIS_STORAGE_ERROR', retryable: true, message: 'Iris storage failed: database is locked' });
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it('IRIS_INTERNAL_ERROR — anything unrecognised is reported as such, never dressed up as a caller mistake', async () => {
    const broken = { evaluateAll: () => { throw new Error('engine exploded'); }, evaluate: () => { throw new Error('engine exploded'); }, relevanceJudgeInForce: () => null } as unknown as EvalEngine;
    const e = envelope(await callIsolated(storage, broken, { output: 'x' }));
    expect(e.code).toBe('IRIS_INTERNAL_ERROR');
    expect(e.message).toContain('engine exploded');
    provoked.add(e.code);
  });

  it('IRIS_INTERNAL_ERROR — a store that rejects a write with nothing at all is answered with the internal error and its own sentence', async () => {
    for (const nothing of [null, undefined]) {
      const failing = new Proxy(storage, {
        get(target, prop, receiver) {
          if (prop === 'insertEvalResult') {
            return async () => {
              throw nothing;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as IStorageAdapter;
      const e = envelope(await callIsolated(failing, undefined, { output: 'x' }));
      expect(e.code).toBe('IRIS_INTERNAL_ERROR');
      expect(e.message).toBe('Iris hit an unexpected error.');
    }
  });

  /** The store as it is, but for a write of an evaluation that rejects with the value given. */
  const rejectingTheWrite = (value: unknown): IStorageAdapter =>
    new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === 'insertEvalResult') {
          return async () => {
            throw value;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as IStorageAdapter;

  it("IRIS_UNKNOWN_TRACE — a linked write the store refuses for its trace is told as an unknown trace, for every value that says so: its words read as text, an error's message whatever it holds", async () => {
    const traceId = 'a'.repeat(32);
    await storage.insertTraces(LOCAL_TENANT, [{ trace_id: traceId, agent_name: 'codes', input: 'q', output: 'x', timestamp: '2026-11-18T00:00:00.000Z' }]);
    const said = 'FOREIGN KEY constraint failed';
    const ofAnotherRealm: unknown = runInNewContext(`new Error(${JSON.stringify(said)})`);
    const values: Array<[string, unknown]> = [
      ['an error', new Error(said)],
      ['a string', said],
      ['an object that says it', { toString: () => said }],
      ['a list that holds it', [said]],
      ['a boxed string', new String(said)],
      ['a symbol', Symbol(said)],
      ['an error of another realm', ofAnotherRealm],
      ['an error whose message is an object that says it', Object.assign(new Error('replaced below'), { message: { toString: () => said } })],
      ['an error whose message is a symbol that says it', Object.assign(new Error('replaced below'), { message: Symbol(said) })],
      ['an object with no prototype that carries the code', Object.assign(Object.create(null) as object, { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })],
      [
        'an error that says it, whose code cannot be read',
        Object.defineProperty(new Error(said), 'code', {
          get() {
            throw new Error('the code cannot be read');
          },
        }),
      ],
    ];
    for (const [what, value] of values) {
      const e = envelope(await callIsolated(rejectingTheWrite(value), undefined, { output: 'x', trace_id: traceId }));
      expect(e.code, what).toBe('IRIS_UNKNOWN_TRACE');
    }
  });

  it('IRIS_UNKNOWN_TRACE — a trace deleted between the check and the write is told as an unknown trace, under each SQLite the store runs on', async () => {
    for (const driver of ['native', 'node'] as const) {
      const real = new SqliteAdapter(':memory:', { driver });
      await real.initialize();
      try {
        const traceId = 'c'.repeat(32);
        await real.insertTraces(LOCAL_TENANT, [{ trace_id: traceId, agent_name: 'codes', input: 'q', output: 'x', timestamp: '2026-11-18T00:00:00.000Z' }]);
        // The race: the trace is gone by the time the evaluation is written, and the driver's own foreign key refuses the write.
        const racing = new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === 'insertEvalResult') {
              return async (...args: Parameters<IStorageAdapter['insertEvalResult']>) => {
                await target.deleteTrace(LOCAL_TENANT, traceId);
                return target.insertEvalResult(...args);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as unknown as IStorageAdapter;
        const e = envelope(await callIsolated(racing, undefined, { output: 'x', trace_id: traceId }));
        expect(e.code, driver).toBe('IRIS_UNKNOWN_TRACE');
      } finally {
        await real.close();
      }
    }
  });

  it('IRIS_INTERNAL_ERROR — a linked write the store refuses with a value that throws when it is read is answered by the mapping, never with the value in its place', async () => {
    const traceId = 'b'.repeat(32);
    await storage.insertTraces(LOCAL_TENANT, [{ trace_id: traceId, agent_name: 'codes', input: 'q', output: 'x', timestamp: '2026-11-18T00:00:00.000Z' }]);
    const throwing = (key: 'message' | 'code'): Error =>
      Object.defineProperty(new Error('replaced below'), key, {
        get() {
          throw new Error(`the ${key} cannot be read`);
        },
      });
    const unreadable = new Proxy({}, {
      get() {
        throw new Error('nothing of it can be read');
      },
      getPrototypeOf() {
        throw new Error('nothing of it can be read');
      },
    });
    for (const [what, value] of [['an error whose message throws', throwing('message')], ['an error whose code throws', throwing('code')], ['a value every read of which throws', unreadable]] as Array<[string, unknown]>) {
      const e = envelope(await callIsolated(rejectingTheWrite(value), undefined, { output: 'x', trace_id: traceId }));
      expect(e.code, what).toBe('IRIS_INTERNAL_ERROR');
      expect(e.message, what).not.toMatch(/cannot be read|nothing of it/);
    }
  });

  it('IRIS_INTERNAL_ERROR — a handler that fails with nothing at all, or with a value that has no text, is answered with the envelope too', async () => {
    for (const thrown of NOTHING_TO_SAY) {
      const fail = (): never => {
        throw thrown;
      };
      const broken = { evaluateAll: fail, evaluate: fail, relevanceJudgeInForce: () => null } as unknown as EvalEngine;
      const e = envelope(await callIsolated(storage, broken, { output: 'x' }));
      expect(e.code).toBe('IRIS_INTERNAL_ERROR');
      expect(e.message).toBe('Iris hit an unexpected error.');
      expect(e.recovery.length).toBeGreaterThan(0);
    }
  });

  it('the provoked set equals the catalogue', () => {
    expect([...provoked].sort()).toEqual([...ERROR_CODE_CATALOGUE].sort());
  });

  async function callIsolated(store: IStorageAdapter, engine: EvalEngine | undefined, args: Record<string, unknown>): Promise<Result> {
    const { EvalEngine } = await import('../../../src/eval/engine.js');
    const server = new McpServer({ name: 'isolated', version: '0.0.0' });
    registerEvaluateOutputTool(server, store, engine ?? new EvalEngine(0.7));
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const isolated = new Client({ name: 'isolated', version: '0.1.0' });
    await isolated.connect(c);
    await isolated.listTools();
    try {
      return (await isolated.callTool({ name: 'evaluate_output', arguments: args })) as Result;
    } finally {
      await isolated.close();
    }
  }
});

describe('what an error result may carry, for a client that has listed the tools', () => {
  /** A server with one tool whose answer has a required field, as every Iris tool's has, and which fails with the result given. */
  async function failingWith(result: { content: Array<{ type: 'text'; text: string }>; isError: true; structuredContent?: Record<string, unknown> }): Promise<{ call: () => Promise<Result>; close: () => Promise<void> }> {
    const server = new McpServer({ name: 'one-tool', version: '0.0.0' });
    server.registerTool('answer', { description: 'Answers.', inputSchema: {}, outputSchema: { id: z.string() } }, () => result);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: 'one-tool', version: '0.1.0' });
    await client.connect(c);
    await client.listTools();
    return { call: async () => (await client.callTool({ name: 'answer', arguments: {} })) as Result, close: () => client.close() };
  }
  const body = { error: toIrisError(new Error('boom')).envelope };
  const asText = { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: true as const };

  it('the envelope as text reaches it', async () => {
    const { call, close } = await failingWith(asText);
    try {
      expect(envelope(await call()).code).toBe('IRIS_INTERNAL_ERROR');
    } finally {
      await close();
    }
  });

  it('the same envelope sent as structured content as well is thrown away by the SDK: the reason an error result carries none', async () => {
    const { call, close } = await failingWith({ ...asText, structuredContent: body });
    try {
      await expect(call()).rejects.toThrow(/Structured content does not match the tool's output schema/);
    } finally {
      await close();
    }
  });
});

describe('toIrisError maps what the runtime throws', () => {
  it('a provider rate limit is retryable with retryAfterMs', () => {
    const e = toIrisError(new LLMJudgeError('slow down', 'rate_limit', 429, 7));
    expect(e.envelope).toMatchObject({ code: 'IRIS_PROVIDER_ERROR', kind: 'rate_limit', retryable: true, retryAfterMs: 7000 });
  });
  it('a retry delay is told in milliseconds when that is a number, and left out when it is not', () => {
    expect(toIrisError(new LLMJudgeError('slow down', 'rate_limit', 429, 0.5)).envelope.retryAfterMs).toBe(500);
    for (const odd of [1e306, Number.NaN, Number.POSITIVE_INFINITY]) {
      const mapped = toIrisError(new LLMJudgeError('slow down', 'rate_limit', 429, odd)).envelope;
      expect(mapped).toMatchObject({ code: 'IRIS_PROVIDER_ERROR', kind: 'rate_limit', retryable: true });
      expect('retryAfterMs' in mapped).toBe(false);
      expect(errorEnvelopeSchema.safeParse(JSON.parse(JSON.stringify({ error: mapped }))).success).toBe(true);
    }
  });
  it('the mapping answers, and does not throw, for an error whose message throws when it is read', () => {
    const unreadable = Object.defineProperty(new Error('replaced below'), 'message', {
      get(): string {
        throw new Error('this message will not be read');
      },
    });
    const e = toIrisError(unreadable);
    expect(e.envelope.code).toBe('IRIS_INTERNAL_ERROR');
    expect(e.envelope.message).toBe('Iris hit an unexpected error.');
  });
  it('a storage failure with nothing to say has a sentence that ends', () => {
    expect(toIrisError(Object.assign(new Error(''), { code: 'SQLITE_BUSY' })).envelope).toMatchObject({ code: 'IRIS_STORAGE_ERROR', message: 'Iris storage failed.', retryable: true });
    expect(toIrisError(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })).envelope.message).toBe('Iris storage failed: database is locked');
  });
  it('a plain error is internal, with a recovery', () => {
    const e = toIrisError(new Error('boom'));
    expect(e.envelope.code).toBe('IRIS_INTERNAL_ERROR');
    expect(e.envelope.recovery.length).toBeGreaterThan(0);
  });
  it('nothing thrown at all, or a value with no text, is internal with the error\'s own sentence', () => {
    for (const thrown of NOTHING_TO_SAY) {
      const e = toIrisError(thrown);
      expect(e.envelope.code).toBe('IRIS_INTERNAL_ERROR');
      expect(e.envelope.message).toBe('Iris hit an unexpected error.');
      expect(e.envelope.recovery.length).toBeGreaterThan(0);
    }
  });
  it('a value that says something is quoted as it says it', () => {
    expect(toIrisError('the disk is full').envelope.message).toBe('the disk is full');
    expect(toIrisError({ toString: () => 'a bare object with words' }).envelope.message).toBe('a bare object with words');
  });
  it("a database another connection holds is one to retry, as SQLite numbers it (5 and 6) and as better-sqlite3 names it; any other failure of the store is not", () => {
    const nodeSqlite = (errcode: number, said: string): Error => Object.assign(new Error(said), { code: 'ERR_SQLITE_ERROR', errcode });
    expect(toIrisError(nodeSqlite(5, 'database is locked')).envelope).toMatchObject({ code: 'IRIS_STORAGE_ERROR', retryable: true });
    expect(toIrisError(nodeSqlite(6, 'database table is locked')).envelope).toMatchObject({ code: 'IRIS_STORAGE_ERROR', retryable: true });
    expect(toIrisError(nodeSqlite(1, 'no such table: eval_results')).envelope).toMatchObject({ code: 'IRIS_STORAGE_ERROR', retryable: false });
    for (const [code, retryable] of [['SQLITE_BUSY', true], ['SQLITE_LOCKED', true], ['SQLITE_CONSTRAINT', false], ['SQLITE_FULL', false]] as const) {
      expect(toIrisError(Object.assign(new Error('the store says no'), { code })).envelope, code).toMatchObject({ code: 'IRIS_STORAGE_ERROR', retryable });
    }
  });
  it("the mapping reads a value's code and its number without throwing, where reading them throws", () => {
    const throwingOn = (key: 'code' | 'errcode', base: Error): Error =>
      Object.defineProperty(base, key, {
        get() {
          throw new Error(`the ${key} cannot be read`);
        },
      });
    // A code that cannot be read: the error's own words decide, as for an error with no code.
    const locked = throwingOn('code', new Error('database is locked'));
    expect(() => toIrisError(locked)).not.toThrow();
    expect(toIrisError(locked).envelope).toMatchObject({ code: 'IRIS_STORAGE_ERROR', retryable: false, message: 'Iris storage failed: database is locked' });
    // A number that cannot be read, under the built-in SQLite's code: the store's failure, and not one to retry.
    const numberless = throwingOn('errcode', Object.assign(new Error('no such table: eval_results'), { code: 'ERR_SQLITE_ERROR' }));
    expect(() => toIrisError(numberless)).not.toThrow();
    expect(toIrisError(numberless).envelope).toMatchObject({ code: 'IRIS_STORAGE_ERROR', retryable: false });
  });
  it('the store driver\'s words make a storage error only in an error\'s own message, not in a thrown string', () => {
    expect(toIrisError(new Error('database is locked')).envelope.code).toBe('IRIS_STORAGE_ERROR');
    const e = toIrisError('database is locked');
    expect(e.envelope.code).toBe('IRIS_INTERNAL_ERROR');
    expect(e.envelope.message).toBe('database is locked');
  });
});

describe('the wrapper answers with an envelope whatever a handler fails with', () => {
  it('a value the mapping itself cannot read (reading its class throws) is the internal error, not a thrown line', async () => {
    const unreadable: unknown = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('this value will not say what it is');
        },
      },
    );
    expect(() => toIrisError(unreadable)).toThrow('this value will not say what it is');
    const handler = guarded(async () => {
      throw unreadable;
    });
    const e = envelope((await handler()) as Result);
    expect(e.code).toBe('IRIS_INTERNAL_ERROR');
    expect(e.message).toBe('Iris hit an unexpected error.');
  });

  it('a failure mapped to an envelope its own schema refuses (no step to take; a step that is empty; no words; a code outside the catalogue; a retryable that is not a boolean; a list of valid values that are not text) is the internal error too', async () => {
    const noStep = irisError('IRIS_INVALID_ARGUMENT', 'a refusal written without a step to take');
    const emptyStep = irisError('IRIS_INVALID_ARGUMENT', 'a refusal written with a step that says nothing', { recovery: ['Pass output.', ''] });
    const noWords = Object.assign(new Error(''), { name: 'DuplicateRuleNameError' });
    const offCatalogue = irisError('IRIS_NOT_A_CODE' as never, 'a refusal under a code nobody listed', { recovery: ['Pass output.'] });
    const notBoolean = irisError('IRIS_INVALID_ARGUMENT', 'a refusal whose retryable is a word', { recovery: ['Pass output.'], retryable: 'yes' as never });
    const validOfNumbers = irisError('IRIS_INVALID_ARGUMENT', 'a refusal whose valid values are numbers', { recovery: ['Pass output.'], valid: [1, 2] as never });
    for (const odd of [noStep, emptyStep, noWords, offCatalogue, notBoolean, validOfNumbers]) {
      // The mapping answers; it is the envelope's schema that refuses what it answered.
      expect(toIrisError(odd).envelope.code).not.toBe('IRIS_INTERNAL_ERROR');
      expect(errorEnvelopeSchema.safeParse({ error: toIrisError(odd).envelope }).success).toBe(false);
      const handler = guarded(async () => {
        throw odd;
      });
      const e = envelope((await handler()) as Result);
      expect(e.code).toBe('IRIS_INTERNAL_ERROR');
      expect(e.message).toBe('Iris hit an unexpected error.');
      expect(e.recovery.length).toBeGreaterThan(0);
    }
  });

  it('the envelope is judged as the JSON a caller reads: a field that becomes text only when it is written goes out as that text', async () => {
    const boxed = irisError('IRIS_INVALID_ARGUMENT', 'refused', { field: new String('output') as unknown as string, recovery: ['Pass output.'] });
    // As an object in memory the schema refuses it; as the JSON that is sent it passes.
    expect(errorEnvelopeSchema.safeParse({ error: boxed.envelope }).success).toBe(false);
    const handler = guarded(async () => {
      throw boxed;
    });
    const e = envelope((await handler()) as Result);
    expect(e.code).toBe('IRIS_INVALID_ARGUMENT');
    expect(e.field).toBe('output');
  });
});
