/*
 * The composer (arc 3, A3-3; acceptance rows V6, V7, V8, V9, V10).
 *
 * Four layers decide in order — a configured policy gates, an
 * effectively-critical detector vetoes, a critical rule that could not
 * answer makes the verdict unknown, and everything else with a published
 * error rate becomes one probability against the deployment's loss
 * threshold. Each layer is tested for what it decides AND for what it
 * refuses to decide, because the defects this composer replaces were all
 * of the second kind: a rule that fired and changed nothing.
 */
import { describe, expect, it } from 'vitest';
import { compose, decides, interpretations, tau, DEFAULT_COMPOSE, type ComposeConfig } from '../../../src/eval/compose.js';
import type { EvalResult, EvalRuleResult } from '../../../src/types/eval.js';

const cfg = (over: Partial<ComposeConfig> = {}): ComposeConfig => ({ ...DEFAULT_COMPOSE, ...over });

function row(over: Partial<EvalRuleResult> & { ruleName: string }): EvalRuleResult {
  return { passed: true, score: 1, message: '', ...over } as EvalRuleResult;
}

function result(rows: EvalRuleResult[], over: Partial<EvalResult> = {}): EvalResult {
  return {
    id: 'e1',
    eval_type: 'all',
    output_text: 'x',
    score: 1,
    passed: true,
    rule_results: rows,
    suggestions: [],
    rules_evaluated: rows.filter((r) => !r.skipped).length,
    rules_skipped: rows.filter((r) => r.skipped).length,
    insufficient_data: false,
    ...over,
  } as EvalResult;
}

describe('tau — the threshold a loss ratio implies', () => {
  it('is 1 / (1 + c): symmetric at 1, strict for a compliance gate, lax for a flaky one', () => {
    expect(tau(1)).toBe(0.5);
    expect(tau(10)).toBeCloseTo(0.0909, 4);
    expect(tau(0.1)).toBeCloseTo(0.909, 3);
  });
});

describe('layer 1 — gates', () => {
  it('a configured policy gates and names itself', () => {
    const r = result([row({ ruleName: 'blocked', kind: 'policy', passed: false, critical: true })]);
    const v = compose(r, cfg());
    expect(v).toMatchObject({ state: 'fail', passed: false, basis: 'policy_gate', by: ['blocked'] });
  });

  it('a shipped default threshold does NOT gate — a default is not your policy', () => {
    const r = result([
      row({
        ruleName: 'cost_under_threshold',
        kind: 'policy',
        passed: false,
        evidence: [{ type: 'count', stat: 'cost', unit: 'usd', value: 1.33, threshold: 0.1, thresholdSource: 'default' }],
      }),
    ]);
    expect(compose(r, cfg()).state).toBe('pass');
    // One key, and the same output is blocked.
    expect(compose(r, cfg({ defaultsGate: true })).basis).toBe('policy_gate');
  });

  it('a threshold the deployment set DOES gate', () => {
    const r = result([
      row({
        ruleName: 'cost_under_threshold',
        kind: 'policy',
        passed: false,
        evidence: [{ type: 'count', stat: 'cost', unit: 'usd', value: 1.33, threshold: 0.5, thresholdSource: 'config' }],
      }),
    ]);
    expect(compose(r, cfg()).basis).toBe('policy_gate');
  });

  it('a structural policy with no number in it gates at defaults', () => {
    const r = result([row({ ruleName: 'non_empty_output', kind: 'policy', passed: false })]);
    expect(compose(r, cfg()).basis).toBe('policy_gate');
  });

  it("a custom rule below high severity advises — its severity is the deployment's own statement", () => {
    const r = result([row({ ruleName: 'house_style', kind: 'policy', origin: 'custom', passed: false })]);
    expect(compose(r, cfg()).state).toBe('pass');
    expect(decides(r.rule_results[0], false)).toBe(false);
    // Deployed at high or critical, it is critical, and it gates.
    const strict = result([row({ ruleName: 'house_style', kind: 'policy', origin: 'custom', passed: false, critical: true })]);
    expect(compose(strict, cfg()).basis).toBe('policy_gate');
  });
});

describe('layer 2 — vetoes', () => {
  it('an effectively-critical detector vetoes whatever else is true', () => {
    const r = result([
      row({ ruleName: 'no_pii', kind: 'detection', passed: false, critical: true }),
      row({ ruleName: 'fine', kind: 'measurement' }),
    ]);
    expect(compose(r, cfg())).toMatchObject({ state: 'fail', basis: 'detector_veto', by: ['no_pii'] });
  });

  it('a critical rule that declares no kind still vetoes — silence is not a licence to ignore it', () => {
    const r = result([row({ ruleName: 'handmade', passed: false, critical: true })]);
    expect(compose(r, cfg()).basis).toBe('detector_veto');
  });

  it('a gate outranks a veto, so the basis names the layer that decided', () => {
    const r = result([
      row({ ruleName: 'policy', kind: 'policy', passed: false, critical: true }),
      row({ ruleName: 'no_pii', kind: 'detection', passed: false, critical: true }),
    ]);
    expect(compose(r, cfg()).basis).toBe('policy_gate');
  });
});

