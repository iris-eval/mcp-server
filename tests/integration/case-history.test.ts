import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';

/*
 * A run read against the earlier runs of its own case, over the real MCP
 * surface.
 *
 * The rules themselves are held by tests/unit/eval/case-history.test.ts.
 * What is held here is the part no unit test reaches: that every door that
 * evaluates a stored trace hands the rules the case's history from the
 * store, that a call with no trace behind it gets none, and that a run is
 * never part of its own history.
 */

type RuleRow = { ruleName: string; state: string; passed: boolean; skipped?: boolean; skipReason?: string; message: string };

describe('the case-history rules, through the doors', () => {
  let client: Client;
  let storage: SqliteAdapter;

  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = (await client.callTool({ name, arguments: args })) as { structuredContent?: Record<string, unknown>; content: Array<{ text: string }> };
    return (res.structuredContent ?? (JSON.parse(res.content[0].text) as Record<string, unknown>)) as Record<string, unknown>;
  };

  /** One run of the case: the usual two calls, or others. */
  const logRun = async (run: string, tools: string[] = ['get_balance', 'send_money'], output = 'Paid invoice INV-7: 420.00 sent, balance confirmed.', evaluate = true): Promise<Record<string, unknown>> =>
    call('log_trace', {
      agent_name: 'payer',
      input: 'Pay the open invoice and confirm the balance.',
      output,
      run,
      case_key: 'pay-invoice',
      tool_calls: tools.map((tool_name) => ({ tool_name, input: { invoice: 'INV-7' }, output: 'ok' })),
      evaluate,
    });

  const rows = (response: Record<string, unknown>): Map<string, RuleRow> => {
    const evaluation = (response.evaluation ?? response) as { rule_results: RuleRow[] };
    return new Map(evaluation.rule_results.map((r) => [r.ruleName, r]));
  };

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
      for (const name of ['no_unusual_action', 'no_dropped_step', 'no_dropped_specific']) expect(r.get(name)?.state, `${run} ${name}`).toBe('not_checked');
    }
    const fourth = rows(await logRun('nightly-4'));
    expect(fourth.get('no_unusual_action')?.state).toBe('pass');
    expect(fourth.get('no_dropped_step')?.state).toBe('pass');
    expect(fourth.get('no_dropped_specific')?.state).toBe('pass');
  });

  it('a run that takes an action the earlier runs never took, drops a step they took and loses their figure is told all three, and its verdict does not move', async () => {
    for (const run of ['nightly-1', 'nightly-2', 'nightly-3', 'nightly-4']) await logRun(run);
    const usual = await logRun('nightly-5');
    const odd = await logRun('nightly-6', ['get_balance', 'delete_account'], 'The invoice was handled.');
    const r = rows(odd);
    expect(r.get('no_unusual_action')).toMatchObject({ state: 'fail', message: 'Unusual action for this case: delete_account, called in 0 of 5 earlier runs' });
    expect(r.get('no_dropped_step')).toMatchObject({ state: 'fail', message: 'Dropped step for this case: send_money, called in 5 of 5 earlier runs, and not in this one' });
    expect(r.get('no_dropped_specific')?.state).toBe('fail');
    expect(r.get('no_dropped_specific')?.message).toContain('carried by 5 of 5 earlier answers');
    // The figure and the identifier are the earlier runs' text: reported by kind, never copied.
    // (A trace id is 32 hex characters and may hold any digits, so it is taken out before the figure is looked for.)
    const said = (r.get('no_dropped_specific')?.message ?? '').replace(/trace [0-9a-f]{32}/g, 'trace <id>');
    expect(said).toBe('Dropped specific for this case: a 3-digit number carried by 5 of 5 earlier answers (trace <id> carries it); an identifier of 5 characters carried by 5 of 5 earlier answers (trace <id> carries it), and not by this one');
    expect(said).not.toContain('420');
    expect(said.toLowerCase()).not.toContain('inv-7');
    // Measurements: they report, and the verdict is what it is without them.
    const verdictOf = (x: Record<string, unknown>): unknown => ((x.evaluation ?? x) as { verdict: { state: string } }).verdict.state;
    expect(verdictOf(odd)).toBe(verdictOf(usual));
  });

  it('evaluate_output with a trace_id reads the same history; with none it has none', async () => {
    for (const run of ['nightly-1', 'nightly-2', 'nightly-3']) await logRun(run);
    const logged = await call('log_trace', {
      agent_name: 'payer',
      input: 'Pay the open invoice and confirm the balance.',
      output: 'Paid invoice INV-7: 420.00 sent, balance confirmed.',
      case_key: 'pay-invoice',
      tool_calls: [{ tool_name: 'get_balance', input: {}, output: 'ok' }, { tool_name: 'delete_account', input: {}, output: 'ok' }],
    });
    const linked = rows(await call('evaluate_output', { trace_id: logged.trace_id as string }));
    expect(linked.get('no_unusual_action')?.state).toBe('fail');
    const bare = rows(await call('evaluate_output', { output: 'Paid invoice INV-7: 420.00 sent.', input: 'Pay the open invoice and confirm the balance.', tool_calls: [{ tool_name: 'delete_account', input: {}, output: 'ok' }] }));
    expect(bare.get('no_unusual_action')).toMatchObject({ state: 'not_checked' });
    expect(bare.get('no_unusual_action')?.skipReason).toContain('insufficient_history: 0 earlier runs');
  });

  it('evaluate_runs re-scores a run against the same earlier runs: a run is never part of its own history, and later runs are not read', async () => {
    for (const run of ['nightly-1', 'nightly-2', 'nightly-3']) await logRun(run);
    // Stored and not judged, so the re-scoring below is its first evaluation.
    await logRun('nightly-4', ['get_balance', 'delete_account'], undefined, false);
    // Runs logged after it call delete_account too; read as history they would make it usual.
    for (const run of ['nightly-5', 'nightly-6', 'nightly-7', 'nightly-8']) await logRun(run, ['get_balance', 'send_money', 'delete_account']);
    const out = await call('evaluate_runs', { run: 'nightly-4' });
    const results = await storage.getRunResults(LOCAL_TENANT, out.run as string);
    expect(results).toHaveLength(1);
    expect(results[0].failedRules).toContain('no_unusual_action');
  });

  it('a case key derived from the input is a case: the same ask, sent with no key, is read against its earlier runs', async () => {
    const send = (tools: string[]): Promise<Record<string, unknown>> =>
      call('log_trace', { agent_name: 'payer', input: 'Close the ticket and notify the customer.', output: 'Closed and notified.', tool_calls: tools.map((tool_name) => ({ tool_name, input: {}, output: 'ok' })), evaluate: true });
    for (let i = 0; i < 3; i += 1) await send(['close_ticket', 'send_email']);
    const r = rows(await send(['close_ticket', 'send_email', 'refund_order']));
    expect(r.get('no_unusual_action')).toMatchObject({ state: 'fail', message: 'Unusual action for this case: refund_order, called in 0 of 3 earlier runs' });
  });
});
