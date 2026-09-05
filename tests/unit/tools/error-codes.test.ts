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
 */
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../../src/server.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { createCustomRuleStore } from '../../../src/custom-rule-store.js';
import { registerEvaluateOutputTool } from '../../../src/tools/evaluate-output.js';
import { ERROR_CODE_CATALOGUE, toIrisError } from '../../../src/tools/errors.js';
import { errorEnvelopeSchema } from '../../../src/tools/respond.js';
import { LLMJudgeError } from '../../../src/eval/llm-judge/client.js';
import { __setDnsLookupForTests, __clearCitationCacheForTests } from '../../../src/eval/citation-verify/resolve.js';
import type { EvalEngine } from '../../../src/eval/engine.js';
import type { IStorageAdapter } from '../../../src/types/query.js';

const root = resolve(__dirname, '..', '..', '..');

type Result = { content?: unknown; isError?: boolean };
const text = (r: Result) => (r.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')!.text!;
function envelope(r: Result) {
  expect(r.isError).toBe(true);
  const parsed = errorEnvelopeSchema.safeParse(JSON.parse(text(r)));
  expect(parsed.success, text(r)).toBe(true);
  return parsed.success ? parsed.data.error : (undefined as never);
}

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
    delete process.env.IRIS_ANTHROPIC_API_KEY;
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
    rmSync(ruleDir, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env.IRIS_ANTHROPIC_API_KEY;
    else process.env.IRIS_ANTHROPIC_API_KEY = savedKey;
    global.fetch = savedFetch;
    __setDnsLookupForTests(undefined);
    __clearCitationCacheForTests();
  });

  it('IRIS_INVALID_ARGUMENT — the protocol layer refuses an unknown argument and names the code in its text', async () => {
    const r = (await client.callTool({ name: 'evaluate_output', arguments: { output: 'x', bogus: 1 } })) as Result;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('IRIS_INVALID_ARGUMENT');
    expect(text(r)).toContain('"bogus"');
    provoked.add('IRIS_INVALID_ARGUMENT');
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

  it('IRIS_JUDGE_FAILED — citations resolved but the judge failed on every one; nothing stored', async () => {
    process.env.IRIS_ANTHROPIC_API_KEY = 'test-key';
    __setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('anthropic.com')) return new Response('{"error":"down"}', { status: 500 });
      return new Response('<html><body>A source about the claim.</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    const e = envelope(
      (await client.callTool({
        name: 'verify_citations',
        arguments: { output: 'The claim is supported by https://example.org/paper.', model: 'claude-haiku-4-5', allow_fetch: true },
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
    const broken = { evaluateAll: () => { throw new Error('engine exploded'); }, evaluate: () => { throw new Error('engine exploded'); } } as unknown as EvalEngine;
    const e = envelope(await callIsolated(storage, broken, { output: 'x' }));
    expect(e.code).toBe('IRIS_INTERNAL_ERROR');
    expect(e.message).toContain('engine exploded');
    provoked.add(e.code);
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
    try {
      return (await isolated.callTool({ name: 'evaluate_output', arguments: args })) as Result;
    } finally {
      await isolated.close();
    }
  }
});

describe('toIrisError maps what the runtime throws', () => {
  it('a provider rate limit is retryable with retryAfterMs', () => {
    const e = toIrisError(new LLMJudgeError('slow down', 'rate_limit', 429, 7));
    expect(e.envelope).toMatchObject({ code: 'IRIS_PROVIDER_ERROR', kind: 'rate_limit', retryable: true, retryAfterMs: 7000 });
  });
  it('a plain error is internal, with a recovery', () => {
    const e = toIrisError(new Error('boom'));
    expect(e.envelope.code).toBe('IRIS_INTERNAL_ERROR');
    expect(e.envelope.recovery.length).toBeGreaterThan(0);
  });
});
