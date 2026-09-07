import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';

/*
 * Re-scoring a run, over the real MCP surface.
 *
 * The one property worth more than all the others here: the source run is
 * NOT modified. A re-evaluation that overwrote yesterday's verdicts would
 * destroy the baseline the comparison needs, and the loss would be silent —
 * the numbers afterwards look perfectly reasonable, they just answer a
 * different question than the one asked.
 */

describe('evaluate_runs', () => {
  let client: Client;
  let storage: SqliteAdapter;

  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content: Array<{ text: string }>;
    };
    return (res.structuredContent ?? (JSON.parse(res.content[0].text) as Record<string, unknown>)) as Record<string, unknown>;
  };

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const { mcpServer } = createIrisServer(defaultConfig, storage);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: 'evaluate-runs-test', version: '0.1.0' });
    await client.connect(clientTransport);

    for (const n of [1, 2, 3]) {
      await client.callTool({
        name: 'log_trace',
        arguments: {
          agent_name: 'runner',
          input: `question number ${n} about the deployment`,
          output: `A complete answer to question number ${n}, with enough substance to score.`,
          run: 'nightly-1',
          case_key: `case-${n}`,
        },
      });
    }
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
  });

  it('scores a run into a new run and leaves the source untouched', async () => {
    const out = await call('evaluate_runs', { run: 'nightly-1', label: 'rules today' });

    expect(out.source_run).toBe('nightly-1');
    expect(out.run).not.toBe('nightly-1');
    expect(out.traces).toBe(3);
    expect(out.evaluated).toBe(3);
    expect(out.failed).toEqual([]);

    // The new verdicts are in the new run...
    const after = await storage.getRunResults(LOCAL_TENANT, out.run as string);
    expect(after).toHaveLength(3);
    // ...and the source run holds exactly what it held before: nothing, because
    // these traces were logged and never evaluated.
    const before = await storage.getRunResults(LOCAL_TENANT, 'nightly-1');
    expect(before).toHaveLength(0);
  });

  it('records the link back, so a rules change is never read as an agent change', async () => {
    const out = await call('evaluate_runs', { run: 'nightly-1' });
    const run = await storage.getRun(LOCAL_TENANT, out.run as string);
    expect(run?.reevaluationOf).toBe('nightly-1');
  });

  it('does nothing the second time, because the verdicts already came from this ruleset', async () => {
    const first = await call('evaluate_runs', { run: 'nightly-1' });
    expect(first.evaluated).toBe(3);

    const second = await call('evaluate_runs', { run: 'nightly-1' });
    // The default target is derived from the ruleset hash, so a repeat lands
    // in the same run rather than creating a new one each call.
    expect(second.run).toBe(first.run);
    expect(second.evaluated).toBe(0);
    expect(second.already_current).toBe(3);
    expect(second.summary).toContain('nothing new to compare');
  });

  it('refuses to write into the run it is re-evaluating', async () => {
    const out = await call('evaluate_runs', { run: 'nightly-1', into: 'nightly-1' });
    expect((out.error as { code: string }).code).toBe('IRIS_INVALID_ARGUMENT');
    expect((out.error as { message: string }).message).toContain('baseline');
  });

  it('names an empty run rather than reporting a successful no-op', async () => {
    const out = await call('evaluate_runs', { run: 'never-ran' });
    expect((out.error as { code: string }).code).toBe('IRIS_UNKNOWN_TRACE');
    expect((out.error as { recovery: string[] }).recovery.join(' ')).toContain('log_trace');
  });

  it('produces two runs a comparison can read', async () => {
    const reeval = await call('evaluate_runs', { run: 'nightly-1' });
    const cmp = await call('compare_runs', { before: 'nightly-1', after: reeval.run as string });

    // The source run has no evaluations, so there is nothing to compare — and
    // the tool says so rather than inventing a difference from one side.
    expect((cmp.before as { n: number }).n).toBe(0);
    expect((cmp.after as { n: number }).n).toBe(3);
    expect(cmp.worse).toBe(false);
    expect(cmp.better).toBe(false);
  });
});
