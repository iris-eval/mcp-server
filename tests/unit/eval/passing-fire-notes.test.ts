/*
 * What a rule that fired is told when the verdict passed.
 *
 * A fire that did not decide gets a sentence for the operator: why, and what
 * would make it decide. Every such fire used to get one sentence, "on its
 * published accuracy this rule alone does not carry the risk past your loss
 * threshold. Raise eval.falsePassCost", whatever the rule was. A measurement
 * has no published accuracy and is in no estimate, so the reason was not the
 * reason and the setting moved nothing (#988); a plugin's detection has no
 * published family either. The sentence now follows the row's standing, and
 * each sentence's own claim is held here: the setting it names does what it
 * says.
 */
import { describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { localPrecision } from '../../../src/eval/labels.js';
import { roleOf, DEFAULT_COMPOSE } from '../../../src/eval/compose.js';
import type { EvalResult, EvalRule, EvalRuleResult } from '../../../src/types/eval.js';

const engine = (overrides: Partial<typeof defaultConfig.eval> = {}) => new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, ...overrides });
const row = (r: EvalResult, name: string): EvalRuleResult => r.rule_results.find((x) => x.ruleName === name)!;
const told = (r: EvalResult, name: string) => (r.interpretations ?? []).filter((i) => i.rule === name);

const SHORT = { input: 'What is the capital of France?', output: 'The capital of France is Paris.' };
const PARTIAL = {
  input: 'Tell me (1) how many built-in rules there are, (2) which bundle each rule belongs to, and (3) which rules are critical by default.',
  output: 'There are seventeen built-in rules in the registry, and each one belongs to a bundle that the documentation lists by name.',
};
const NAMES = {
  input: 'Which vendor should we compare ourselves with for the quarterly review of pricing?',
  output: 'For the quarterly review of pricing, the closest vendor to compare with is Acme, whose plans are listed publicly and updated every quarter.',
};
/** A plugin's rule as the loader builds it: a detection, not critical, with no published family. */
const pluginDetection = (): EvalRule => ({
  name: 'mentions_competitor',
  description: 'Fires when the output names the competitor.',
  evalType: 'safety',
  weight: 1,
  kind: 'detection',
  mechanism: 'pattern',
  needs: ['output'],
  version: 1,
  origin: 'plugin',
  evaluate: (ctx) => {
    const hit = /\bacme\b/i.test(ctx.output);
    return { ruleName: 'mentions_competitor', passed: !hit, score: hit ? 0 : 1, message: hit ? 'the output names the competitor' : 'no competitor named' };
  },
});

describe('a fired measurement on a verdict that passed', () => {
  it('is told it took no part, and that naming it in eval.criticalRules makes it decide', async () => {
    const result = await engine().evaluateAll(SHORT);
    expect(result.verdict?.state).toBe('pass');
    for (const name of ['min_output_length', 'sentence_count']) {
      expect(row(result, name)).toMatchObject({ passed: false, kind: 'measurement', role: 'advisory' });
      const notes = told(result, name);
      expect(notes, name).toHaveLength(1);
      expect(notes[0], name).toMatchObject({
        severity: 'note',
        addressee: 'operator',
        configKey: 'eval.criticalRules',
        text: `${name} failed and took no part in this verdict: it is a measurement, which reports a number and decides no verdict. Name it in eval.criticalRules to have its failure fail the verdict.`,
      });
      expect(notes[0].text, name).not.toContain('published accuracy');
      expect(notes[0].text, name).not.toContain('falsePassCost');
    }
  });

  it('the setting the sentence names does what the sentence says', async () => {
    const named = await engine({ criticalRules: ['sentence_count'] }).evaluateAll(SHORT);
    expect(named.verdict).toMatchObject({ state: 'fail', basis: 'detector_veto', by: ['sentence_count'] });
  });

  it('and the setting it used to name moves nothing a measurement did', async () => {
    // At a loss ratio of 3 the verdict is what it was, with the measurement's failure or without it.
    const longer = { ...SHORT, output: 'The capital of France is Paris. It has been the seat of the French government for centuries, and it is the largest city in the country.' };
    for (const falsePassCost of [1, 3]) {
      const withFailure = await engine({ falsePassCost }).evaluateAll(SHORT);
      const without = await engine({ falsePassCost }).evaluateAll(longer);
      expect(row(withFailure, 'sentence_count').passed).toBe(false);
      expect(row(without, 'sentence_count').passed).toBe(true);
      expect(withFailure.verdict?.state, String(falsePassCost)).toBe(without.verdict?.state);
      expect(withFailure.verdict?.risk?.pBad, String(falsePassCost)).toBe(without.verdict?.risk?.pBad);
    }
  });
});

