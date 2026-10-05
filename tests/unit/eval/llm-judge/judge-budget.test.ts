/*
 * The daily judge budget and its ledger, below the servers:
 * the ceiling is never passed, a call whose cost is unknown stays counted
 * at its worst case, a refusal before any spend gives the reservation back,
 * the day turns over at 00:00 UTC, tenants are kept apart, and two
 * connections to one database draw on one balance.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_DAILY_BUDGET_USD,
  DEFAULT_MAX_CALLS_PER_REQUEST,
  JudgeBudget,
  dailyBudgetUsd,
  judgeBudgetFromEnv,
  maxCallsPerRequest,
  memoryJudgeSpendLedger,
  nextUtcMidnight,
  utcDay,
  type JudgeSpendLedger,
} from '../../../../src/eval/llm-judge/budget.js';
import { SqliteAdapter } from '../../../../src/storage/sqlite-adapter.js';
import { KNOWN_MIGRATION_IDS } from '../../../../src/storage/migrations/index.js';
import { LOCAL_TENANT, asTenantId } from '../../../../src/types/tenant.js';
import { createRelevanceJudge, relevanceJudgeState, relevanceJudgeStateLine } from '../../../../src/eval/llm-judge/relevance-judge.js';
import { newJudgeRequest } from '../../../../src/eval/llm-judge/budget.js';

const at = (iso: string) => () => new Date(iso);

describe('JudgeBudget', () => {
  it('admits a call only while its worst case fits, and settles to the actual cost', () => {
    const budget = new JudgeBudget({ dailyUsd: 0.01, ledger: memoryJudgeSpendLedger(), now: at('2026-09-28T10:00:00Z') });
    const a = budget.reserve(LOCAL_TENANT, 0.006);
    expect(a.ok).toBe(true);
    // 0.006 held: a second worst case of 0.006 would pass 0.01.
    expect(budget.reserve(LOCAL_TENANT, 0.006).ok).toBe(false);
    if (a.ok) budget.settle(a.ticket, 0.001);
    expect(budget.today(LOCAL_TENANT)).toMatchObject({ spentUsd: 0.001, calls: 1, refused: 1, remainingUsd: 0.009 });
    // Settled down to 0.001, there is room again.
    expect(budget.reserve(LOCAL_TENANT, 0.006).ok).toBe(true);
  });

  it('never passes the budget, over a long run of calls whose actual cost is below the worst case', () => {
    const budget = new JudgeBudget({ dailyUsd: 1, ledger: memoryJudgeSpendLedger(), now: at('2026-09-28T10:00:00Z') });
    let calls = 0;
    for (let i = 0; i < 5000; i++) {
      const r = budget.reserve(LOCAL_TENANT, 0.006);
      if (!r.ok) continue;
      calls++;
      budget.settle(r.ticket, 0.0015 + (i % 7) * 0.0001);
      expect(budget.today(LOCAL_TENANT).spentUsd).toBeLessThanOrEqual(1);
    }
    expect(calls).toBeGreaterThan(165);
    expect(budget.today(LOCAL_TENANT).spentUsd).toBeLessThanOrEqual(1);
    expect(budget.today(LOCAL_TENANT).exhausted).toBe(true);
  });

  it('keeps the worst case counted when the cost is unknown, and gives it back for a call never made', () => {
    const budget = new JudgeBudget({ dailyUsd: 0.02, ledger: memoryJudgeSpendLedger(), now: at('2026-09-28T10:00:00Z') });
    const failed = budget.reserve(LOCAL_TENANT, 0.005);
    if (failed.ok) budget.settle(failed.ticket, null);
    expect(budget.today(LOCAL_TENANT)).toMatchObject({ spentUsd: 0.005, calls: 1 });
    const refused = budget.reserve(LOCAL_TENANT, 0.005);
    if (refused.ok) budget.release(refused.ticket);
    expect(budget.today(LOCAL_TENANT)).toMatchObject({ spentUsd: 0.005, calls: 1 });
  });

  it('turns over at 00:00 UTC, says when, and logs once per tenant per day', () => {
    let now = new Date('2026-09-28T23:59:59Z');
    const lines: string[] = [];
    const budget = new JudgeBudget({ dailyUsd: 0.001, ledger: memoryJudgeSpendLedger(), now: () => now, log: (l) => lines.push(l) });
    const refused = budget.reserve(LOCAL_TENANT, 0.002);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain('resets at 2026-09-29T00:00:00.000Z');
    budget.reserve(LOCAL_TENANT, 0.002);
    expect(lines).toHaveLength(1);
    now = new Date('2026-09-29T00:00:01Z');
    expect(budget.today(LOCAL_TENANT)).toMatchObject({ day: '2026-09-29', spentUsd: 0, refused: 0, exhausted: false });
    expect(budget.reserve(LOCAL_TENANT, 0.0005).ok).toBe(true);
    budget.reserve(LOCAL_TENANT, 0.002);
    expect(lines).toHaveLength(2);
  });

  it('keeps tenants apart', () => {
    const budget = new JudgeBudget({ dailyUsd: 0.01, ledger: memoryJudgeSpendLedger(), now: at('2026-09-28T10:00:00Z') });
    const a = asTenantId('tenant-a');
    const b = asTenantId('tenant-b');
    expect(budget.reserve(a, 0.01).ok).toBe(true);
    expect(budget.reserve(a, 0.001).ok).toBe(false);
    expect(budget.reserve(b, 0.01).ok).toBe(true);
  });

  it('keys days by UTC', () => {
    expect(utcDay(new Date('2026-09-28T23:30:00-05:00'))).toBe('2026-09-29');
    expect(nextUtcMidnight(new Date('2026-12-31T12:00:00Z'))).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('the settings', () => {
  const vars = ['IRIS_LLM_JUDGE_DAILY_BUDGET_USD', 'IRIS_RELEVANCE_JUDGE_DAILY_BUDGET_USD', 'IRIS_RELEVANCE_JUDGE_MAX_CALLS_PER_REQUEST'] as const;
  const saved = Object.fromEntries(vars.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of vars) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('default low, accept what is valid, and fall back to the default with a note for anything else', () => {
    for (const k of vars) delete process.env[k];
    expect(dailyBudgetUsd()).toEqual({ value: DEFAULT_DAILY_BUDGET_USD, source: 'default' });
    expect(maxCallsPerRequest()).toEqual({ value: DEFAULT_MAX_CALLS_PER_REQUEST, source: 'default' });
    expect(DEFAULT_DAILY_BUDGET_USD).toBe(1);
    expect(DEFAULT_MAX_CALLS_PER_REQUEST).toBe(20);

    process.env.IRIS_LLM_JUDGE_DAILY_BUDGET_USD = '2.5';
    process.env.IRIS_RELEVANCE_JUDGE_MAX_CALLS_PER_REQUEST = '0';
    expect(dailyBudgetUsd()).toEqual({ value: 2.5, source: 'env' });
    expect(maxCallsPerRequest()).toEqual({ value: 0, source: 'env' });

    process.env.IRIS_LLM_JUDGE_DAILY_BUDGET_USD = '5$';
    process.env.IRIS_RELEVANCE_JUDGE_MAX_CALLS_PER_REQUEST = '2.5';
    expect(dailyBudgetUsd()).toMatchObject({ value: 1, source: 'default', note: expect.stringMatching(/"5\$" is not a number/) });
    expect(maxCallsPerRequest()).toMatchObject({ value: 20, source: 'default', note: expect.stringMatching(/"2\.5" is not a whole number/) });
  });
});

describe('the old name of the daily budget', () => {
  const vars = ['IRIS_LLM_JUDGE_DAILY_BUDGET_USD', 'IRIS_RELEVANCE_JUDGE_DAILY_BUDGET_USD'] as const;
  const saved = Object.fromEntries(vars.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of vars) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('is read when the new name is unset, and says it now limits every judge call', () => {
    delete process.env.IRIS_LLM_JUDGE_DAILY_BUDGET_USD;
    process.env.IRIS_RELEVANCE_JUDGE_DAILY_BUDGET_USD = '3';
    const s = dailyBudgetUsd();
    expect(s).toMatchObject({ value: 3, source: 'env' });
    expect(s.note).toContain('IRIS_RELEVANCE_JUDGE_DAILY_BUDGET_USD is the old name of IRIS_LLM_JUDGE_DAILY_BUDGET_USD');
    expect(judgeBudgetFromEnv().notes).toEqual([s.note]);
  });

  it('gives way to the new name, silently', () => {
    process.env.IRIS_LLM_JUDGE_DAILY_BUDGET_USD = '0.5';
    process.env.IRIS_RELEVANCE_JUDGE_DAILY_BUDGET_USD = '3';
    expect(dailyBudgetUsd()).toEqual({ value: 0.5, source: 'env' });
    expect(judgeBudgetFromEnv().notes).toEqual([]);
  });

  it('a bad value under the old name is named by that name', () => {
    delete process.env.IRIS_LLM_JUDGE_DAILY_BUDGET_USD;
    process.env.IRIS_RELEVANCE_JUDGE_DAILY_BUDGET_USD = 'lots';
    expect(dailyBudgetUsd()).toMatchObject({ value: 1, source: 'default', note: expect.stringMatching(/^IRIS_RELEVANCE_JUDGE_DAILY_BUDGET_USD="lots"/) });
  });
});

describe('a gate for a caller that makes the call itself', () => {
  it('holds the worst case, settles to the cost, releases a call never made, and refuses past the limit', () => {
    const budget = new JudgeBudget({ dailyUsd: 0.01, ledger: memoryJudgeSpendLedger(), now: () => new Date('2026-10-05T12:00:00Z') });
    const gate = budget.gate(LOCAL_TENANT);
    const a = gate(0.006);
    expect(a.ok).toBe(true);
    if (a.ok) a.settle(0.001);
    expect(budget.today(LOCAL_TENANT)).toMatchObject({ spentUsd: 0.001, calls: 1 });
    const b = gate(0.006);
    expect(b.ok).toBe(true);
    if (b.ok) b.release();
    expect(budget.today(LOCAL_TENANT)).toMatchObject({ spentUsd: 0.001, calls: 1 });
    // A call that failed after the provider may have billed it keeps its worst case.
    const c = gate(0.004);
    if (c.ok) c.settle(null);
    expect(budget.today(LOCAL_TENANT)).toMatchObject({ spentUsd: 0.005, calls: 2 });
    const d = gate(0.006);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/daily judge budget has 0\.0050 of 0\.01 USD left today \(UTC\).*IRIS_LLM_JUDGE_DAILY_BUDGET_USD raises it/);
  });
});

describe('the SQLite ledger', () => {
  let dir: string;
  const adapters: SqliteAdapter[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-judge-ledger-'));
  });
  afterEach(async () => {
    for (const a of adapters.splice(0)) await a.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const open = async (): Promise<SqliteAdapter> => {
    const a = new SqliteAdapter(join(dir, 'iris.db'));
    await a.initialize();
    adapters.push(a);
    return a;
  };

  it('is the seventeenth known migration', () => {
    // The newest migration's test owns the count; this one owns the position.
    expect(KNOWN_MIGRATION_IDS[16]).toBe('017-relevance-judge-spend');
    expect(KNOWN_MIGRATION_IDS[15]).toBe('016-trace-cost-source');
  });

  it('two connections to one file draw on one balance: the second cannot be admitted into what the first holds', async () => {
    const one: JudgeSpendLedger = (await open()).judgeSpendLedger();
    const two: JudgeSpendLedger = (await open()).judgeSpendLedger();
    expect(one.reserve(LOCAL_TENANT, '2026-09-28', 6000, 10000)).toBe(true);
    expect(two.reserve(LOCAL_TENANT, '2026-09-28', 6000, 10000)).toBe(false);
    two.settle(LOCAL_TENANT, '2026-09-28', -4000, true);
    expect(one.read(LOCAL_TENANT, '2026-09-28')).toEqual({ spentMicroUsd: 2000, calls: 1, refused: 1 });
    expect(one.read(LOCAL_TENANT, '2026-09-27')).toEqual({ spentMicroUsd: 0, calls: 0, refused: 0 });
  });

  it('refuses a call with no tenant rather than charging every tenant', async () => {
    const ledger = (await open()).judgeSpendLedger();
    expect(() => ledger.reserve('' as never, '2026-09-28', 1, 10)).toThrow(/relevance judge spend/);
  });
});

describe('the judge itself', () => {
  const evaluate = async () => ({ passed: true, score: 0.9, passThreshold: 0.6, rationale: 'r', dimensions: {}, model: 'claude-haiku-4-5', provider: 'anthropic' as const, template: 'relevance' as const, inputTokens: 900, outputTokens: 60, costUsd: 0.0012, latencyMs: 1 });

  it('counts calls across one request and withholds past the cap, with nothing spent', async () => {
    const judge = createRelevanceJudge({ model: 'claude-haiku-4-5', apiKey: 'k', maxCallsPerRequest: 2, evaluate });
    const request = newJudgeRequest();
    const q = { input: 'What is the refund window?', output: 'Thirty days from delivery.' };
    const records = [await judge.judge(q, { request }), await judge.judge(q, { request }), await judge.judge(q, { request })];
    expect(records.map((r) => r.withheld ?? 'judged')).toEqual(['judged', 'judged', 'request_cap']);
    expect(records[2]).toMatchObject({ costUsd: 0, inputTokens: 0 });
    expect(records[2].error).toContain('IRIS_RELEVANCE_JUDGE_MAX_CALLS_PER_REQUEST=2');
    expect(request).toEqual({ calls: 2, withheld: 1 });
    // No request given: each evaluation is its own request.
    expect((await judge.judge(q)).withheld).toBeUndefined();
  });

  it('describes itself in one line: what it sends, the budget and the cap', () => {
    const judge = createRelevanceJudge({ model: 'claude-haiku-4-5', apiKey: 'k', evaluate });
    const line = relevanceJudgeStateLine(relevanceJudgeState(judge));
    expect(line).toMatch(/sends that input and the output to Anthropic, on your key/);
    expect(line).toMatch(/no_pii rule flags .* replaced/);
    expect(line).toMatch(/budget 1 USD a day per tenant \(UTC\), 0\.0000 spent today/);
    expect(line).toMatch(/at most 20 judge calls per request/);
  });
});