describe('layer 3 — asked and could not answer', () => {
  const defeated = () =>
    result([
      row({ ruleName: 'no_pii', kind: 'detection', critical: true, skipped: true, skipClass: 'defeated', passed: false }),
      row({ ruleName: 'fine', kind: 'measurement' }),
    ]);

  it('makes the verdict unknown, and unknown does not read as passed', () => {
    expect(compose(defeated(), cfg())).toMatchObject({ state: 'unknown', passed: false, basis: 'critical_unknown', by: ['no_pii'] });
  });

  it('is a different thing from never asked — a rule with no evidence to read is coverage', () => {
    const notAsked = result([
      row({ ruleName: 'no_tool_loop', kind: 'detection', critical: true, skipped: true, skipClass: 'not_applicable', passed: false }),
      row({ ruleName: 'fine', kind: 'measurement' }),
    ]);
    expect(compose(notAsked, cfg()).state).toBe('pass');
  });

  it('both other settings are reachable in one line', () => {
    expect(compose(defeated(), cfg({ onCriticalSkipped: 'fail' }))).toMatchObject({ state: 'fail', basis: 'critical_unknown' });
    expect(compose(defeated(), cfg({ onCriticalSkipped: 'pass' })).state).toBe('pass');
  });
});

describe('layer 4 — required evidence', () => {
  it('an input the deployment insists on, absent, makes the verdict unknown and names it', () => {
    const r = result([row({ ruleName: 'fine', kind: 'measurement', saw: ['output'] })]);
    const v = compose(r, cfg({ requiredEvidence: ['tool_calls'] }));
    expect(v).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
  });

  it('present, it decides nothing', () => {
    const r = result([row({ ruleName: 'fine', kind: 'measurement', saw: ['output', 'tool_calls'] })]);
    expect(compose(r, cfg({ requiredEvidence: ['tool_calls'] })).state).toBe('pass');
  });
});

describe('layer 5 — the risk', () => {
  it('a measurement never enters it: a short answer is not a leak', () => {
    const r = result([
      row({ ruleName: 'min_output_length', kind: 'measurement', passed: false, classes: ['format'] }),
      row({ ruleName: 'sentence_count', kind: 'measurement', passed: false, classes: ['format'] }),
    ]);
    const v = compose(r, cfg());
    expect(v.state).toBe('pass');
    expect(v.risk).toBeNull();
  });

  it('nothing with a published rate to read means no risk term at all', () => {
    const r = result([row({ ruleName: 'unmeasured_thing', kind: 'detection', passed: false, classes: ['stub'] })]);
    expect(compose(r, cfg())).toMatchObject({ state: 'pass', basis: 'clean', risk: null });
  });

  it('a fired detector carries its published accuracy into one probability, with an interval', () => {
    const r = result([row({ ruleName: 'no_stub_output', kind: 'detection', passed: false, classes: ['stub'] })]);
    const v = compose(r, cfg());
    expect(v.risk).not.toBeNull();
    expect(v.risk!.pBad).toBeGreaterThan(0);
    expect(v.risk!.lo).toBeLessThanOrEqual(v.risk!.pBad);
    expect(v.risk!.hi).toBeGreaterThanOrEqual(v.risk!.pBad);
    expect(v.confidence === 'decisive' || v.confidence === 'marginal').toBe(true);
  });

  it('never claims certainty from a family that merely made no mistakes', () => {
    // Twelve of fifteen families recorded zero false positives. Without the
    // half-count prior their positive predictive value pins to exactly 1 at
    // every prior, which is the overconfidence the interval exists to cure.
    const r = result([row({ ruleName: 'no_silent_tool_failure', kind: 'inference', passed: false, classes: ['silent_tool_failure'] })]);
    const v = compose(r, cfg());
    expect(v.risk!.pBad).toBeLessThan(1);
    expect(v.risk!.pBad).toBeGreaterThan(0.5);
  });

  it('the loss ratio moves the threshold, and nothing else does', () => {
    const r = result([row({ ruleName: 'no_stub_output', kind: 'detection', passed: false, classes: ['stub'] })]);
    const strict = compose(r, cfg({ falsePassCost: 20 }));
    const lax = compose(r, cfg({ falsePassCost: 0.05 }));
    expect(strict.state).toBe('fail');
    expect(lax.state).toBe('pass');
    expect(strict.risk!.pBad).toBe(lax.risk!.pBad);
  });
});

describe('the interpretations a reader needs', () => {
  it('a rule fired and the verdict passed: say why, and name the one setting that changes it', () => {
    const r = result([
      row({
        ruleName: 'cost_under_threshold',
        kind: 'policy',
        passed: false,
        evidence: [{ type: 'count', stat: 'cost', unit: 'usd', value: 1.33, threshold: 0.1, thresholdSource: 'default' }],
      }),
    ]);
    const v = compose(r, cfg());
    const notes = interpretations(r, v, cfg());
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ severity: 'warn', addressee: 'operator', rule: 'cost_under_threshold', configKey: 'eval.defaultsGate' });
    expect(notes[0].text).toContain('did not decide');
  });

  it('the rule that DID decide gets no note — the verdict already names it', () => {
    const r = result([row({ ruleName: 'no_pii', kind: 'detection', passed: false, critical: true })]);
    const v = compose(r, cfg());
    expect(interpretations(r, v, cfg()).filter((n) => n.rule === 'no_pii')).toHaveLength(0);
  });

  it('an unknown verdict says what could not answer and how to choose otherwise', () => {
    const r = result([
      row({ ruleName: 'no_pii', kind: 'detection', critical: true, skipped: true, skipClass: 'config_invalid', passed: false }),
      row({ ruleName: 'fine', kind: 'measurement' }),
    ]);
    const notes = interpretations(r, compose(r, cfg()), cfg());
    const block = notes.find((n) => n.severity === 'block');
    expect(block?.configKey).toBe('eval.onCriticalSkipped');
    expect(block?.text).toContain('no_pii');
  });
});

describe('nothing to judge', () => {
  it('is unknown, not clean', () => {
    const r = result([], { insufficient_data: true, rules_evaluated: 0 });
    expect(compose(r, cfg())).toMatchObject({ state: 'unknown', passed: false, basis: 'no_rules' });
  });
});
