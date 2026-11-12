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
});
