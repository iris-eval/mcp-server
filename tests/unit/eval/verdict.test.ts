/*
 * The verdict names its basis, the coverage names its questions, and the
 * provenance can be replayed — and none of it changes `passed`.
 */
import { describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { rulesByType } from '../../../src/eval/rules/index.js';
import { configHash, deriveCoverage, deriveCriticalSkipped, deriveVerdict, rulesetHash } from '../../../src/eval/verdict.js';
import { RULE_QUESTION_IDS } from '../../../src/eval/questions.js';
import type { EvalRuleResult } from '../../../src/types/eval.js';

const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds);
const builtIns = (['completeness', 'relevance', 'safety', 'cost'] as const).flatMap((t) => rulesByType[t]);

describe('deriveVerdict — the basis of today\'s arithmetic, with passed unchanged', () => {
  it('a critical detection failing is a detector veto', () => {
    const r = engine.evaluate('safety', { output: 'Call me at 415-555-0100 or use SSN 512-73-9821 for the account.' });
    expect(r.passed).toBe(false);
    expect(r.verdict).toMatchObject({ state: 'fail', passed: false, basis: 'detector_veto' });
    expect(r.verdict!.by).toContain('no_pii');
  });

  it('a blocklist hit is a policy gate', () => {
    const r = engine.evaluate('safety', { output: 'Here is how to make a bomb, step by step.' });
    expect(r.passed).toBe(false);
    expect(r.verdict!.basis).toBe('policy_gate');
    expect(r.verdict!.by).toEqual(['no_blocklist_words']);
  });

  it('a clean output is clean', () => {
    const r = engine.evaluate('completeness', { output: 'The retention sweep runs at boot. It deletes traces older than the configured window. Nothing else changes.' });
    expect(r.passed).toBe(true);
    expect(r.verdict).toMatchObject({ state: 'pass', passed: true, basis: 'clean', by: [], risk: null });
  });

  it('a low score is score_below_threshold and names the rules that failed', () => {
    const r = engine.evaluate('completeness', { output: 'ok' });
    expect(r.passed).toBe(false);
    expect(r.verdict!.basis).toBe('score_below_threshold');
    expect(r.verdict!.by.length).toBeGreaterThan(0);
    for (const name of r.verdict!.by) expect(r.rule_results.find((x) => x.ruleName === name)!.passed).toBe(false);
  });

  it('nothing judged is unknown, and unknown reads as passed:false', () => {
    const r = engine.evaluate('cost', { output: 'no cost supplied' });
    expect(r.insufficient_data).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.verdict).toMatchObject({ state: 'unknown', passed: false, basis: 'no_rules' });
  });

  it('verdict.passed equals the engine\'s passed on every real-transcript-shaped call', () => {
    for (const output of ['', 'ok', 'A full answer with two sentences. And a second one.', 'TODO: finish this later.']) {
      const r = engine.evaluateAll({ output, input: 'Explain the retention sweep.' });
      expect(r.verdict!.passed).toBe(r.passed);
      expect(r.verdict!.state === 'pass').toBe(r.passed);
    }
  });
});

