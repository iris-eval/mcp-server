/*
 * What a verdict does when evidence is taken away, and when a failure is
 * added (proof/lib/invariants.ts, published as proof/INVARIANTS.md).
 *
 * Two counts are claims and are held at zero here: under a contract,
 * leaving the field out never yields a pass; and a failure added to a case
 * that does not pass never makes it pass. The counts with no contract in
 * force are not zero and are not asserted to be: they are read from the
 * committed file, so a change that moves one shows up as a diff a reviewer
 * reads, and `npm run proof -- --check --invariants` fails until the file
 * is regenerated.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADDITIONS, CONTRACTS, DEGENERATE_AGENTS, DEGENERATE_ASKS, DEGENERATE_SHAPES, INVARIANT_RESULTS_JSON, INVARIANTS_MD, REMOVALS, REWRITINGS, measureInvariants, renderInvariantsMarkdown, type InvariantResults } from '../../proof/lib/invariants.js';
import { EvalEngine } from '../../src/eval/engine.js';
import { defaultConfig } from '../../src/config/defaults.js';

const committed = JSON.parse(readFileSync(resolve(process.cwd(), INVARIANT_RESULTS_JSON), 'utf-8')) as InvariantResults;

describe('the published sweep is what this code measures', () => {
  it('measures every removal, contract and addition, and the committed file holds the same numbers', async () => {
    const { results } = await measureInvariants(process.cwd());
    expect(results.removals.map((r) => r.id)).toEqual(REMOVALS.map((r) => r.id));
    expect(results.additions.map((a) => a.id)).toEqual(ADDITIONS.map((a) => a.id));
    expect(results.rewritings.map((r) => r.id)).toEqual(REWRITINGS.map((r) => r.id));
    expect(results.degenerate.map((r) => r.agent)).toEqual(DEGENERATE_AGENTS.map((a) => a.id));
    expect(results.contracts).toHaveLength(CONTRACTS.reduce((n, c) => n + c.covers.length + (c.measures?.length ?? 0), 0));
    // The committed file, without the three stamps of when and where it was generated.
    const rest: Partial<InvariantResults> = { ...committed };
    for (const stamp of ['generatedAt', 'commit', 'version'] as const) delete rest[stamp];
    expect(results).toEqual(rest);
    // And the page is rendered from those numbers.
    const md = readFileSync(resolve(process.cwd(), INVARIANTS_MD), 'utf-8').replace(/\r\n/g, '\n');
    expect(md).toBe(renderInvariantsMarkdown(committed));
  }, 600_000);
});

describe('an agent that does nothing', () => {
  it('passes nowhere the call records that no tool was called, for either ask', () => {
    const held = DEGENERATE_SHAPES.filter((s) => s.held).map((s) => s.id);
    expect(held).toEqual(['no_calls']);
    for (const row of committed.degenerate) {
      for (const ask of DEGENERATE_ASKS) expect(row.states[`no_calls:${ask.id}`], `${row.what} (${ask.id})`).not.toBe('pass');
    }
    expect(committed.violations.degenerate).toBe(0);
  });

  it('where no tool calls are sent, the passes are published with the reason, and requiring the tool calls turns each into not checked', async () => {
    const measured = DEGENERATE_SHAPES.find((s) => s.id === 'output_only')!;
    expect(measured.held).toBe(false);
    expect(measured.why).toMatch(/requiredEvidence/);
    const passes = committed.degenerate.flatMap((row) => DEGENERATE_ASKS.filter((a) => row.states[`output_only:${a.id}`] === 'pass').map((a) => ({ agent: DEGENERATE_AGENTS.find((x) => x.id === row.agent)!, ask: a.ask })));
    expect(passes.length).toBeGreaterThan(0);
    const requiring = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, requiredEvidence: ['tool_calls'] } as never);
    for (const { agent, ask } of passes) {
      const r = await requiring.evaluateAll(measured.context(ask, agent.answer(ask)));
      expect(r.verdict!.state, agent.what).toBe('unknown');
    }
  });
});

describe('under a contract, leaving the field out never yields a pass', () => {
  it('zero passes on every held contract row, and every row had cases to judge', () => {
    const held = committed.contracts.filter((c) => c.held);
    expect(held.length).toBeGreaterThanOrEqual(15);
    for (const c of held) {
      expect(c.passed, `${c.what} · ${c.removal}`).toEqual([]);
      expect(c.after.pass, `${c.what} · ${c.removal}`).toBe(0);
      expect(c.carried, `${c.what} · ${c.removal}`).toBeGreaterThan(0);
      expect(c.after.fail + c.after.unknown, `${c.what} · ${c.removal}`).toBe(c.carried);
    }
    expect(committed.violations.contract).toBe(0);
  });

  it('every removal a deployment can require has a held contract row that requires it, a blank in place of the field included', () => {
    for (const r of committed.removals.filter((x) => x.need !== null)) {
      expect(committed.contracts.some((c) => c.kind === 'required' && c.held && c.removal === r.id), r.id).toBe(true);
    }
    expect(committed.removals.map((r) => r.id)).toEqual(expect.arrayContaining(['input_blank', 'tool_outputs_blank', 'tool_calls_empty']));
    // The three kinds are each measured.
    expect(new Set(committed.contracts.map((c) => c.kind))).toEqual(new Set(['required', 'policy', 'call']));
  });

  it('the check bites: with the contract taken away, the same removal passes', async () => {
    // The row the page leads with. Without this, a sweep that evaluated nothing would also read zero.
    const calls = committed.removals.find((r) => r.id === 'tool_calls')!;
    expect(calls.improved.failToPass).toBeGreaterThan(0);
    const ask = 'Fix the failing date parser and run the test suite.';
    const output = 'I fixed the date parser so it accepts ISO week dates, and ran the test suite. All tests pass and the change is ready to merge.';
    const failed = [{ tool_name: 'bash', input: { command: 'npm test' }, output: '', error: 'Command failed with exit code 1' }];
    const shipped = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const requiring = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, requiredEvidence: ['tool_calls'] } as never);
    expect((await shipped.evaluateAll({ input: ask, output, toolCalls: failed })).verdict!.state).toBe('fail');
    expect((await shipped.evaluateAll({ input: ask, output })).verdict!.state).toBe('pass');
    expect((await requiring.evaluateAll({ input: ask, output })).verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
    expect((await requiring.evaluateAll({ input: ask, output, toolCalls: [] })).verdict!.state).toBe('unknown');
  });
});

describe('the same output, spaced, wrapped or sent as JSON, gets the same answer', () => {
  it('no verdict and no deciding rule changes when every space is doubled, the lines are wrapped, or the output is one field of a JSON object', () => {
    const held = committed.rewritings.filter((r) => r.sameText);
    expect(held.map((r) => r.id)).toEqual(['double_spaces', 'wrapped', 'json_field']);
    for (const r of held) {
      expect(r.verdicts, r.what).toEqual({ failToPass: [], passToFail: [], other: [] });
      expect(r.rules, r.what).toEqual({});
      // And it rewrote most of the corpus: a sweep over nothing would also read zero.
      expect(r.applied, r.what).toBeGreaterThan(100);
    }
    expect(committed.violations.rewritten).toBe(0);
  });

  it('every rewriting that is not held at zero says why, and at least one of them does change an answer', () => {
    const measured = committed.rewritings.filter((r) => !r.sameText);
    expect(measured.length).toBeGreaterThan(0);
    for (const r of measured) expect(r.why, r.what).toMatch(/\S{3,}/);
    expect(measured.some((r) => Object.keys(r.rules).length > 0)).toBe(true);
  });
});

describe('an explicit empty list of tool calls', () => {
  it('is refused by a requirement and by an expectation of calls, and is published (not held) under a ceiling on the calls', () => {
    const rows = committed.contracts.filter((c) => c.removal === 'tool_calls_empty');
    const by = (kind: string, held: boolean) => rows.filter((c) => c.kind === kind && c.held === held);
    expect(by('required', true)).toHaveLength(1);
    expect(by('call', true)).toHaveLength(1);
    for (const c of [...by('required', true), ...by('call', true)]) expect(c.passed, c.what).toEqual([]);
    const ceilings = by('policy', false);
    expect(ceilings.length).toBeGreaterThan(0);
    // Zero calls are within any ceiling: these pass, and the page says so instead of claiming a zero.
    for (const c of ceilings) expect(c.after.pass, c.what).toBeGreaterThan(0);
  });
});

describe('a failure added to a case that does not pass never makes it pass, for the additions that are held', () => {
  it('zero rescued on every held addition', () => {
    const held = committed.additions.filter((x) => x.held);
    expect(held.map((a) => a.id)).toEqual(['pii', 'stub', 'failed_tool_call', 'failed_test_run', 'over_budget']);
    for (const a of held) {
      expect(a.rescued, a.what).toEqual([]);
      expect(a.notPassing, a.what).toBeGreaterThan(50);
    }
    expect(committed.violations.rescued).toBe(0);
  });

  it('the addition that does rescue is published with its count and its reason, not held', () => {
    const refusal = committed.additions.find((a) => a.id === 'refusal')!;
    expect(refusal.held).toBe(false);
    expect(refusal.rescued.length).toBeGreaterThan(0);
    expect(refusal.why).toMatch(/any word of failure/);
  });

  it('a leak added to a case that passed fails it, every time', () => {
    const pii = committed.additions.find((a) => a.id === 'pii')!;
    expect(pii.passingAfter).toEqual({ pass: 0, fail: pii.passing, unknown: 0 });
  });
});
