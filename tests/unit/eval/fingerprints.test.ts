/*
 * The two fingerprints change when what judges changes.
 *
 * A verdict carries `rulesetHash` and `configHash`, and compare_runs calls
 * two runs comparable when they match. Neither covered what it claimed to:
 *
 *   - the ruleset hash named a deployed rule by its name alone, so a rule
 *     replaced by one that checks nothing kept the hash of the rule it
 *     replaced, while the same output went from fail to pass;
 *   - the configuration hash left out every composer setting, so gating on
 *     shipped defaults, a different loss ratio, a different handling of a
 *     critical check that could not answer, required evidence and an
 *     estimated prior all flipped verdicts under one hash.
 *
 * And a stored verdict that was `unknown` for missing required evidence
 * read back as a pass, because the setting was not stored with the row.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { createCustomRule, ruleContentHash } from '../../../src/eval/rules/custom.js';
import { configHash, rulesetHash } from '../../../src/eval/verdict.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { CustomRuleDefinition, EvalRule } from '../../../src/types/eval.js';

const OUTPUT = 'Our plan beats Acme on every axis, and that is the whole of it. Nothing else changed this week.';
const BLOCKS: CustomRuleDefinition = { name: 'no-competitor', type: 'regex_no_match', config: { pattern: 'Acme' } };
const NO_OP: CustomRuleDefinition = { name: 'no-competitor', type: 'regex_no_match', config: { pattern: 'zzzz-never-present' } };
const notCritical = () => ({ critical: false, source: 'default' as const });

async function verdictUnder(definition: CustomRuleDefinition, overrides: ConstructorParameters<typeof EvalEngine>[2] = {}) {
  const engine = new EvalEngine(0.7, undefined, overrides);
  engine.registerRule('custom', createCustomRule(definition, 'high'), 'rule-1');
  return engine.evaluateAll({ output: OUTPUT, input: 'How does the plan compare?' });
}

describe('the ruleset hash covers what a deployed rule is', () => {
  it('a rule swapped for one that checks nothing, under the same name, changes the hash with the verdict', async () => {
    const before = await verdictUnder(BLOCKS);
    const after = await verdictUnder(NO_OP);
    expect(before.passed).toBe(false);
    expect(after.passed).toBe(true);
    expect(after.provenance!.rulesetHash).not.toBe(before.provenance!.rulesetHash);
  });

  it('the same rule at another severity is another rule', () => {
    expect(ruleContentHash(BLOCKS, 'high')).not.toBe(ruleContentHash(BLOCKS, 'low'));
    expect(createCustomRule(BLOCKS, 'high').contentHash).toBe(ruleContentHash(BLOCKS, 'high'));
  });

  it('a definition hashes the same however its keys are ordered', () => {
    const reordered = { config: { pattern: 'Acme' }, type: 'regex_no_match', name: 'no-competitor' } as CustomRuleDefinition;
    expect(ruleContentHash(reordered, 'high')).toBe(ruleContentHash(BLOCKS, 'high'));
  });

  it('a ruleset with no supplied rule hashes exactly as it did: the content hash is appended only where there is one', () => {
    const builtIn = [{ name: 'a', version: 2, kind: 'detection', weight: 1 }, { name: 'b', version: 1, kind: 'policy', weight: 2 }] as unknown as EvalRule[];
    const withContent = [...builtIn, { name: 'c', version: 1, kind: 'policy', weight: 1, contentHash: 'abc' }] as unknown as EvalRule[];
    const withoutContent = [...builtIn, { name: 'c', version: 1, kind: 'policy', weight: 1 }] as unknown as EvalRule[];
    // The five-field tuple is what every earlier release hashed.
    expect(rulesetHash(builtIn, notCritical)).toBe(rulesetHash(builtIn.map((r) => ({ ...r })) as EvalRule[], notCritical));
    expect(rulesetHash(withContent, notCritical)).not.toBe(rulesetHash(withoutContent, notCritical));
  });
});

describe('the configuration hash covers every setting that decides a verdict', () => {
  const base = { threshold: 0.7 };
  const shipped = { defaultsGate: false, falsePassCost: 1, onCriticalSkipped: 'unknown', requiredEvidence: [] as string[], prior: 0.5, priorSource: 'default', priorMode: 'per-output' };

  it('a deployment that set none of them hashes exactly as it did', () => {
    expect(configHash({ ...base, composer: shipped })).toBe(configHash(base));
  });

  it.each([
    ['gating on shipped defaults', { defaultsGate: true }],
    ['the loss ratio', { falsePassCost: 9 }],
    ['what a critical check that could not answer does', { onCriticalSkipped: 'pass' }],
    ['the evidence required', { requiredEvidence: ['tool_calls'] }],
    ['a prior the deployment set', { prior: 0.2, priorSource: 'config' }],
    ['a prior estimated from its labels', { prior: 0.0368, priorSource: 'estimated' }],
    ['how the prior is spread', { priorMode: 'per-class' }],
  ])('%s changes it', (_name, moved) => {
    expect(configHash({ ...base, composer: { ...shipped, ...moved } })).not.toBe(configHash(base));
  });

  it('two estimated priors are two configurations: a run before the labels and one after are not the same measurement', () => {
    const a = configHash({ ...base, composer: { ...shipped, prior: 0.11, priorSource: 'estimated' } });
    const b = configHash({ ...base, composer: { ...shipped, prior: 0.04, priorSource: 'estimated' } });
    expect(a).not.toBe(b);
  });

  it('the engine stamps it: the same output passes and fails under two settings, and the two verdicts carry two hashes', async () => {
    const context = { output: 'Yes.', input: 'Do you ship to Canada, and what does it cost?', costUsd: 5 };
    const advises = await new EvalEngine(0.7).evaluateAll(context);
    const gates = await new EvalEngine(0.7, undefined, { defaultsGate: true }).evaluateAll(context);
    expect(advises.passed).not.toBe(gates.passed);
    expect(advises.provenance!.configHash).not.toBe(gates.provenance!.configHash);
    expect(advises.provenance!.configHash).toBe(configHash(base));
  });
});

describe('a stored verdict reads back under the settings it was given with', () => {
  const stores: SqliteAdapter[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.close();
  });

  it('unknown for missing required evidence stays unknown on read', async () => {
    const engine = new EvalEngine(0.7, undefined, { requiredEvidence: ['tool_calls'] });
    const result = await engine.evaluateAll({ output: 'The refund window is thirty days from purchase, and it applies to every plan.', input: 'What is the refund window?' });
    expect(result.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
    expect(result.provenance!.composer!.requiredEvidence).toEqual(['tool_calls']);

    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    stores.push(storage);
    await storage.insertEvalResult(LOCAL_TENANT, result);
    const read = await storage.getEvalById(LOCAL_TENANT, result.id);
    expect(read?.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
    expect(read?.passed).toBe(false);
  });

  it('a deployment that requires none stores no such key', async () => {
    const result = await new EvalEngine(0.7).evaluateAll({ output: 'The refund window is thirty days from purchase, and it applies to every plan.' });
    expect(result.provenance!.composer).not.toHaveProperty('requiredEvidence');
  });
});
