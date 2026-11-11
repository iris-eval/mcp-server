import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';

/*
 * A run read against the same agent's earlier runs of its own case, over
 * the real MCP surface.
 *
 * The rules themselves are held by tests/unit/eval/case-history.test.ts.
 * What is held here is the part no unit test reaches: that every door that
 * evaluates a stored trace hands the rules the case's history from the
 * store, that a call with no stored trace behind it gets none, that a run
 * is never part of its own history, and that another agent's runs are not
 * read.
 */

type RuleRow = { ruleName: string; state: string; passed: boolean; skipped?: boolean; skipReason?: string; message: string };
const RULES = ['no_unusual_action', 'no_dropped_step'];

describe('the case-history rules, through the doors', () => {
  let client: Client;
  let storage: SqliteAdapter;

  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = (await client.callTool({ name, arguments: args })) as { structuredContent?: Record<string, unknown>; content: Array<{ text: string }> };
    return (res.structuredContent ?? (JSON.parse(res.content[0].text) as Record<string, unknown>)) as Record<string, unknown>;
  };

  /** One run of a case: the usual two calls, or others. */
  const logRun = async (run: string, tools: string[] = ['get_balance', 'send_money'], over: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    call('log_trace', {
      agent_name: 'payer',
      input: 'Pay the open invoice and confirm the balance.',
      output: 'Paid invoice INV-7: 420.00 sent, balance confirmed.',
      run,
      case_key: 'pay-invoice',
      tool_calls: tools.map((tool_name) => ({ tool_name, input: { invoice: 'INV-7' }, output: 'ok' })),
      evaluate: true,
      ...over,
    });

  const evaluationOf = (response: Record<string, unknown>) => (response.evaluation ?? response) as { rule_results: RuleRow[]; passed: boolean; verdict: { state: string; basis: string } };
  const rows = (response: Record<string, unknown>): Map<string, RuleRow> => new Map(evaluationOf(response).rule_results.map((r) => [r.ruleName, r]));

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const { mcpServer } = createIrisServer(defaultConfig, storage);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: 'case-history-test', version: '0.1.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
  });

  it('the first three runs of a case are not judged against a history; the fourth is', async () => {
    for (const run of ['nightly-1', 'nightly-2', 'nightly-3']) {
      const r = rows(await logRun(run));
      for (const name of RULES) expect(r.get(name)?.state, `${run} ${name}`).toBe('not_checked');
    }
    const fourth = rows(await logRun('nightly-4'));
    for (const name of RULES) expect(fourth.get(name)?.state, name).toBe('pass');
  });

  it('a run that takes an action no earlier run took and drops a step every one of them took is told both', async () => {
    for (const run of ['nightly-1', 'nightly-2', 'nightly-3', 'nightly-4', 'nightly-5']) await logRun(run);
    const r = rows(await logRun('nightly-6', ['get_balance', 'delete_account']));
    expect(r.get('no_unusual_action')).toMatchObject({ state: 'fail', message: 'Unusual action for this case: delete_account, called in none of its 5 earlier runs' });
    expect(r.get('no_dropped_step')).toMatchObject({ state: 'fail', message: 'Dropped step for this case: send_money, called in every one of its 5 earlier runs and not in this one' });
  });

  /*
   * Through the real doors: the unusual action is weighed, so the run that
   * passes under a case of its own fails under the case whose earlier runs
   * never took the action. The next run that takes it passes again, because
   * the action is then in the case's history.
   */
  it('an action the case never took fails the verdict that passes without a history, once, and the result reads back the same', async () => {
    for (const run of ['nightly-1', 'nightly-2', 'nightly-3']) await logRun(run);
    const odd = ['get_balance', 'send_money', 'delete_account'];
    const stored = await logRun('nightly-4', odd);
    const withHistory = evaluationOf(stored);
    // The same agent, ask, answer and calls under a case of its own, so with no earlier run.
    const alone = evaluationOf(await logRun('nightly-4', odd, { case_key: 'a-case-run-once' }));
    expect(rows(alone as unknown as Record<string, unknown>).get('no_unusual_action')?.state).toBe('not_checked');
    expect([alone.passed, alone.verdict.state, alone.verdict.basis]).toEqual([true, 'pass', 'clean']);
    expect(rows(withHistory as unknown as Record<string, unknown>).get('no_unusual_action')).toMatchObject({ state: 'fail', kind: 'inference', role: 'risk' });
    expect([withHistory.passed, withHistory.verdict.state, withHistory.verdict.basis]).toEqual([false, 'fail', 'risk_over_loss']);
    // Stored, the evaluation re-composes to the verdict the caller was given.
    const traceId = (stored as { trace_id: string }).trace_id;
    const [readBack] = await storage.getEvalsByTraceId(LOCAL_TENANT, traceId);
    expect([readBack.passed, readBack.verdict?.state, readBack.verdict?.basis]).toEqual([false, 'fail', 'risk_over_loss']);
    // The action is in the history now: the next run that takes it is not a departure.
    const next = evaluationOf(await logRun('nightly-5', odd));
    expect(rows(next as unknown as Record<string, unknown>).get('no_unusual_action')?.state).toBe('pass');
    expect(next.passed).toBe(true);
  });

  it('a dropped step decides nothing: the same run, with a history that fires it and with none, gets the same verdict', async () => {
    for (const run of ['nightly-1', 'nightly-2', 'nightly-3']) await logRun(run);
    // A look-up the earlier runs never made is not an unusual action, so only the dropped step fires.
    const short = ['get_balance'];
    const withHistory = evaluationOf(await logRun('nightly-4', short));
    const alone = evaluationOf(await logRun('nightly-4', short, { case_key: 'a-case-run-once' }));
    expect(rows(withHistory as unknown as Record<string, unknown>).get('no_dropped_step')?.state).toBe('fail');
    expect(rows(withHistory as unknown as Record<string, unknown>).get('no_unusual_action')?.state).toBe('pass');
    expect([withHistory.passed, withHistory.verdict.state, withHistory.verdict.basis]).toEqual([alone.passed, alone.verdict.state, alone.verdict.basis]);
  });

  it('another agent\'s runs of the same case are not its history', async () => {
    for (const run of ['nightly-1', 'nightly-2', 'nightly-3', 'nightly-4']) await logRun(run);
    const other = rows(await logRun('nightly-5', ['open_ledger', 'post_summary'], { agent_name: 'auditor' }));
    for (const name of RULES) {
      expect(other.get(name)?.state, name).toBe('not_checked');
      expect(other.get(name)?.skipReason, name).toContain('insufficient_history: 0 earlier runs of this case by this agent');
    }
  });

  it('evaluate_output with a trace_id reads the same history; with none it has no stored case', async () => {
    for (const run of ['nightly-1', 'nightly-2', 'nightly-3']) await logRun(run);
    const logged = await logRun('nightly-4', ['get_balance', 'delete_account'], { evaluate: false });
    const linked = rows(await call('evaluate_output', { trace_id: logged.trace_id as string }));
    expect(linked.get('no_unusual_action')?.state).toBe('fail');
    const bare = rows(await call('evaluate_output', { output: 'Paid invoice INV-7: 420.00 sent.', input: 'Pay the open invoice and confirm the balance.', tool_calls: [{ tool_name: 'delete_account', input: {}, output: 'ok' }] }));
    expect(bare.get('no_unusual_action')?.state).toBe('not_checked');
    expect(bare.get('no_unusual_action')?.skipReason).toContain('insufficient_history: no stored case');
  });

  it('evaluate_runs re-scores a run against the same earlier runs: a run is never part of its own history, and later runs are not read', async () => {
    for (const run of ['nightly-1', 'nightly-2', 'nightly-3']) await logRun(run);
    // Stored and not judged, so the re-scoring below is its first evaluation.
    await logRun('nightly-4', ['get_balance', 'delete_account'], { evaluate: false });
    // Runs logged after it call delete_account too; read as history they would make it an action taken before.
    for (const run of ['nightly-5', 'nightly-6', 'nightly-7', 'nightly-8']) await logRun(run, ['get_balance', 'send_money', 'delete_account']);
    const out = await call('evaluate_runs', { run: 'nightly-4' });
    const results = await storage.getRunResults(LOCAL_TENANT, out.run as string);
    expect(results).toHaveLength(1);
    expect(results[0].failedRules).toEqual(expect.arrayContaining(RULES));
  });

  it('a case key derived from the input is a case: the same ask, sent with no key, is read against its earlier runs', async () => {
    const send = (tools: string[]): Promise<Record<string, unknown>> =>
      call('log_trace', { agent_name: 'payer', input: 'Close the ticket and notify the customer.', output: 'Closed and notified.', tool_calls: tools.map((tool_name) => ({ tool_name, input: {}, output: 'ok' })), evaluate: true });
    for (let i = 0; i < 3; i += 1) await send(['close_ticket', 'send_email']);
    const r = rows(await send(['close_ticket', 'send_email', 'refund_order']));
    expect(r.get('no_unusual_action')).toMatchObject({ state: 'fail', message: 'Unusual action for this case: refund_order, called in none of its 3 earlier runs' });
    expect(r.get('no_dropped_step')?.state).toBe('pass');
  });
});
