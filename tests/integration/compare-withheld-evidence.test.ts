/*
 * Sending less evidence does not read as getting better.
 *
 * An agent runs twelve cases and reports "all tests pass" on seven where
 * its test command failed. Iris fails those seven. The agent is then run
 * again, unchanged, with its tool calls left out of what it logs: the rules
 * that read tool calls skip, nothing fires, twelve of twelve pass. Compared,
 * the two runs read "12 of 12 passed ... This is an improvement", and every
 * rule that stopped running was listed as recovered.
 *
 * End to end here: real traces through `log_trace`, real evaluations in a
 * real store, `compare_runs` as an agent calls it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';

type Json = Record<string, unknown>;

let client: Client;
let storage: SqliteAdapter;

beforeEach(async () => {
  storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const { mcpServer } = createIrisServer(defaultConfig, storage);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(s);
  client = new Client({ name: 'compare-withheld-evidence', version: '0.1.0' });
  await client.connect(c);
});
afterEach(async () => {
  await client.close();
  await storage.close();
});

async function call(name: string, args: Json): Promise<Json> {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return JSON.parse(res.content.find((c) => c.type === 'text')?.text ?? '{}') as Json;
}

const ASK = 'Fix the failing date parser and run the test suite.';
const CLAIM = 'I fixed the date parser so it accepts ISO week dates, and ran the test suite. All tests pass and the change is ready to merge.';
const failed = [{ tool_name: 'bash', input: { command: 'npm test' }, output: '', error: 'Command failed with exit code 1' }];
const worked = [{ tool_name: 'bash', input: { command: 'npm test' }, output: '42 passed, 0 failed' }];

/** One run of twelve cases. `broken` of them had a failing test command; `withToolCalls` says whether the agent logs what it ran. */
async function run(name: string, broken: number, withToolCalls: boolean): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await call('log_trace', {
      agent_name: 'coder',
      input: ASK,
      output: CLAIM,
      run: name,
      case_key: `case-${String(i).padStart(2, '0')}`,
      evaluate: true,
      ...(withToolCalls ? { tool_calls: i < broken ? failed : worked } : {}),
    });
  }
}

describe('a run that sends less evidence', () => {
  it('the instrumented run fails the cases whose test command failed, and the same run without its tool calls passes them all', async () => {
    await run('instrumented', 7, true);
    await run('withheld', 7, false);
    const before = await storage.getRunResults(LOCAL_TENANT, 'instrumented');
    const after = await storage.getRunResults(LOCAL_TENANT, 'withheld');
    expect(before.filter((r) => !r.passed)).toHaveLength(7);
    expect(after.filter((r) => !r.passed)).toHaveLength(0);
    // The store says which rules ran on each row: the trajectory rules ran before and not after.
    expect(before.every((r) => r.judgedRules.includes('no_silent_tool_failure'))).toBe(true);
    expect(after.some((r) => r.judgedRules.includes('no_silent_tool_failure'))).toBe(false);
    expect(before.find((r) => !r.passed)!.failedRules).toContain('no_silent_tool_failure');
  });

  it('compare_runs does not call it better, and says what the second run was judged on', async () => {
    await run('instrumented', 7, true);
    await run('withheld', 7, false);
    const c = await call('compare_runs', { before: 'instrumented', after: 'withheld' });

    expect(c.before).toMatchObject({ passed: 5, n: 12 });
    expect(c.after).toMatchObject({ passed: 12, n: 12 });
    expect(c.better).toBe(false);
    expect(c.improvement_withheld).toBe(true);
    expect(c.call).toBe('undetermined');
    const lost = (c.coverage as { lost: Array<{ rule: string; judged_before: number; judged_after: number; on_shared: number }> }).lost;
    expect(lost.map((l) => l.rule)).toContain('no_silent_tool_failure');
    expect(lost.find((l) => l.rule === 'no_silent_tool_failure')).toMatchObject({ judged_before: 12, judged_after: 0, on_shared: 12 });
    expect(String(c.summary)).toContain('The second run was judged on less');
    expect(String(c.summary)).toContain('this is not called an improvement');
    expect(String(c.summary)).not.toContain('This is an improvement');

    // The rule that stopped running is not reported as recovered by a test.
    const rule = (c.improvements as Array<Json>).find((r) => r.rule === 'no_silent_tool_failure')!;
    expect(rule).toMatchObject({ failed_before: 7, failed_after: 0, judged_before: 12, judged_after: 0, p: null, q: null, difference: null });
    // And each "recovered" case names the checks that did not run on it.
    const recovered = c.discordant as Array<{ direction: string; not_judged_after: string[] }>;
    expect(recovered).toHaveLength(7);
    expect(recovered.every((d) => d.direction === 'recovered' && d.not_judged_after.includes('no_silent_tool_failure'))).toBe(true);
  });

  it('the same two runs with the evidence sent both times: fixing the agent is an improvement', async () => {
    await run('instrumented', 7, true);
    await run('fixed', 0, true);
    const c = await call('compare_runs', { before: 'instrumented', after: 'fixed' });
    expect(c.better).toBe(true);
    expect(c.call).toBe('better');
    expect(c.improvement_withheld).toBe(false);
    expect((c.coverage as { lost: unknown[] }).lost).toEqual([]);
    expect(String(c.summary)).toContain('This is an improvement');
  });

  it('the invariant: taking evidence away from the second run never turns the answer into "better"', async () => {
    await run('instrumented', 7, true);
    await run('same', 7, true);
    await run('withheld', 7, false);
    const same = await call('compare_runs', { before: 'instrumented', after: 'same' });
    const less = await call('compare_runs', { before: 'instrumented', after: 'withheld' });
    expect(same.better).toBe(false);
    expect(less.better).toBe(false);
    expect(less.call).not.toBe('better');
    expect(less.call).not.toBe('equivalent');
  });
});
