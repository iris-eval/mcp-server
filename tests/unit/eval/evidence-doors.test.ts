/*
 * The evidence contract at every door.
 *
 * A capture source declares itself on the doors software uses: POST
 * /api/v1/traces, `iris-eval ingest` and OTLP (iris.capture.* attributes).
 * The agent's own tools take no declaration: log_trace refuses one, and
 * whatever the agent logs or evaluates reads as its own report. A trace
 * scored again by its id is judged on the declaration it was stored with,
 * and only when the call scores the record as stored.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../../src/server.js';
import { createDashboardServer } from '../../../src/dashboard/server.js';
import { createCustomRuleStore } from '../../../src/custom-rule-store.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { createLogger } from '../../../src/utils/logger.js';
import { fromOtlp, otlpTraceRequestSchema } from '../../../src/otel/ingest.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import { needSchema } from '../../../src/eval/response-schema.js';
import { NEEDS } from '../../../src/eval/failure-classes.js';
import { textOf, type ToolResult } from '../../helpers/mcp-results.js';

const parse = (r: ToolResult): Record<string, unknown> => JSON.parse(textOf(r));
const HOOK = { name: 'iris-eval-capture', version: '0.20.0', complete: ['input', 'tool_calls', 'tool_outputs'] };
const TURN = { agent_name: 'claude-code', input: 'What is the capital of France?', output: 'The capital of France is Paris.' };
type Evidence = { recordedBy: string; capture?: unknown; carried: string[]; toolCalls?: number };
const evidenceOf = (evaluation: unknown): Evidence => (evaluation as { provenance: { evidence: Evidence } }).provenance.evidence;
const verdictOf = (evaluation: unknown) => (evaluation as { verdict: { state: string; basis: string; by: string[] } }).verdict;

describe('the doors', () => {
  let storage: SqliteAdapter;
  let client: Client;
  let ruleDir: string;
  let server: Server;
  let base = '';

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    // A deployment that requires tool calls on every evaluation: where the declaration decides the verdict.
    const config = structuredClone(defaultConfig);
    config.eval.requiredEvidence = ['tool_calls'];
    config.dashboard.port = 0;
    config.dashboard.host = '127.0.0.1';
    config.logging.level = 'error';
    ruleDir = mkdtempSync(join(tmpdir(), 'iris-evidence-doors-'));
    const ruleStore = createCustomRuleStore({ pathFor: () => join(ruleDir, 'custom-rules.json'), auditPath: join(ruleDir, 'audit.log') });
    const { mcpServer, evalEngine } = createIrisServer(config, storage, ruleStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: 'evidence-doors', version: '0.1.0' });
    await client.connect(clientTransport);
    server = createDashboardServer(storage, config, createLogger(config), { evalEngine }).start();
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await client.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage.close();
    rmSync(ruleDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const post = async (body: unknown) => {
    const res = await fetch(`${base}/api/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('POST /api/v1/traces: a capture source that recorded no tool call meets the requirement, stores its declaration, and is named on the verdict', async () => {
    const { status, body } = await post({ ...TURN, tool_calls: [], capture: { ...HOOK, complete: ['tool_outputs', 'tool_calls', 'input', 'tool_calls'] }, evaluate: true });
    expect(status).toBe(201);
    expect(verdictOf(body.evaluation)).toMatchObject({ state: 'pass', basis: 'clean' });
    expect(evidenceOf(body.evaluation)).toEqual({ recordedBy: 'harness', capture: HOOK, carried: ['input', 'output', 'tool_calls', 'tool_outputs'], toolCalls: 0 });
    // Stored in one form, so a later evaluation reads the same declaration.
    expect((await storage.getTrace(LOCAL_TENANT, body.trace_id as string))?.capture).toEqual(HOOK);
  });

  it('POST /api/v1/traces: the same turn without a declaration is the sender saying "none", which the requirement does not take', async () => {
    const { body } = await post({ ...TURN, tool_calls: [], evaluate: true });
    expect(verdictOf(body.evaluation)).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
    expect(evidenceOf(body.evaluation).recordedBy).toBe('not_declared');
  });

  it('POST /api/v1/traces refuses a declaration it cannot read, and stores nothing', async () => {
    for (const capture of [{ name: 'x', complete: ['tools'] }, { name: '', complete: ['input'] }, { nme: 'x' }, { name: 'x', completes: ['input'] }]) {
      const { status } = await post({ ...TURN, capture });
      expect(status, JSON.stringify(capture)).toBe(400);
    }
    expect((await storage.queryTraces(LOCAL_TENANT, { limit: 10 })).total).toBe(0);
  });

  it('log_trace takes no declaration: the agent cannot vouch for its own record, and nothing is stored', async () => {
    const refused = (await client.callTool({ name: 'log_trace', arguments: { ...TURN, tool_calls: [], capture: HOOK, evaluate: true } })) as ToolResult;
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/capture/);
    expect((await storage.queryTraces(LOCAL_TENANT, { limit: 10 })).total).toBe(0);
    // Without one, the record is the agent's own report.
    const logged = parse((await client.callTool({ name: 'log_trace', arguments: { ...TURN, tool_calls: [], evaluate: true } })) as ToolResult);
    expect(evidenceOf(logged.evaluation)).toEqual({ recordedBy: 'agent', carried: ['input', 'output'] });
    expect(verdictOf(logged.evaluation)).toMatchObject({ state: 'unknown', by: ['tool_calls'] });
  });

  it('evaluate_output by trace_id: the stored declaration when the call scores the record, the agent\'s own report when it passes evidence of its own', async () => {
    const { body } = await post({ ...TURN, tool_calls: [], capture: HOOK });
    const traceId = body.trace_id as string;
    const ofRecord = parse((await client.callTool({ name: 'evaluate_output', arguments: { trace_id: traceId } })) as ToolResult);
    expect(ofRecord.trace_id).toBe(traceId);
    expect(evidenceOf(ofRecord)).toMatchObject({ recordedBy: 'harness', capture: HOOK, toolCalls: 0 });
    expect(verdictOf(ofRecord).state).toBe('pass');
    // Other tool calls than the record's: the caller's evidence, through the agent's tool.
    const beside = parse(
      (await client.callTool({ name: 'evaluate_output', arguments: { trace_id: traceId, tool_calls: [{ tool_name: 'search', input: { q: 'France' }, output: 'Paris' }] } })) as ToolResult,
    );
    expect(beside.reference_trace_id).toBe(traceId);
    expect(evidenceOf(beside)).toMatchObject({ recordedBy: 'agent' });
    expect(evidenceOf(beside)).not.toHaveProperty('capture');
    // No trace at all: the agent's own report.
    const loose = parse((await client.callTool({ name: 'evaluate_output', arguments: { output: TURN.output, tool_calls: [] } })) as ToolResult);
    expect(evidenceOf(loose).recordedBy).toBe('agent');
  });

  it('evaluate_output cannot fill a hole in the record: an empty list for a trace stored without one is the caller\'s "none", kept beside the trace', async () => {
    // The capture source promised every call and sent none: the record has a hole, and says so.
    const { body } = await post({ ...TURN, capture: HOOK, evaluate: true });
    const traceId = body.trace_id as string;
    expect(verdictOf(body.evaluation)).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
    // The agent sends the "none" the record lacks.
    const filled = parse((await client.callTool({ name: 'evaluate_output', arguments: { trace_id: traceId, tool_calls: [] } })) as ToolResult);
    expect(filled.reference_trace_id).toBe(traceId);
    expect(filled).not.toHaveProperty('trace_id');
    expect((filled.provenance as { beside?: string[] }).beside).toEqual(['tool_calls']);
    expect(evidenceOf(filled)).toEqual({ recordedBy: 'agent', carried: ['output'] });
    // The trace's verdict is still the one the record earned.
    const evals = await storage.getEvalsByTraceId(LOCAL_TENANT, traceId);
    const ofRecord = evals.filter((e) => e.trace_id === traceId);
    expect(ofRecord).toHaveLength(1);
    expect(ofRecord[0].verdict!.state).toBe('unknown');
  });

  it('evaluate_output with an expected trajectory answers on the default bundle: the response schema names every input a rule reads', async () => {
    expect([...needSchema.options].sort()).toEqual([...NEEDS].sort());
    const r = (await client.callTool({
      name: 'evaluate_output',
      arguments: { input: TURN.input, output: TURN.output, tool_calls: [{ tool_name: 'search', input: { q: 'France' }, output: 'Paris' }], expected_trajectory: { tool_calls: [{ tool_name: 'search' }] } },
    })) as ToolResult;
    expect(r.isError, textOf(r)).toBeFalsy();
    const body = parse(r);
    expect((body.rule_results as Array<{ ruleName: string; saw?: string[] }>).find((x) => x.ruleName === 'tool_sequence')?.saw).toContain('expected_trajectory');
  });

  it('a trace scored again (evaluate_runs, the re-evaluate route) is judged on the declaration it was stored with', async () => {
    // Stored unscored: evaluate_runs scores what the current rules have not.
    const { body } = await post({ ...TURN, tool_calls: [], run: 'nightly-1', capture: HOOK });
    const rescored = parse((await client.callTool({ name: 'evaluate_runs', arguments: { run: 'nightly-1' } })) as ToolResult);
    expect(rescored.evaluated).toBe(1);
    const [scored] = await storage.getEvalsByTraceId(LOCAL_TENANT, body.trace_id as string);
    expect(scored.provenance!.evidence).toMatchObject({ recordedBy: 'harness', capture: HOOK, toolCalls: 0 });
    expect(scored.verdict!.state).toBe('pass');
    const res = await fetch(`${base}/api/v1/evaluations/${scored.id}/reevaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(201);
    const re = ((await res.json()) as { evaluation: unknown }).evaluation;
    expect(evidenceOf(re)).toMatchObject({ recordedBy: 'harness', capture: HOOK, toolCalls: 0 });
    expect(verdictOf(re).state).toBe('pass');
  });

  it('OTLP: iris.capture.* on the resource declares the instrumentation, and tool_calls is not taken: a request without a TOOL span cannot show that none was made', async () => {
    const kv = (key: string, value: unknown) => ({ key, value });
    const res = await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                kv('service.name', { stringValue: 'support-bot' }),
                kv('iris.evaluate', { boolValue: true }),
                kv('iris.capture.name', { stringValue: '@iris-eval/langchain' }),
                kv('iris.capture.version', { stringValue: '0.1.0' }),
                kv('iris.capture.complete', { arrayValue: { values: [{ stringValue: 'tool_calls' }, { stringValue: 'tool_outputs' }] } }),
              ],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: '5b8efff798038103d269b633813fc60c',
                    spanId: 'eee19b7ec3c1b174',
                    name: 'chat',
                    kind: 3,
                    startTimeUnixNano: '1790000000000000000',
                    endTimeUnixNano: '1790000001000000000',
                    attributes: [
                      kv('gen_ai.operation.name', { stringValue: 'chat' }),
                      kv('gen_ai.input.messages', { stringValue: '[{"role":"user","content":"What is the capital of France?"}]' }),
                      kv('gen_ai.output.messages', { stringValue: '[{"role":"assistant","content":"The capital of France is Paris."}]' }),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const [entry] = ((await res.json()) as { 'iris-eval': { stored: Array<Record<string, unknown>> } })['iris-eval'].stored;
    expect(entry.capture).toEqual({ name: '@iris-eval/langchain', version: '0.1.0', complete: ['tool_outputs'] });
    expect(entry.lacked).toContain(
      'iris.capture.complete tool_calls (not read over OTLP: a trace can arrive in several requests, each stored as its own trace, so one without a TOOL span cannot show that no tool was called; it was ignored)',
    );
    // The deployment requires tool calls: a request with none is not checked, as it was before the declaration existed.
    expect(verdictOf(entry.evaluation)).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
    expect(evidenceOf(entry.evaluation)).toMatchObject({ recordedBy: 'harness', capture: { name: '@iris-eval/langchain' } });
    expect(evidenceOf(entry.evaluation)).not.toHaveProperty('toolCalls');
  });
});

describe('OTLP declarations, read', () => {
  const request = (attributes: Array<{ key: string; value: unknown }>) =>
    otlpTraceRequestSchema.parse({
      resourceSpans: [{ resource: { attributes }, scopeSpans: [{ spans: [{ traceId: '5b8efff798038103d269b633813fc60c', spanId: 'eee19b7ec3c1b174', name: 'chat', kind: 3, startTimeUnixNano: '1790000000000000000' }] }] }],
    });
  const s = (v: string) => ({ stringValue: v });

  it('takes one comma-separated string from an exporter that writes only strings', () => {
    const { traces } = fromOtlp(request([{ key: 'iris.capture.name', value: s('my-exporter') }, { key: 'iris.capture.complete', value: s(' tool_outputs , input ') }]));
    expect(traces[0].trace.capture).toEqual({ name: 'my-exporter', complete: ['input', 'tool_outputs'] });
  });

  it('leaves out a field it does not know, and says so', () => {
    const { traces } = fromOtlp(request([{ key: 'iris.capture.name', value: s('my-exporter') }, { key: 'iris.capture.complete', value: s('input,cost') }]));
    expect(traces[0].trace.capture).toEqual({ name: 'my-exporter', complete: ['input'] });
    expect(traces[0].lacked).toContain('iris.capture.complete values from input, tool_calls, tool_outputs (cost is not one, and was ignored)');
  });

  it('reads the declaration from one place: the resource when it carries one, else the root span, never a mix of the two', () => {
    const mixed = otlpTraceRequestSchema.parse({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'iris.capture.name', value: s('sdk-generic') }] },
          scopeSpans: [{ spans: [{ traceId: '5b8efff798038103d269b633813fc60c', spanId: 'eee19b7ec3c1b174', name: 'chat', kind: 3, startTimeUnixNano: '1790000000000000000', attributes: [{ key: 'iris.capture.complete', value: s('input') }, { key: 'iris.capture.name', value: s('framework-x') }] }] }],
        },
      ],
    });
    expect(fromOtlp(mixed).traces[0].trace.capture).toEqual({ name: 'sdk-generic' });
    const rootOnly = otlpTraceRequestSchema.parse({
      resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans: [{ traceId: '5b8efff798038103d269b633813fc60c', spanId: 'eee19b7ec3c1b174', name: 'chat', kind: 3, startTimeUnixNano: '1790000000000000000', attributes: [{ key: 'iris.capture.name', value: s('framework-x') }, { key: 'iris.capture.complete', value: s('input') }] }] }] }],
    });
    expect(fromOtlp(rootOnly).traces[0].trace.capture).toEqual({ name: 'framework-x', complete: ['input'] });
  });

  it('names every value it could not read in lacked: a member that is not text, a list that is neither, a version that is not text, a name past 200 characters', () => {
    const t1 = fromOtlp(request([{ key: 'iris.capture.name', value: s('x') }, { key: 'iris.capture.complete', value: { arrayValue: { values: [s('input'), { intValue: '5' }, { boolValue: true }] } } }, { key: 'iris.capture.version', value: { intValue: '3' } }])).traces[0];
    expect(t1.trace.capture).toEqual({ name: 'x', complete: ['input'] });
    expect(t1.lacked).toContain('iris.capture.complete values as strings (2 were not, and were ignored)');
    expect(t1.lacked).toContain('iris.capture.version as a string (it was not, and was ignored)');
    const t2 = fromOtlp(request([{ key: 'iris.capture.name', value: s('n'.repeat(250)) }, { key: 'iris.capture.complete', value: { kvlistValue: { values: [{ key: 'input', value: s('yes') }] } } }])).traces[0];
    expect(t2.trace.capture).toEqual({ name: 'n'.repeat(200) });
    expect(t2.lacked).toContain('iris.capture.complete as a list or a comma-separated string (it was neither, and was ignored)');
    expect(t2.lacked).toContain('iris.capture.name of at most 200 characters (it had 250; the first 200 were kept)');
    const t3 = fromOtlp(request([{ key: 'iris.capture.name', value: s('x') }, { key: 'iris.capture.complete', value: s('TOOL_CALLS,Input') }])).traces[0];
    expect(t3.lacked).toContain('iris.capture.complete values from input, tool_calls, tool_outputs (TOOL_CALLS, Input are not, and were ignored)');
  });

  it('reads no declaration without a name, and says why', () => {
    const { traces } = fromOtlp(request([{ key: 'iris.capture.complete', value: s('input') }]));
    expect(traces[0].trace.capture).toBeUndefined();
    expect(traces[0].lacked).toContain('iris.capture.name (a declaration says who makes it, so iris.capture.complete and iris.capture.version were ignored)');
    // And says nothing when nothing was declared.
    expect(fromOtlp(request([])).traces[0].lacked.some((l) => l.startsWith('iris.capture'))).toBe(false);
  });
});
