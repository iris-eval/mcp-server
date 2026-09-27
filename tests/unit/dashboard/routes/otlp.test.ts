/*
 * POST /v1/traces on the dashboard port: a GenAI payload is
 * stored as a trace with its spans and `source: 'otel'`; the answer is
 * OTLP's ExportTraceServiceResponse plus the `iris-eval` block; with
 * otel.evaluateOnIngest the trace that carries an output is scored, and
 * the one that does not says `evaluation: null`; the JSON-only contract,
 * the schema refusal, the key, and no re-export.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SqliteAdapter } from '../../../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../../../src/dashboard/server.js';
import { defaultConfig } from '../../../../src/config/defaults.js';
import { EvalEngine } from '../../../../src/eval/engine.js';
import { LOCAL_TENANT } from '../../../../src/types/tenant.js';
import type { IrisConfig } from '../../../../src/types/config.js';
import { __resetExporterForTests } from '../../../../src/otel/lazy.js';
import type { OtelExporter } from '../../../../src/otel/exporter.js';

const mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const kv = (key: string, value: unknown) => ({ key, value });
const str = (s: string) => ({ stringValue: s });
const T0 = Date.UTC(2026, 8, 21, 12, 0, 0);
const nanos = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

function payload(output: string | null, traceId = '5b8efff798038103d269b633813fc60c') {
  return {
    resourceSpans: [
      {
        resource: { attributes: [kv('service.name', str('support-bot'))] },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId: 'eee19b7ec3c1b174',
                name: 'chat',
                startTimeUnixNano: nanos(T0),
                endTimeUnixNano: nanos(T0 + 100),
                attributes: [
                  kv('gen_ai.request.model', str('gpt-4o')),
                  kv('gen_ai.input.messages', str('Summarise the notes.')),
                  ...(output === null ? [] : [kv('gen_ai.output.messages', str(output))]),
                ],
              },
              {
                traceId,
                spanId: 'a1b2c3d4e5f60718',
                parentSpanId: 'eee19b7ec3c1b174',
                name: 'execute_tool',
                startTimeUnixNano: nanos(T0 + 10),
                endTimeUnixNano: nanos(T0 + 50),
                attributes: [kv('gen_ai.tool.name', str('search')), kv('gen_ai.tool.call.arguments', str('{"q":"notes"}')), kv('gen_ai.tool.call.result', str('3 hits'))],
              },
            ],
          },
        ],
      },
    ],
  };
}

interface Booted {
  storage: SqliteAdapter;
  server: Server;
  base: string;
}
const booted: Booted[] = [];
afterEach(async () => {
  __resetExporterForTests();
  for (const b of booted.splice(0)) {
    b.server.closeAllConnections?.();
    await new Promise<void>((resolve) => b.server.close(() => resolve()));
    await b.storage.close();
  }
});

async function boot(over: { evaluateOnIngest?: boolean; apiKey?: string } = {}): Promise<Booted> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const config: IrisConfig = {
    ...defaultConfig,
    dashboard: { ...defaultConfig.dashboard, port: 0 },
    otel: { evaluateOnIngest: over.evaluateOnIngest ?? false },
    security: { ...defaultConfig.security, apiKey: over.apiKey },
  };
  const evalEngine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds, config.eval);
  const server = createDashboardServer(storage, config, mockLogger, { evalEngine }).start();
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const entry = { storage, server, base: `http://127.0.0.1:${port}` };
  booted.push(entry);
  return entry;
}

const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('POST /v1/traces', () => {
  it('stores an OTLP trace with its spans and source otel, answers the OTLP response with the iris-eval block, and does not evaluate by default', async () => {
    const { base, storage } = await boot();
    const res = await post(base, payload('The notes say the launch is Tuesday.'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { partialSuccess?: unknown; 'iris-eval': { stored: Array<Record<string, unknown>>; count: number; evaluate_on_ingest: boolean } };
    expect(body.partialSuccess).toBeUndefined();
    expect(body['iris-eval'].count).toBe(1);
    expect(body['iris-eval'].evaluate_on_ingest).toBe(false);
    const entry = body['iris-eval'].stored[0];
    expect(entry).toMatchObject({ otel_trace_id: '5b8efff798038103d269b633813fc60c', agent_name: 'support-bot', spans: 2, steps: 1, lacked: [] });
    expect(entry).not.toHaveProperty('evaluation');
    expect(String(entry.trace_id)).toMatch(/^[0-9a-f]{32}$/);
    const stored = await storage.getTrace(LOCAL_TENANT, String(entry.trace_id));
    expect(stored?.source).toBe('otel');
    expect(stored?.agent_name).toBe('support-bot');
    expect(stored?.output).toBe('The notes say the launch is Tuesday.');
    // getTrace does not hydrate spans; they live in their own table.
    const spans = await storage.getSpansByTraceId(LOCAL_TENANT, String(entry.trace_id));
    expect(spans).toHaveLength(2);
    expect(spans.map((s) => s.kind).sort()).toEqual(['LLM', 'TOOL']);
    expect((stored?.metadata as { otel: { trace_id: string } }).otel.trace_id).toBe('5b8efff798038103d269b633813fc60c');
  });

  it('with otel.evaluateOnIngest the trace with an output is scored and the one without says evaluation: null', async () => {
    const { base } = await boot({ evaluateOnIngest: true });
    const scored = (await (await post(base, payload('TODO: write the summary.'))).json()) as {
      'iris-eval': { stored: Array<{ evaluation?: { verdict?: { state: string }; rule_results: Array<{ ruleName: string; passed: boolean }> } | null }> };
    };
    const evaluation = scored['iris-eval'].stored[0].evaluation;
    // The stub detector fires on the output; the verdict itself is the composer's over the whole trace (a tool step is in it too).
    expect(evaluation?.rule_results.some((r) => r.ruleName === 'no_stub_output' && r.passed === false)).toBe(true);
    expect(['pass', 'fail', 'unknown']).toContain(evaluation?.verdict?.state);
    const bare = (await (await post(base, payload(null, '00000000000000000000000000000002'))).json()) as { 'iris-eval': { stored: Array<{ evaluation?: unknown; lacked: string[] }> } };
    expect(bare['iris-eval'].stored[0].evaluation).toBeNull();
    expect(bare['iris-eval'].stored[0].lacked.some((l) => l.startsWith('output'))).toBe(true);
  });

  it('scores a trace whose sender asked with iris.evaluate, with evaluateOnIngest off, and leaves the others unscored', async () => {
    const { base, storage } = await boot();
    const asking = (resource: Array<{ key: string; value: unknown }>, traceId: string, output: string | null = 'Her SSN is 123-45-6789.') => {
      const p = payload(output, traceId);
      p.resourceSpans[0].resource.attributes.push(...resource);
      return p;
    };
    type Answer = { 'iris-eval': { evaluate_on_ingest: boolean; stored: Array<{ trace_id: string; evaluation?: { eval_type: string; trace_id?: string; verdict?: { state: string }; rule_results: Array<{ ruleName: string; passed: boolean }> } | null; evaluation_error?: string }> } };

    // A boolean true on the resource, and the bundle named: the safety rules run and the email is caught.
    const safety = (await (await post(base, asking([kv('iris.evaluate', { boolValue: true }), kv('iris.eval_type', str('safety'))], '00000000000000000000000000000011'))).json()) as Answer;
    expect(safety['iris-eval'].evaluate_on_ingest).toBe(false);
    const scored = safety['iris-eval'].stored[0];
    expect(scored.evaluation?.eval_type).toBe('safety');
    expect(scored.evaluation?.rule_results.some((r) => r.ruleName === 'no_pii' && r.passed === false)).toBe(true);
    expect(scored.evaluation?.verdict?.state).toBe('fail');
    // Stored and linked, as every other evaluate-on-write door does.
    const evals = await storage.getEvalsByTraceId(LOCAL_TENANT, scored.trace_id);
    expect(evals).toHaveLength(1);

    // The string "true" an exporter that writes only strings sends, with no bundle: every bundle runs.
    const all = (await (await post(base, asking([kv('iris.evaluate', str('true'))], '00000000000000000000000000000012'))).json()) as Answer;
    expect(all['iris-eval'].stored[0].evaluation?.eval_type).toBe('all');

    // On the root span instead of the resource.
    const onRoot = payload('Her SSN is 123-45-6789.', '00000000000000000000000000000013');
    onRoot.resourceSpans[0].scopeSpans[0].spans[0].attributes.push(kv('iris.evaluate', { boolValue: true }));
    const root = (await (await post(base, onRoot)).json()) as Answer;
    expect(root['iris-eval'].stored[0].evaluation?.verdict?.state).toBeDefined();

    // Not asked: stored, no evaluation block at all.
    const quiet = (await (await post(base, asking([], '00000000000000000000000000000014'))).json()) as Answer;
    expect(quiet['iris-eval'].stored[0]).not.toHaveProperty('evaluation');

    // Asked, with no output: nothing to score, said as evaluation: null.
    const bare = (await (await post(base, asking([kv('iris.evaluate', { boolValue: true })], '00000000000000000000000000000015', null))).json()) as Answer;
    expect(bare['iris-eval'].stored[0].evaluation).toBeNull();

    // An unknown bundle: stored, not scored, and the entry says why rather than widening to every bundle.
    const unknown = (await (await post(base, asking([kv('iris.evaluate', { boolValue: true }), kv('iris.eval_type', str('vibes'))], '00000000000000000000000000000016'))).json()) as Answer;
    expect(unknown['iris-eval'].stored[0].evaluation).toBeNull();
    expect(unknown['iris-eval'].stored[0].evaluation_error).toMatch(/iris\.eval_type "vibes" is not one of/);
    expect(await storage.getEvalsByTraceId(LOCAL_TENANT, unknown['iris-eval'].stored[0].trace_id)).toHaveLength(0);
  });

  it('refuses a non-JSON content type with 415, a non-OTLP body with 400, and reports dropped spans as partialSuccess', async () => {
    const { base } = await boot();
    const text = await post(base, 'hello', { 'content-type': 'text/plain' });
    expect(text.status).toBe(415);
    expect(((await text.json()) as { error: string }).error).toMatch(/JSON.*protobuf/);
    const garbage = await post(base, ' ', { 'content-type': 'application/x-protobuf' });
    expect(garbage.status).toBe(400);
    expect(((await garbage.json()) as { error: string }).error).toMatch(/Not a protobuf ExportTraceServiceRequest/);
    // No body at all under the protobuf content type: refused as not bytes, never decoded as an empty message.
    const empty = await fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' } });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toMatch(/empty or not bytes/);
    const wrong = await post(base, { traces: [] });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toMatch(/ExportTraceServiceRequest/);
    const partial = await post(base, { resourceSpans: [{ scopeSpans: [{ spans: [{ spanId: 'orphan' }, { traceId: 't', spanId: 's', startTimeUnixNano: nanos(T0) }] }] }] });
    expect(partial.status).toBe(200);
    const body = (await partial.json()) as { partialSuccess: { rejectedSpans: number; errorMessage: string }; 'iris-eval': { count: number } };
    expect(body.partialSuccess.rejectedSpans).toBe(1);
    expect(body.partialSuccess.errorMessage).toMatch(/traceId/);
    expect(body['iris-eval'].count).toBe(1);
  });

  it('stores what the Python exporter posts: the real protobuf fixture lands as one trace with its spans', async () => {
    const { base, storage } = await boot();
    const fixture = readFileSync(resolve(import.meta.dirname, '../../../fixtures/otlp/python-genai.pb'));
    const res = await fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: fixture });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { 'iris-eval': { count: number; stored: Array<{ agent_name: string; spans: number; lacked: string[] }> } };
    expect(body['iris-eval'].count).toBe(1);
    expect(body['iris-eval'].stored[0].agent_name).toBe('billing-agent');
    expect(body['iris-eval'].stored[0].spans).toBe(4);
    expect(body['iris-eval'].stored[0].lacked).toEqual([]);
    const listed = await storage.queryTraces(LOCAL_TENANT, { limit: 5 });
    expect(listed.total).toBe(1);
    expect(listed.traces[0].output).toContain('Refunded order 8812');
  });

  it('sits behind the same key as the API: no Bearer is 401, the key is accepted', async () => {
    const { base } = await boot({ apiKey: 'otel-key' });
    expect((await post(base, payload('x'))).status).toBe(401);
    expect((await post(base, payload('x'), { authorization: 'Bearer otel-key' })).status).toBe(200);
  });

  it('never re-exports what arrived by OTLP', async () => {
    const exportTraces = vi.fn(async () => ({ ok: true }));
    __resetExporterForTests({ exportTraces } as unknown as OtelExporter);
    const { base } = await boot();
    expect((await post(base, payload('x'))).status).toBe(200);
    // The REST door does export through the same lazy exporter; this door must not.
    expect((await fetch(`${base}/api/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_name: 'a', output: 'o' }) })).status).toBe(201);
    await new Promise((r) => setTimeout(r, 30));
    expect(exportTraces).toHaveBeenCalledTimes(1);
  });
});

/*
 * 2026-09-23 security review. One 1 MB request of 11,500 one-span
 * traces used to hold the event loop for 11 seconds, storing each trace in
 * its own transaction; and a duplicate span id mid-batch returned a 500
 * after the earlier traces had already committed.
 */