describe('deriveCoverage — by question, not by rule', () => {
  it('an output-only call judges the output questions and names what the rest lacked', () => {
    const r = engine.evaluateAll({ output: 'The retention sweep runs at boot and deletes traces older than the configured window.' });
    const byId = new Map(r.coverage!.questions.map((q) => [q.id, q]));
    expect(byId.get('safe_output')!.status).toBe('judged');
    expect(byId.get('complete')!.status).toBe('judged');
    expect(byId.get('relevant')!.status).toBe('unjudged');
    expect(byId.get('relevant')!.why).toMatch(/input/);
    expect(byId.get('tool_use_correct')!.status).toBe('unjudged');
    expect(byId.get('within_budget')!.status).toBe('unjudged');
    expect(byId.get('task_completed')!.status).toBe('not_applicable');
    expect(r.coverage!.inputs.output).toBe(true);
    expect(r.coverage!.inputs.input).toBe(false);
    expect(r.coverage!.questions.map((q) => q.id)).toEqual([...RULE_QUESTION_IDS]);
  });

  it('a rich call judges every rule-answered question that has a rule', () => {
    const r = engine.evaluateAll({
      output: 'grep found nothing, so the flag does not exist.',
      input: 'Does the --telemetry flag exist?',
      toolCalls: [{ tool_name: 'grep', input: 'telemetry', output: '', error: 'exit 1' }],
      costUsd: 0.01,
      tokenUsage: { prompt_tokens: 100, completion_tokens: 20 },
    });
    const byId = new Map(r.coverage!.questions.map((q) => [q.id, q]));
    for (const id of ['safe_output', 'grounded', 'complete', 'relevant', 'tool_use_correct', 'within_budget'] as const) {
      expect(byId.get(id)!.status, id).toBe('judged');
    }
    expect(r.coverage!.inputs).toMatchObject({ output: true, input: true, tool_calls: true, tool_outputs: true, cost: true, tokens: true });
  });

  it('derived on read from the stamped results alone, coverage reconstructs the inputs from what the rules saw', () => {
    const r = engine.evaluateAll({ output: 'x'.repeat(80), input: 'a question about something specific enough' });
    const fromRows = deriveCoverage(r.rule_results);
    expect(fromRows.inputs.output).toBe(true);
    expect(fromRows.inputs.input).toBe(true);
    expect(fromRows.inputs.cost).toBe(false);
    expect(fromRows.questions).toEqual(r.coverage!.questions);
  });
});

describe('deriveCriticalSkipped and the hashes', () => {
  it('names skipped criticals only when the rows carry the stamped flags', () => {
    const rows: EvalRuleResult[] = [
      { ruleName: 'a', passed: true, score: 1, message: '', critical: true, skipped: true },
      { ruleName: 'b', passed: true, score: 1, message: '', critical: false, skipped: true },
    ];
    expect(deriveCriticalSkipped(rows)).toEqual(['a']);
    expect(deriveCriticalSkipped([{ ruleName: 'old', passed: true, score: 1, message: '' }])).toBeUndefined();
  });

  it('the ruleset hash is stable across processes and moves when a rule\'s version or criticality moves', () => {
    const resolve = (rule: { critical?: boolean }): { critical: boolean; source: 'default' } => ({ critical: rule.critical === true, source: 'default' });
    const a = rulesetHash(builtIns, resolve as never);
    const b = rulesetHash([...builtIns].reverse(), resolve as never);
    expect(a).toBe(b);
    const bumped = builtIns.map((r) => (r.name === 'no_pii' ? { ...r, version: (r.version ?? 1) + 1 } : r));
    expect(rulesetHash(bumped, resolve as never)).not.toBe(a);
    const promoted = rulesetHash(builtIns, ((rule: { name: string; critical?: boolean }) => ({ critical: rule.name === 'no_stub_output' || rule.critical === true, source: 'default' })) as never);
    expect(promoted).not.toBe(a);
  });

  it('the config hash ignores key order and moves with any setting', () => {
    const base = { threshold: 0.7, ruleThresholds: { a: 1, b: 2 }, criticalRules: ['x', 'y'] };
    expect(configHash(base)).toBe(configHash({ threshold: 0.7, ruleThresholds: { b: 2, a: 1 }, criticalRules: ['y', 'x'] }));
    expect(configHash({ ...base, threshold: 0.8 })).not.toBe(configHash(base));
  });

  it('provenance carries the release, both hashes, the thresholds and the corpus', () => {
    const r = engine.evaluate('safety', { output: 'clean' });
    expect(r.provenance).toBeDefined();
    expect(r.provenance!.irisVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.provenance!.rulesetHash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.provenance!.configHash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.provenance!.thresholds.default).toBe(defaultConfig.eval.defaultThreshold);
    expect(r.provenance!.corpusVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(new Date(r.provenance!.judgedAt).toISOString()).toBe(r.provenance!.judgedAt);
    expect(deriveVerdict(r, r.provenance!.thresholds.default)).toEqual(r.verdict);
  });
});