describe('a fired rule the risk estimate weighs, on a verdict that passed', () => {
  it('keeps the sentence about its published accuracy and the loss ratio, and the ratio does decide it', async () => {
    const result = await engine().evaluateAll(PARTIAL);
    expect(result.verdict?.state).toBe('pass');
    expect(row(result, 'ask_coverage')).toMatchObject({ passed: false, kind: 'inference', role: 'risk' });
    const notes = told(result, 'ask_coverage');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ configKey: 'eval.falsePassCost' });
    expect(notes[0].text).toContain('ask_coverage failed but the verdict passed: on its published accuracy this rule alone does not carry the risk past your loss threshold. Raise eval.falsePassCost');
    // The fire is in the estimate: the same output with the fire is riskier than the short answer's baseline.
    const baseline = await engine().evaluateAll(SHORT);
    expect(result.verdict!.risk!.pBad).toBeGreaterThan(baseline.verdict!.risk!.pBad);
  });
});

describe("a plugin's detection on a verdict that passed", () => {
  it('reports only: role advisory, and a sentence that says why and what would make it decide', async () => {
    const e = engine();
    e.registerRule('safety', pluginDetection(), 'plugin-mentions-competitor');
    const result = await e.evaluateAll(NAMES);
    expect(result.verdict?.state).toBe('pass');
    expect(row(result, 'mentions_competitor')).toMatchObject({ passed: false, kind: 'detection', origin: 'plugin', role: 'advisory' });
    const notes = told(result, 'mentions_competitor');
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe(
      "mentions_competitor failed and took no part in this verdict: the risk estimate weighs a rule by a published accuracy, and a plugin's rule has none. Its failure is reported and scored. Declare the rule critical in the plugin to have its failure fail the verdict.",
    );
    expect(notes[0].configKey).toBeUndefined();
    // The fire is in no estimate: the verdict carries the risk it carries without the rule.
    const without = await engine().evaluateAll(NAMES);
    expect(result.verdict?.risk?.pBad).toBe(without.verdict?.risk?.pBad);
  });

  it('with twenty labels on its fires it is still told the same: no estimate reads that precision', async () => {
    const e = engine();
    e.registerRule('safety', pluginDetection(), 'plugin-mentions-competitor');
    e.setLocalLabels({
      precision: new Map([['mentions_competitor', localPrecision({ ruleName: 'mentions_competitor', right: 20, wrong: 0 })]]),
      fireRates: new Map([['mentions_competitor', 0.5]]),
      prevalence: [],
      suggestion: null,
      refreshedAt: new Date().toISOString(),
    });
    const result = await e.evaluateAll(NAMES);
    expect(row(result, 'mentions_competitor').uncertainty?.basis).toBe('local_labels');
    const notes = told(result, 'mentions_competitor');
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain('took no part in this verdict');
    expect(notes[0].text).not.toContain('your 20 labels');
    expect(notes[0].text).not.toContain('falsePassCost');
  });

  it('declared critical, it decides, as the sentence says', async () => {
    const e = engine();
    e.registerRule('safety', { ...pluginDetection(), critical: true }, 'plugin-mentions-competitor');
    const result = await e.evaluateAll(NAMES);
    expect(result.verdict?.state).toBe('fail');
    expect(result.verdict?.by).toContain('mentions_competitor');
    expect(row(result, 'mentions_competitor').role).toBe('veto');
  });
});

describe('the role a result is stamped with is the layer that reads it', () => {
  const base = { passed: false, score: 0, message: 'm' };
  it('a detection or an inference is "risk" when it has a published accuracy, and "advisory" when it has none', () => {
    expect(roleOf({ ...base, ruleName: 'no_stub_output', kind: 'inference' }, DEFAULT_COMPOSE)).toBe('risk');
    expect(roleOf({ ...base, ruleName: 'valid_tool_arguments', kind: 'detection' }, DEFAULT_COMPOSE)).toBe('risk');
    expect(roleOf({ ...base, ruleName: 'mentions_competitor', kind: 'detection' }, DEFAULT_COMPOSE)).toBe('advisory');
    expect(roleOf({ ...base, ruleName: 'mentions_competitor', kind: 'inference' }, DEFAULT_COMPOSE)).toBe('advisory');
    // Critical, it vetoes whatever it is weighed by.
    expect(roleOf({ ...base, ruleName: 'mentions_competitor', kind: 'detection', critical: true }, DEFAULT_COMPOSE)).toBe('veto');
    expect(roleOf({ ...base, ruleName: 'sentence_count', kind: 'measurement' }, DEFAULT_COMPOSE)).toBe('advisory');
  });
});
