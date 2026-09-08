/*
 * thresholdSource is where the number CAME FROM, never what it equals.
 *
 * Three rules derived it by comparing the value to the shipped number, so a
 * deployment that deliberately set the shipped number was demoted to
 * advisory. max_steps read presence in customConfig, which the engine's
 * merge of the shipped thresholds defeats, so it GATED at the shipped
 * default while its own message and every surface said it advised. Each
 * case here fails on the old code.
 */
import { describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';

const LONG = 'A fine answer that is long enough to pass the length floor, in two sentences. It says something concrete.';
const calls = (n: number) => Array.from({ length: n }, (_, i) => ({ tool_name: 'read_file', input: { path: `f${i}.ts` }, output: 'ok' }));

describe('thresholdSource comes from the engine, not from value equality', () => {
  it('a deployment that sets cost_threshold to the shipped number has set it: the rule gates', async () => {
    const engine = new EvalEngine(0.7, { ...defaultConfig.eval.ruleThresholds, cost_threshold: 0.1 }, { ...defaultConfig.eval, configuredThresholdKeys: ['cost_threshold'] });
    const r = await engine.evaluateAll({ output: LONG, costUsd: 0.2 });
    const cost = r.rule_results.find((x) => x.ruleName === 'cost_under_threshold')!;
    const ev = cost.evidence!.find((e) => e.type === 'count') as { thresholdSource?: string };
    expect(ev.thresholdSource).toBe('config');
    expect(r.verdict!.basis).toBe('policy_gate');
    expect(r.passed).toBe(false);
  });

  it('the same number left as the shipped default advises, and the response says why', async () => {
    const engine = new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const r = await engine.evaluateAll({ output: LONG, costUsd: 0.2 });
    const cost = r.rule_results.find((x) => x.ruleName === 'cost_under_threshold')!;
    const ev = cost.evidence!.find((e) => e.type === 'count') as { thresholdSource?: string };
    expect(ev.thresholdSource).toBe('default');
    expect(cost.passed).toBe(false);
    expect(cost.role).toBe('advisory');
    expect(r.verdict!.basis).not.toBe('policy_gate');
    const note = r.interpretations!.find((i) => i.rule === 'cost_under_threshold');
    expect(note?.configKey).toBe('eval.defaultsGate');
  });

  it('max_steps at the shipped default advises — it gated, because the engine merges the shipped thresholds into customConfig', async () => {
    const engine = new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const r = await engine.evaluateAll({ output: LONG, toolCalls: calls(51) });
    const steps = r.rule_results.find((x) => x.ruleName === 'max_steps')!;
    expect(steps.passed).toBe(false);
    const ev = steps.evidence!.find((e) => e.type === 'count') as { thresholdSource?: string };
    expect(ev.thresholdSource).toBe('default');
    expect(steps.role).toBe('advisory');
    expect(steps.message).toContain('the shipped default');
    expect(r.verdict!.basis).not.toBe('policy_gate');
  });

  it('max_steps the deployment set gates', async () => {
    const engine = new EvalEngine(0.7, { ...defaultConfig.eval.ruleThresholds, max_steps: 50 }, { ...defaultConfig.eval, configuredThresholdKeys: ['max_steps'] });
    const r = await engine.evaluateAll({ output: LONG, toolCalls: calls(51) });
    expect(r.verdict!.basis).toBe('policy_gate');
    expect(r.verdict!.by).toContain('max_steps');
  });

  it('a customConfig on the context is the caller having configured it', async () => {
    const engine = new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const r = await engine.evaluateAll({ output: LONG, costUsd: 0.2, customConfig: { cost_threshold: 0.1 } });
    const ev = r.rule_results.find((x) => x.ruleName === 'cost_under_threshold')!.evidence!.find((e) => e.type === 'count') as { thresholdSource?: string };
    expect(ev.thresholdSource).toBe('config');
  });
});
