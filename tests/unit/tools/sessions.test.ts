/*
 * Sessions on the MCP door: log_trace takes session_id, or
 * reads it from the SEP-414 baggage; get_traces filters by session;
 * compare_traces groups by session.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../../src/server.js';
import { createCustomRuleStore } from '../../../src/custom-rule-store.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { EvalResult } from '../../../src/types/eval.js';

const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
type Content = Array<{ type: string; text: string }>;
const parse = (r: unknown) => JSON.parse((r as { content: Content }).content[0].text) as Record<string, unknown>;

describe('sessions over MCP', () => {
  let client: Client;
  let storage: SqliteAdapter;
  let ruleDir: string;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    ruleDir = mkdtempSync(join(tmpdir(), 'iris-sessions-'));
    const ruleStore = createCustomRuleStore({ pathFor: () => join(ruleDir, 'custom-rules.json'), auditPath: join(ruleDir, 'audit.log') });
    const { mcpServer } = createIrisServer(defaultConfig, storage, ruleStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: 'sessions', version: '0.1.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
    rmSync(ruleDir, { recursive: true, force: true });
  });

  const log = (args: Record<string, unknown>, _meta?: Record<string, unknown>) =>
    client.callTool({ name: 'log_trace', arguments: { agent_name: 'bot', input: 'q', output: 'A full answer with enough words to pass the length rule, and then some.', ...args }, ...(_meta ? { _meta } : {}) });

  it('log_trace stores session_id, or the baggage session_id, and get_traces filters by session', async () => {
    const a = parse(await log({ session_id: 'sess-1', timestamp: '2026-09-21T12:00:00.000Z' }));
    const b = parse(await log({ timestamp: '2026-09-21T12:01:00.000Z' }, { traceparent: TP, baggage: 'session_id=sess-1' }));
    parse(await log({ session_id: 'sess-2' }));
    parse(await log({}));
    expect((await storage.getTrace(LOCAL_TENANT, b.trace_id as string))?.session_id).toBe('sess-1');

    const page = parse(await client.callTool({ name: 'get_traces', arguments: { session: 'sess-1', sort_order: 'asc' } }));
    expect(page.total).toBe(2);
    expect((page.traces as Array<{ trace_id: string; session_id?: string }>).map((t) => t.trace_id)).toEqual([a.trace_id, b.trace_id]);

    const none = parse(await client.callTool({ name: 'get_traces', arguments: { session: 'nope' } }));
    expect(none.total).toBe(0);
  });

  it('compare_traces groups by session: a session answered both ways reads as flaky, and its rows carry the session id', async () => {
    // Stored attempts with known verdicts. sess-1: two turns, one fails; sess-2: two turns, both pass; a turn in no session is left out of the session view.
    const attempts: Array<{ id: string; session?: string; caseKey: string; verdict: boolean }> = [
      { id: 'a1', session: 'sess-1', caseKey: 'k1', verdict: true },
      { id: 'a2', session: 'sess-1', caseKey: 'k2', verdict: false },
      { id: 'a3', session: 'sess-2', caseKey: 'k3', verdict: true },
      { id: 'a4', session: 'sess-2', caseKey: 'k4', verdict: true },
      { id: 'a5', caseKey: 'k5', verdict: false },
    ];
    for (const a of attempts) {
      await storage.insertTrace(LOCAL_TENANT, { trace_id: `t-${a.id}`, agent_name: 'bot', input: `ask ${a.id}`, output: 'o', timestamp: '2026-09-21T12:00:00.000Z', run_id: 'nightly-1', case_key: a.caseKey, ...(a.session ? { session_id: a.session } : {}) });
      const result: EvalResult = { id: `e-${a.id}`, trace_id: `t-${a.id}`, eval_type: 'all', output_text: 'o', score: a.verdict ? 1 : 0, passed: a.verdict, rule_results: [], run_id: 'nightly-1' };
      await storage.insertEvalResult(LOCAL_TENANT, result);
    }

    const bySession = parse(await client.callTool({ name: 'compare_traces', arguments: { group_by: 'session' } }));
    expect(bySession.group_by).toBe('session');
    expect(bySession.cases).toBe(2);
    expect(bySession.attempts).toBe(4);
    const rows = bySession.by_case as Array<{ case_key: string; attempts: number; passed: number; flaky: boolean }>;
    expect(rows.map((r) => r.case_key).sort()).toEqual(['sess-1', 'sess-2']);
    expect(rows.find((r) => r.case_key === 'sess-1')).toMatchObject({ attempts: 2, passed: 1, flaky: true });
    expect(rows.find((r) => r.case_key === 'sess-2')).toMatchObject({ attempts: 2, passed: 2, flaky: false });
    expect((bySession.flaky_cases as Array<{ case_key: string }>).map((r) => r.case_key)).toEqual(['sess-1']);

    const one = parse(await client.callTool({ name: 'compare_traces', arguments: { group_by: 'session', session: 'sess-2' } }));
    expect(one.cases).toBe(1);
    expect((one.by_case as Array<{ case_key: string }>)[0].case_key).toBe('sess-2');

    const byCase = parse(await client.callTool({ name: 'compare_traces', arguments: {} }));
    expect(byCase.group_by).toBe('case_key');
    expect(byCase.cases).toBe(5);

    const empty = parse(await client.callTool({ name: 'compare_traces', arguments: { group_by: 'session', session: 'sess-9' } }));
    expect(empty.cases).toBe(0);
    expect(empty.summary).toMatch(/session/);
  });
});
