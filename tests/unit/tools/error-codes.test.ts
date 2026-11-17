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
      expect(text(r)).toContain(argument);
      expect(text(r)).not.toContain('IRIS_');
      // Plain text: nothing here parses as an envelope.
      expect(() => JSON.parse(text(r)) as unknown).toThrow();
    }
  });

  it('the server instructions say of a refused argument what holds of every refusal', () => {
    const said = client.getInstructions() ?? '';
    expect(said).toContain('comes back as plain text saying why');
    expect(said).not.toContain('plain text naming IRIS_INVALID_ARGUMENT');
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

  it('a failure mapped to an envelope its own schema refuses (no step to take; no words) is the internal error too', async () => {
    const noStep = irisError('IRIS_INVALID_ARGUMENT', 'a refusal written without a step to take');
    const noWords = Object.assign(new Error(''), { name: 'DuplicateRuleNameError' });
    for (const odd of [noStep, noWords]) {
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