function manyTraces(n: number, dupSpan = false) {
  const hex = (i: number, width: number) => i.toString(16).padStart(width, '0');
  return {
    resourceSpans: [
      {
        resource: { attributes: [kv('service.name', str('bulk'))] },
        scopeSpans: [
          {
            spans: Array.from({ length: n }, (_, i) => ({
              traceId: dupSpan && i === n - 1 ? hex(1, 32) : hex(i + 1, 32),
              spanId: dupSpan && i === n - 1 ? hex(1, 16) : hex(i + 1, 16),
              name: 'chat',
              startTimeUnixNano: nanos(T0),
              endTimeUnixNano: nanos(T0 + 1),
              attributes: [kv('gen_ai.output.messages', str('ok'))],
            })),
          },
        ],
      },
    ],
  };
}

describe('POST /v1/traces — bounded batches', () => {
  it('stores at most MAX_OTLP_TRACES_PER_REQUEST traces and reports the rest as rejected spans, promptly', async () => {
    const { MAX_OTLP_TRACES_PER_REQUEST } = await import('../../../../src/dashboard/routes/otlp.js');
    const { base, storage } = await boot();
    const batch = vi.spyOn(storage, 'insertTraces');
    const single = vi.spyOn(storage, 'insertTrace');
    const res = await post(base, manyTraces(MAX_OTLP_TRACES_PER_REQUEST + 5));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { partialSuccess?: { rejectedSpans: number; errorMessage: string }; 'iris-eval': { count: number } };
    expect(body['iris-eval'].count).toBe(MAX_OTLP_TRACES_PER_REQUEST);
    expect(body.partialSuccess?.rejectedSpans).toBe(5);
    expect(body.partialSuccess?.errorMessage).toContain('limit per request');
    expect((await storage.queryTraces(LOCAL_TENANT, { limit: 1 })).total).toBe(MAX_OTLP_TRACES_PER_REQUEST);
    /*
     * One transaction for the batch: one insertTraces call carrying every
     * accepted trace, and no per-trace insert. The per-trace commits took
     * 11 s; this used to be held under 10 s of wall time, which a loaded
     * machine could exceed with the fix in place.
     */
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][1]).toHaveLength(MAX_OTLP_TRACES_PER_REQUEST);
    expect(single).not.toHaveBeenCalled();
  });

  it('stores nothing and answers 400 when a span repeats inside the batch (all or nothing)', async () => {
    const { base, storage } = await boot();
    const res = await post(base, manyTraces(10, true));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('Nothing was stored');
    expect((await storage.queryTraces(LOCAL_TENANT, { limit: 1 })).total).toBe(0);
  });
});
