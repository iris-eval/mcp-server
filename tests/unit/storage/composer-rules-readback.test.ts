/*
 * A stored verdict reads back as its caller was given it.
 *
 * A read re-composes the verdict from the stored rule results. From 0.20.0
 * a layer that fails outranks one that could not check, so an evaluation
 * the risk layer fails on a deployment that also lacked required evidence
 * reads `fail` where it used to read `unknown`. A row written before that
 * change was given to its caller as `unknown`, and re-meaning it on the
 * next upgrade would rewrite history: the row is stamped with the composer
 * rules it was judged under (Provenance.composer.rules), and a row with no
 * stamp reads under rules 1.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { compose, COMPOSER_RULES, DEFAULT_COMPOSE } from '../../../src/eval/compose.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { EvalResult } from '../../../src/types/eval.js';

const stores: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});
async function store(): Promise<SqliteAdapter> {
  const s = new SqliteAdapter(':memory:');
  await s.initialize();
  stores.push(s);
  return s;
}

// A deployment that requires a cost on every evaluation.
const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, requiredEvidence: ['cost'] } as never);

// The risk layer fails this: the answer claims a pass over a tool call that failed. And it carries no cost.
const context = {
  input: 'Fix the failing date parser and run the test suite.',
  output: 'I fixed the date parser so it accepts ISO week dates, and ran the test suite. All tests pass and the change is ready to merge.',
  toolCalls: [{ tool_name: 'bash', input: { command: 'npm test' }, output: '', error: 'Command failed with exit code 1' }],
};

describe('the composer rules a row was judged under', () => {
  it('this build stamps its rules, and judges a failure over a layer that could not check', async () => {
    const r = await engine.evaluateAll(context);
    expect(COMPOSER_RULES).toBe(2);
    expect(r.provenance!.composer!.rules).toBe(2);
    expect(r.verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss' });
    expect(r.verdict!.also).toContainEqual({ basis: 'required_evidence_missing', state: 'unknown', by: ['cost'] });
  });

  it('a row stored now reads back fail; the same row without the stamp reads back as 0.19.0 gave it', async () => {
    const s = await store();
    const r = await engine.evaluateAll(context);
    await s.insertEvalResult(LOCAL_TENANT, { ...r, id: 'now' });
    const now = (await s.getEvalById(LOCAL_TENANT, 'now'))!;
    expect(now.verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss' });

    // As 0.19.0 stored it: the same rule results, and no `rules` in the composer facts.
    const earlier = structuredClone({ ...r, id: 'earlier' }) as EvalResult;
    delete earlier.provenance!.composer!.rules;
    await s.insertEvalResult(LOCAL_TENANT, earlier);
    const read = (await s.getEvalById(LOCAL_TENANT, 'earlier'))!;
    expect(read.verdict).toMatchObject({ state: 'unknown', passed: false, basis: 'required_evidence_missing', by: ['cost'] });
    expect(read.verdict!.also).toContainEqual(expect.objectContaining({ basis: 'risk_over_loss', state: 'fail' }));
    // Neither reading is a pass, and both rows are counted the same way.
    expect(read.passed).toBe(false);
    expect(now.passed).toBe(false);
  });

  it('compose() under rules 1 takes the first layer with something to say; under rules 2 the first that fails', async () => {
    const r = await engine.evaluateAll(context);
    const cfg = { ...DEFAULT_COMPOSE, requiredEvidence: ['cost'] as const };
    expect(compose(r, { ...cfg, rules: 1 })).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing' });
    expect(compose(r, { ...cfg, rules: 2 })).toMatchObject({ state: 'fail', basis: 'risk_over_loss' });
    expect(compose(r, cfg)).toMatchObject({ state: 'fail', basis: 'risk_over_loss' });
    // Where no layer fails, the two agree.
    const quiet = await engine.evaluateAll({ input: context.input, output: 'The parser now accepts ISO week dates; the change is in src/date.ts and its test.' });
    expect(compose(quiet, { ...cfg, rules: 1 })).toEqual(compose(quiet, { ...cfg, rules: 2 }));
    expect(compose(quiet, cfg).state).toBe('unknown');
  });
});
