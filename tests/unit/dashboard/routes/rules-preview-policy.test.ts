/*
 * A preview of an action_policy judges the stored runs' tool calls.
 *
 * The preview route replays a proposed rule over stored traces before it is
 * deployed. It handed the rule each trace's output, input, cost and tokens,
 * and not its tool calls, which are the only thing a policy reads: every
 * trace skipped as "No tool calls to check against the policy", whatever
 * the policy and whatever the traces held. The author of a deny rule is the
 * one who most needs to see which stored runs it would stop.
 *
 * Through the real route and a real store, so the path from a stored
 * trace's calls to the rule is the one a dashboard takes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { registerRuleRoutes } from '../../../../src/dashboard/routes/rules.js';
import { createTenantMiddleware } from '../../../../src/middleware/tenant.js';
import { SqliteAdapter } from '../../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../../../src/types/tenant.js';
import type { CustomRuleStore } from '../../../../src/custom-rule-store.js';
import type { EvalEngine } from '../../../../src/eval/engine.js';
import type { Trace } from '../../../../src/types/trace.js';
import { MAX_EVALUATED_DEPTH } from '../../../../src/utils/element-count.js';

// Every stored trace a previewed rule is handed, so a test can say what the rule was never given; the rule judges as it
// would. The preview's first call, on an empty output, checks the rule's definition and is not a trace.
const { handed } = vi.hoisted(() => ({ handed: [] as unknown[] }));
vi.mock('../../../../src/eval/rules/custom.js', async (original) => {
  const m = await original<typeof import('../../../../src/eval/rules/custom.js')>();
  return {
    ...m,
    createCustomRule: (...args: Parameters<typeof m.createCustomRule>) => {
      const rule = m.createCustomRule(...args);
      const evaluate = rule.evaluate.bind(rule);
      rule.evaluate = (context) => {
        if (context.output !== '') handed.push(context);
        return evaluate(context);
      };
      return rule;
    },
  };
});

const dirs: string[] = [];
const stores: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function storeWith(traces: Trace[]): Promise<SqliteAdapter> {
  const dir = mkdtempSync(join(tmpdir(), 'iris-preview-policy-'));
  dirs.push(dir);
  const store = new SqliteAdapter(join(dir, 'iris.db'));
  await store.initialize();
  stores.push(store);
  for (const trace of traces) await store.insertTrace(LOCAL_TENANT, trace);
  return store;
}

async function preview(store: SqliteAdapter, definition: Record<string, unknown>): Promise<{ status: number; body: Record<string, any> }> {
  const app = express();
  app.use(express.json());
  app.use(createTenantMiddleware());
  const router = express.Router();
  registerRuleRoutes(router, store, { customRuleStore: {} as unknown as CustomRuleStore, evalEngine: {} as unknown as EvalEngine });
  app.use('/api/v1', router);
  const server = app.listen(0);
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${port}/api/v1/rules/custom/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  } finally {
    server.close();
  }
}

const now = Date.now();
const trace = (id: string, agoMs: number, fields: Partial<Trace>): Trace => ({ trace_id: id, agent_name: 'cleanup-agent', input: 'Tidy the workspace.', output: 'The workspace is tidy.', timestamp: new Date(now - agoMs).toISOString(), ...fields });
const READS = trace('reads', 4_000, { tool_calls: [{ tool_name: 'mcp__files__read_file', input: { path: 'notes.md' }, output: 'x' }] });
const DELETES = trace('deletes', 3_000, {
  tool_calls: [
    { tool_name: 'mcp__files__read_file', input: { path: 'notes.md' }, output: 'x' },
    { tool_name: 'mcp__files__delete_file', input: { path: 'build/' }, output: 'ok' },
  ],
});
const NO_CALLS = trace('no-calls', 2_000, {});
const AS_SPANS = trace('spans', 1_000, {
  spans: [
    { span_id: 's1', trace_id: 'spans', name: 'delete_file', kind: 'TOOL', status_code: 'OK', start_time: new Date(now - 1_500).toISOString(), attributes: { 'tool.name': 'delete_file', 'tool.input': { path: 'tmp/' } } },
  ],
});

// An empty tool_calls list beside TOOL spans: the spans are the run's calls, as they are for the rules of a stored evaluation.
const EMPTY_LIST_AND_SPANS = trace('empty-list', 500, {
  tool_calls: [],
  spans: [
    { span_id: 's2', trace_id: 'empty-list', name: 'delete_file', kind: 'TOOL', status_code: 'OK', start_time: new Date(now - 800).toISOString(), attributes: { 'tool.name': 'delete_file', 'tool.input': { path: 'cache/' } } },
  ],
});

describe('POST /rules/custom/preview — an action_policy', () => {
  it('a deny rule fails the stored run that made the denied call and passes the one that did not', async () => {
    const store = await storeWith([READS, DELETES]);
    const spansRead = vi.spyOn(store, 'getSpansByTraceId');
    const { status, body } = await preview(store, { type: 'action_policy', config: { deny: [{ tool: 'delete_*' }] } });
    expect(status).toBe(200);
    expect(body).toMatchObject({ wouldFail: 1, wouldPass: 1, wouldSkip: 0 });
    expect(body.examples).toHaveLength(1);
    expect(body.examples[0]).toMatchObject({ traceId: 'deletes', agentName: 'cleanup-agent' });
    // Both runs carry tool_calls, which win over spans whole: no span is read for either.
    expect(spansRead).not.toHaveBeenCalled();
  });

  it('a trace with no tool calls is still a skip, and one whose calls arrived as TOOL spans is judged', async () => {
    const store = await storeWith([READS, NO_CALLS, AS_SPANS]);
    const spansRead = vi.spyOn(store, 'getSpansByTraceId');
    const { body } = await preview(store, { type: 'action_policy', config: { deny: [{ tool: 'delete_*' }] } });
    expect(body).toMatchObject({ wouldFail: 1, wouldPass: 1, wouldSkip: 1 });
    expect(body.examples[0]).toMatchObject({ traceId: 'spans' });
    // One read of spans for each trace that carries no tool_calls, and none for the one that does.
    expect(spansRead.mock.calls.map((call) => call[1]).sort()).toEqual(['no-calls', 'spans']);
  });

  it('an empty tool_calls list beside TOOL spans is judged on the spans', async () => {
    const store = await storeWith([READS, EMPTY_LIST_AND_SPANS]);
    const { body } = await preview(store, { type: 'action_policy', config: { deny: [{ tool: 'delete_*' }] } });
    expect(body).toMatchObject({ wouldFail: 1, wouldPass: 1, wouldSkip: 0 });
    expect(body.examples[0]).toMatchObject({ traceId: 'empty-list' });
  });

  it('an allow list fails the run that calls a tool it does not name', async () => {
    const store = await storeWith([READS, DELETES]);
    const { body } = await preview(store, { type: 'action_policy', config: { allow: [{ tool: 'mcp__files__read_file' }] } });
    expect(body).toMatchObject({ wouldFail: 1, wouldPass: 1, wouldSkip: 0 });
    expect(body.examples[0]).toMatchObject({ traceId: 'deletes' });
  });

  it('a rule that reads only the output previews as it did', async () => {
    const store = await storeWith([READS, DELETES, NO_CALLS, AS_SPANS]);
    const spansRead = vi.spyOn(store, 'getSpansByTraceId');
    const { body } = await preview(store, { type: 'contains_keywords', config: { keywords: ['tidy'] } });
    expect(body).toMatchObject({ wouldFail: 0, wouldPass: 4, wouldSkip: 0 });
    // A rule that does not read the calls costs no read of spans, whatever the traces hold.
    expect(spansRead).not.toHaveBeenCalled();
  });

  const nested = (levels: number): unknown => JSON.parse(`${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}`);

  it('a stored trace whose calls nest deeper than an evaluation reads is not handed to the rule: it counts as one the rule would not judge', async () => {
    /*
     * The preview calls the rule itself, without an evaluation, so the
     * measure the engine takes before its first rule has to be taken here.
     * A trace as an earlier version would have stored it: the denied call,
     * its input nested one level deeper than an evaluation reads. The trace,
     * its list of calls and the call are three levels around the input.
     */
    const deletes = (id: string, agoMs: number, levels: number): Trace => trace(id, agoMs, { tool_calls: [{ tool_name: 'mcp__files__delete_file', input: nested(levels), output: 'ok' }] });
    const store = await storeWith([READS, deletes('at-the-limit', 3_000, MAX_EVALUATED_DEPTH - 3), deletes('past-the-limit', 2_000, MAX_EVALUATED_DEPTH - 2), deletes('far-past', 1_000, 3_000)]);
    handed.length = 0;
    const { status, body } = await preview(store, { type: 'action_policy', config: { deny: [{ tool: 'delete_*' }] } });
    expect(status).toBe(200);
    // The run at the limit is judged and fails the rule; the two past it are not read.
    expect(body).toMatchObject({ tracesEvaluated: 4, wouldFail: 1, wouldPass: 1, wouldSkip: 2 });
    expect(body.examples.map((e: { traceId: string }) => e.traceId)).toEqual(['at-the-limit']);
    // Two runs handed to the rule; the two past the limit never were.
    expect(handed).toHaveLength(2);
  });

  it('a trace whose calls arrived as TOOL spans nested deeper than an evaluation reads is measured on those spans, and not handed to the rule', async () => {
    const deepSpans = trace('deep-spans', 1_000, {
      spans: [{ span_id: 's3', trace_id: 'deep-spans', name: 'delete_file', kind: 'TOOL', status_code: 'OK', start_time: new Date(now - 1_200).toISOString(), attributes: { 'tool.name': 'delete_file', 'tool.input': nested(600) } }],
    });
    const store = await storeWith([READS, deepSpans]);
    handed.length = 0;
    const { body } = await preview(store, { type: 'action_policy', config: { deny: [{ tool: 'delete_*' }] } });
    expect(body).toMatchObject({ tracesEvaluated: 2, wouldFail: 0, wouldPass: 1, wouldSkip: 1 });
    expect(handed).toHaveLength(1);
  });

  it('a rule that does not read the calls is not handed a trace whose catalogue nests deeper than an evaluation reads', async () => {
    const deepTools = trace('deep-tools', 1_000, { tools: [{ name: 'lookup', inputSchema: nested(600) as Record<string, unknown> }] });
    const store = await storeWith([READS, deepTools]);
    handed.length = 0;
    const { body } = await preview(store, { type: 'contains_keywords', config: { keywords: ['tidy'] } });
    expect(body).toMatchObject({ tracesEvaluated: 2, wouldPass: 1, wouldSkip: 1 });
    expect(handed).toHaveLength(1);
  });

  it('a trace nested deeper only in its metadata, which the preview does not hand the rule, is previewed as the rule would judge it', async () => {
    // An evaluation of this trace is refused (its context carries the metadata); the preview measures what it hands the rule.
    const deepMetadata = trace('deep-metadata', 1_000, { metadata: { note: nested(600) } });
    const store = await storeWith([READS, deepMetadata]);
    handed.length = 0;
    const { body } = await preview(store, { type: 'contains_keywords', config: { keywords: ['tidy'] } });
    expect(body).toMatchObject({ tracesEvaluated: 2, wouldPass: 2, wouldSkip: 0 });
    expect(handed).toHaveLength(2);
  });
});
