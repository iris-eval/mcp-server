/*
 * The verdict and the path it took are one decision.
 *
 * `verdictPath` is the composer's only writer: it asks the five questions in
 * order — a configured gate, a detector's veto, a critical check that could
 * not answer, evidence the deployment requires, the risk estimate — and
 * `compose` stamps the verdict from whichever node decided. This file holds
 * the two properties that make the export worth having: the path ALWAYS
 * agrees with the verdict (basis, `by`, and the risk estimate), and the path
 * stops at the node that decided, so a reader can tell a layer that was
 * asked and found nothing from one that was never asked at all.
 *
 * If these two ever come apart, an embedder rendering the path is telling a
 * reader something the product did not decide.
 */
import { describe, expect, it } from 'vitest';
import { carriedBy, compose, interpretations, roleOf, verdictPath, DEFAULT_COMPOSE, type ComposeConfig } from '../../../src/eval/compose.js';
import type { EvalResult, EvalRuleResult, VerdictNode } from '../../../src/types/eval.js';

const row = (r: Partial<EvalRuleResult> & { ruleName: string }): EvalRuleResult =>
  ({ passed: true, score: 1, message: 'm', ...r }) as EvalRuleResult;

const evaluation = (rows: EvalRuleResult[], extra: Partial<EvalResult> = {}): Pick<EvalResult, 'rule_results' | 'score' | 'insufficient_data' | 'rules_evaluated'> => ({
  rule_results: rows,
  score: 1,
  insufficient_data: false,
  rules_evaluated: rows.filter((r) => !r.skipped).length,
  ...extra,
});

const cfg = (over: Partial<ComposeConfig> = {}): ComposeConfig => ({ ...DEFAULT_COMPOSE, ...over });
const decider = (path: VerdictNode[]): VerdictNode | undefined => path.find((n) => n.decided);

/** One case per basis the composer can stamp, each built from the layer that produces it. */
const CASES: Array<{ basis: string; node: VerdictNode['node'] | null; rows: EvalRuleResult[]; over?: Partial<ComposeConfig>; extra?: Partial<EvalResult> }> = [
  { basis: 'no_rules', node: 'nothing_judged', rows: [], extra: { insufficient_data: true, rules_evaluated: 0 } },
  {
    basis: 'policy_gate',
    node: 'gate',
    // A threshold the deployment SET gates; one Iris ships only advises.
    rows: [row({ ruleName: 'cost_ceiling', kind: 'policy', passed: false, evidence: [{ type: 'count', stat: 'cost', unit: 'usd', value: 1, threshold: 0.1, thresholdSource: 'config' }] })],
  },
  { basis: 'detector_veto', node: 'veto', rows: [row({ ruleName: 'no_pii', kind: 'detection', passed: false, critical: true })] },
  {
    basis: 'critical_unknown',
    node: 'unknown',
    rows: [row({ ruleName: 'no_pii', kind: 'detection', critical: true, skipped: true, skipClass: 'defeated', passed: false }), row({ ruleName: 'plain', kind: 'measurement' })],
  },
  {
    basis: 'required_evidence_missing',
    node: 'evidence',
    rows: [row({ ruleName: 'plain', kind: 'measurement', saw: ['output'] })],
    over: { requiredEvidence: ['expected'] },
  },
  { basis: 'clean', node: null, rows: [row({ ruleName: 'plain', kind: 'measurement' })] },
];

describe('the path and the verdict are one decision', () => {
  for (const c of CASES) {
    it(`${c.basis}: the node that decided is the node the verdict was stamped from`, () => {
      const config = cfg(c.over);
      const result = evaluation(c.rows, c.extra);
      const path = verdictPath(result, config);
      const verdict = compose(result, config);

      expect(verdict.basis, c.basis).toBe(c.basis);
      const d = decider(path);
      expect(d?.node ?? null, 'the deciding node').toBe(c.node);
      if (d) {
        expect(d.by, 'the verdict names what the node found').toEqual(verdict.by);
        expect(path.filter((n) => n.decided)).toHaveLength(1);
        expect(path[path.length - 1], 'the path stops at the decider').toBe(d);
      } else {
        // Nothing decided: every layer was asked, and the verdict is clean.
        expect(verdict.state).toBe('pass');
        expect(path.some((n) => n.node === 'risk')).toBe(true);
      }
    });
  }

  it('a risk that failed the verdict names a class: each that is more likely than not, or the one that carries the most', () => {
    const none = new Set<string>();
    expect(carriedBy({ injection_compliance: 0.6, tool_loop: 0.55, pii_leak: 0.1 }, none)).toEqual(['injection_compliance', 'tool_loop']);
    // A lone fire worth less than a half beside classes that found nothing: the estimate is over the threshold, and it is that class's.
    expect(carriedBy({ pii_leak: 0.02, injection_compliance: 0.4827, tool_loop: 0.03, wrong_trajectory: null }, new Set(['injection_compliance']))).toEqual(['injection_compliance']);
    // Of two classes with a fire, the one that carries more; of two that carry the same, both.
    expect(carriedBy({ a: 0.4, b: 0.3, c: 0.45 }, new Set(['a', 'b']))).toEqual(['a']);
    expect(carriedBy({ a: 0.4, b: 0.4, c: 0.1 }, new Set(['a', 'b']))).toEqual(['a', 'b']);
    expect(carriedBy({ a: 0.5 }, new Set(['a']))).toEqual(['a']);
    // More likely than not is more than a half: exactly a half, with no fire behind it, names nobody.
    expect(carriedBy({ a: 0.5 }, none)).toEqual([]);
    expect(carriedBy({ a: 0.5001 }, none)).toEqual(['a']);
    // An estimate no fire carried names nobody: a strict loss ratio puts the line under the risk of an output nothing flagged.
    expect(carriedBy({ pii_leak: 0.04, injection_compliance: 0.06 }, none)).toEqual([]);
    expect(carriedBy({}, none)).toEqual([]);
    expect(carriedBy({ a: 0, b: null, c: undefined }, new Set(['a', 'b', 'c']))).toEqual([]);
  });

  it('a fire the estimate does not weigh is named for nothing, by the verdict or by the note beside it', () => {
    // A plugin's detection has no published accuracy, so the estimate does not move when it fires (risk.ts, detectorsOf). Under a loss ratio strict enough to fail an output nothing weighed flagged, the verdict fails on the estimate, and it rests on no fire.
    const quiet = [row({ ruleName: 'no_pii', kind: 'detection', classes: ['pii_leak', 'credential_leak'] }), row({ ruleName: 'no_injection_patterns', kind: 'detection', classes: ['injection'] })];
    const plugin = row({ ruleName: 'acme_pii_scan', kind: 'detection', classes: ['pii_leak'], passed: false });
    const strict = cfg({ falsePassCost: 1_000_000 });
    const unweighed = evaluation([...quiet, plugin]) as EvalResult;
    expect(verdictPath(unweighed, strict).find((n) => n.node === 'risk')).toMatchObject({ decided: true, by: [] });
    const failed = compose(unweighed, strict);
    expect(failed).toMatchObject({ state: 'fail', basis: 'risk_over_loss', by: [] });
    expect(interpretations(unweighed, failed, strict).filter((i) => i.text.includes('rests on'))).toEqual([]);
    // A rule the estimate weighs fires as well: its class is named, and the note names that rule and not the plugin.
    const weighed = evaluation([...quiet, plugin, row({ ruleName: 'no_stub_output', kind: 'inference', classes: ['stub'], passed: false })]) as EvalResult;
    const named = compose(weighed, strict);
    expect(named).toMatchObject({ state: 'fail', basis: 'risk_over_loss', by: ['stub'] });
    const notes = interpretations(weighed, named, strict).filter((i) => i.text.includes('rests on'));
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain('rests on no_stub_output.');
  });

  it('the risk node carries the same estimate the verdict carries, decided or not', () => {
    const rows = [row({ ruleName: 'no_pii', kind: 'detection', passed: false })];
    const result = evaluation(rows);
    const path = verdictPath(result, cfg());
    const verdict = compose(result, cfg());
    const riskNode = path.find((n) => n.node === 'risk');
    expect(riskNode, 'the risk layer was asked').toBeDefined();
    expect(riskNode!.risk ?? null).toEqual(verdict.risk);
  });

  it('a layer that was asked and found nothing is in the path with an empty by; the layers after the decider are not in it at all', () => {
    const vetoed = evaluation([row({ ruleName: 'no_pii', kind: 'detection', passed: false, critical: true })]);
    const path = verdictPath(vetoed, cfg());
    expect(path.map((n) => n.node)).toEqual(['gate', 'veto']);
    expect(path[0]).toEqual({ node: 'gate', by: [], decided: false });
    expect(path.some((n) => n.node === 'risk'), 'the risk layer was never asked').toBe(false);
  });

  it('a deployment that accepts a critical skip still sees the node it accepted', () => {
    const rows = [row({ ruleName: 'no_pii', kind: 'detection', critical: true, skipped: true, skipClass: 'defeated', passed: false }), row({ ruleName: 'plain', kind: 'measurement' })];
    const result = evaluation(rows);
    const path = verdictPath(result, cfg({ onCriticalSkipped: 'pass' }));
    const node = path.find((n) => n.node === 'unknown');
    expect(node).toEqual({ node: 'unknown', by: ['no_pii'], decided: false });
    expect(compose(result, cfg({ onCriticalSkipped: 'pass' })).basis).not.toBe('critical_unknown');
  });

  it('onCriticalSkipped "fail" changes the verdict state, never which node decided', () => {
    const rows = [row({ ruleName: 'no_pii', kind: 'detection', critical: true, skipped: true, skipClass: 'defeated', passed: false }), row({ ruleName: 'plain', kind: 'measurement' })];
    const result = evaluation(rows);
    for (const [mode, state] of [
      ['unknown', 'unknown'],
      ['fail', 'fail'],
    ] as const) {
      const config = cfg({ onCriticalSkipped: mode });
      expect(decider(verdictPath(result, config))?.node).toBe('unknown');
      expect(compose(result, config).state).toBe(state);
    }
  });

  it('the evidence layer is only asked when the deployment requires evidence', () => {
    const rows = [row({ ruleName: 'plain', kind: 'measurement', saw: ['output'] })];
    expect(verdictPath(evaluation(rows), cfg()).map((n) => n.node)).not.toContain('evidence');
    const withEvidence = verdictPath(evaluation(rows), cfg({ requiredEvidence: ['output'] }));
    expect(withEvidence.find((n) => n.node === 'evidence')).toEqual({ node: 'evidence', by: [], decided: false });
  });
});


describe('a check that could not answer leaves the verdict unknown where its answer would have counted', () => {
  const plain = row({ ruleName: 'plain', kind: 'measurement' });
  /** A rule that could not answer though there was something to judge: skipped, and classed as stopped. */
  const unanswered = (r: Partial<EvalRuleResult> & { ruleName: string }): EvalRuleResult => row({ skipped: true, skipClass: 'defeated', passed: false, ...r });
  const unknownOf = (rows: EvalRuleResult[], over: Partial<ComposeConfig> = {}): string[] => verdictPath(evaluation(rows), cfg(over)).find((n) => n.node === 'unknown')?.by ?? [];
  /** The four ways a row records that its rule could not answer. */
  const STOPPED: Array<[how: string, flags: Partial<EvalRuleResult>]> = [
    ['it threw', { skipClass: 'defeated', threw: true }],
    ['it was stopped at a limit of work', { skipClass: 'defeated', budgetExceeded: true }],
    ['its evidence was cut', { skipClass: 'defeated', evidenceIncomplete: true }],
    ['its definition is broken', { skipClass: 'config_invalid', configInvalid: true }],
  ];

  it('a gate decides alone, so one that could not answer leaves the verdict unknown, whatever stopped it and whoever asked', () => {
    const GATES: Array<[what: string, r: Partial<EvalRuleResult> & { ruleName: string }, over?: Partial<ComposeConfig>]> = [
      ['a policy with no threshold in it', { ruleName: 'non_empty_output', kind: 'policy' }],
      ["a deployment's own policy, loaded as a plugin", { ruleName: 'no_refund_promise', kind: 'policy', origin: 'plugin' }],
      ['a judgment', { ruleName: 'tone_judge', kind: 'judgment' }],
      ['a policy at a shipped threshold where the deployment made defaults gate', { ruleName: 'cost_under_threshold', kind: 'policy' }, { defaultsGate: true }],
      ['a custom rule below gating severity where the deployment made defaults gate', { ruleName: 'no_internal_draft', kind: 'policy', origin: 'custom' }, { defaultsGate: true }],
      ['a policy whose threshold somebody set', { ruleName: 'cost_under_threshold', kind: 'policy', asked: 'config' }],
    ];
    for (const [what, r, over] of GATES) {
      for (const [how, flags] of STOPPED) {
        const rows = [unanswered({ ...r, ...flags }), plain];
        expect(roleOf(rows[0], cfg(over)), what).toBe('gate');
        expect(compose(evaluation(rows), cfg(over)), `${what}: ${how}`).toMatchObject({ state: 'unknown', passed: false, basis: 'critical_unknown', by: [r.ruleName] });
      }
    }
  });

  it('a policy at a shipped threshold nobody set only reports, and its row says so: no part by its fire, none by its silence', () => {
    // The three built-in policies that compare against a number Iris ships. An answered row says whose number it was on its evidence; a row that could not answer has none, and read by that alone it was a gate.
    for (const name of ['cost_under_threshold', 'max_steps', 'answers_the_ask']) {
      for (const [how, flags] of STOPPED) {
        const r = unanswered({ ruleName: name, kind: 'policy', ...flags });
        expect(roleOf(r, cfg()), `${name}: ${how}`).toBe('advisory');
        expect(unknownOf([r, plain]), `${name}: ${how}`).toEqual([]);
        expect(compose(evaluation([r, plain]), cfg()), `${name}: ${how}`).toMatchObject({ state: 'pass', basis: 'clean' });
      }
    }
    // The same rule answering at the shipped threshold advises too: the two rows agree.
    const fired = row({ ruleName: 'cost_under_threshold', kind: 'policy', passed: false, evidence: [{ type: 'count', stat: 'cost', unit: 'usd', value: 1, threshold: 0.5, thresholdSource: 'default' }] });
    expect(roleOf(fired, cfg())).toBe('advisory');
    // A custom rule below gating severity advises, answered or not.
    const custom = unanswered({ ruleName: 'no_internal_draft', kind: 'policy', origin: 'custom', skipClass: 'config_invalid', configInvalid: true });
    expect(roleOf(custom, cfg())).toBe('advisory');
    expect(unknownOf([custom, plain])).toEqual([]);
  });

  it('a rule the estimate weighs is one voice among several: it counts when it threw, or when somebody asked for it', () => {
    // no_tool_loop and no_pii are weighed by their published accuracy; nobody set a threshold or made them critical.
    for (const name of ['no_tool_loop', 'no_pii']) {
      const threw = [unanswered({ ruleName: name, kind: 'detection', threw: true }), plain];
      expect(roleOf(threw[0], cfg()), name).toBe('risk');
      expect(compose(evaluation(threw), cfg()), name).toMatchObject({ state: 'unknown', passed: false, basis: 'critical_unknown', by: [name] });
      // Stopped at a limit of work, or by a record that was cut, with nobody having asked: something an ordinary run meets, and it takes no part.
      for (const flags of [{ budgetExceeded: true }, { evidenceIncomplete: true }]) {
        expect(unknownOf([unanswered({ ruleName: name, kind: 'detection', ...flags }), plain]), name).toEqual([]);
        expect(unknownOf([unanswered({ ruleName: name, kind: 'detection', asked: 'config', ...flags }), plain]), name).toEqual([name]);
      }
    }
    expect(unknownOf([unanswered({ ruleName: 'grounded_in_reads', kind: 'inference', threw: true }), plain])).toEqual(['grounded_in_reads']);
    // Two that threw are both named, beside one somebody asked for.
    const three = [unanswered({ ruleName: 'no_tool_loop', kind: 'detection', threw: true }), unanswered({ ruleName: 'grounded_in_reads', kind: 'inference', threw: true }), unanswered({ ruleName: 'tool_sequence', kind: 'policy', asked: 'call' }), plain];
    expect(compose(evaluation(three), cfg()).by).toEqual(['no_tool_loop', 'grounded_in_reads', 'tool_sequence']);
  });

  it('somebody asked for it: the deployment or the call, whatever its kind and whatever stopped it', () => {
    // A measurement's fire decides nothing, and one somebody set a threshold on has to answer all the same, as it does when it lacks what it reads.
    const ASKED: Array<Partial<EvalRuleResult> & { ruleName: string }> = [
      { ruleName: 'tool_sequence', kind: 'policy' },
      { ruleName: 'verbosity_ratio', kind: 'measurement' },
      { ruleName: 'no_tool_loop', kind: 'detection' },
    ];
    for (const asked of ['config', 'call'] as const) {
      for (const [how, flags] of STOPPED) {
        for (const r of ASKED) {
          expect(compose(evaluation([unanswered({ ...r, asked, ...flags }), plain]), cfg()), `${r.ruleName}, ${asked}: ${how}`).toMatchObject({ state: 'unknown', passed: false, basis: 'critical_unknown', by: [r.ruleName] });
        }
      }
    }
    // A rule with nothing to judge was not asked, whoever set its threshold.
    expect(unknownOf([row({ ruleName: 'max_steps', kind: 'policy', skipped: true, skipClass: 'not_applicable', passed: false, asked: 'config' }), plain])).toEqual([]);
  });

  it('a rule that only reports, and that nobody asked for, takes no part by its silence', () => {
    // Told to report (eval.advisoryRules), or of a kind no layer reads: a detection with no published accuracy, a measurement.
    const REPORTS: EvalRuleResult[] = [
      unanswered({ ruleName: 'no_tool_loop', kind: 'detection', threw: true, advisory: true }),
      unanswered({ ruleName: 'acme_account_scan', kind: 'detection', origin: 'plugin', threw: true }),
      unanswered({ ruleName: 'acme_account_scan', kind: 'detection', origin: 'plugin', skipClass: 'config_invalid', configInvalid: true }),
      unanswered({ ruleName: 'verbosity_ratio', kind: 'measurement', threw: true }),
      unanswered({ ruleName: 'length_report', kind: 'measurement', budgetExceeded: true }),
    ];
    for (const reporting of REPORTS) {
      expect(roleOf(reporting, cfg()), reporting.ruleName).toBe('advisory');
      expect(unknownOf([reporting, plain]), reporting.ruleName).toEqual([]);
      expect(compose(evaluation([reporting, plain]), cfg()), reporting.ruleName).toMatchObject({ state: 'pass', basis: 'clean' });
    }
  });

  it('a failure still outranks it, and the deployment still says what an unanswered check means', () => {
    const threw = unanswered({ ruleName: 'no_tool_loop', kind: 'detection', threw: true });
    // A critical rule fired beside it: the verdict fails on that, and the check that threw is listed with it.
    const failed = compose(evaluation([threw, row({ ruleName: 'no_pii', kind: 'detection', passed: false, critical: true }), plain]), cfg());
    expect(failed).toMatchObject({ state: 'fail', basis: 'detector_veto', by: ['no_pii'] });
    expect(failed.also).toEqual([{ basis: 'critical_unknown', state: 'unknown', by: ['no_tool_loop'] }]);
    // eval.onCriticalSkipped: "fail" reads it as a failure, and "pass" accepts it; the node is on the path either way.
    expect(compose(evaluation([threw, plain]), cfg({ onCriticalSkipped: 'fail' }))).toMatchObject({ state: 'fail', basis: 'critical_unknown', by: ['no_tool_loop'] });
    expect(compose(evaluation([threw, plain]), cfg({ onCriticalSkipped: 'pass' }))).toMatchObject({ state: 'pass', basis: 'clean' });
    expect(verdictPath(evaluation([threw, plain]), cfg({ onCriticalSkipped: 'pass' })).find((n) => n.node === 'unknown')).toEqual({ node: 'unknown', by: ['no_tool_loop'], decided: false });
    // A gate that could not answer is read by the same setting.
    const gate = unanswered({ ruleName: 'non_empty_output', kind: 'policy', threw: true });
    expect(compose(evaluation([gate, plain]), cfg({ onCriticalSkipped: 'fail' }))).toMatchObject({ state: 'fail', basis: 'critical_unknown', by: ['non_empty_output'] });
    expect(compose(evaluation([gate, plain]), cfg({ onCriticalSkipped: 'pass' }))).toMatchObject({ state: 'pass', basis: 'clean' });
  });

  it('a row stored under the earlier rules reads back as it was given: only a critical rule was read then', () => {
    // Each of these leaves the verdict unknown under rules 3, and took no part before.
    const ROWS: Array<[what: string, r: EvalRuleResult, over?: Partial<ComposeConfig>]> = [
      ['a weighed rule that threw', unanswered({ ruleName: 'no_tool_loop', kind: 'detection', threw: true })],
      ['a gate that threw', unanswered({ ruleName: 'non_empty_output', kind: 'policy', threw: true })],
      ["a plugin's policy whose definition is broken", unanswered({ ruleName: 'no_refund_promise', kind: 'policy', origin: 'plugin', skipClass: 'config_invalid', configInvalid: true })],
      ['a policy at a shipped threshold that threw where defaults gate', unanswered({ ruleName: 'cost_under_threshold', kind: 'policy', threw: true }), { defaultsGate: true }],
    ];
    for (const [what, r, over] of ROWS) {
      for (const rules of [1, 2]) {
        expect(compose(evaluation([r, plain]), cfg({ ...over, rules })), `${what}, rules ${rules}`).toMatchObject({ state: 'pass', basis: 'clean' });
        expect(unknownOf([r, plain], { ...over, rules }), `${what}, rules ${rules}`).toEqual([]);
      }
      expect(compose(evaluation([r, plain]), cfg({ ...over, rules: 3 })), what).toMatchObject({ state: 'unknown', basis: 'critical_unknown' });
    }
    // A critical rule that could not answer was unknown under every rule set.
    const critical = [unanswered({ ruleName: 'no_pii', kind: 'detection', threw: true, critical: true }), plain];
    for (const rules of [1, 2, 3]) expect(compose(evaluation(critical), cfg({ rules })).state, `rules ${rules}`).toBe('unknown');
  });

  it('under the earlier rules a risk failure names a class only when one is more likely than not, and is told every detection that fired', () => {
    // A plugin's detection fired beside a rule the estimate weighs, under a loss ratio strict enough that the estimate fails the verdict with no class over a half.
    const rows = [
      row({ ruleName: 'no_pii', kind: 'detection', classes: ['pii_leak', 'credential_leak'] }),
      row({ ruleName: 'no_injection_patterns', kind: 'detection', classes: ['injection'] }),
      // Quiet beside the fire, as in an ordinary evaluation: another rule of the same class that found nothing, and one of another class.
      row({ ruleName: 'says_something', kind: 'detection', classes: ['stub'] }),
      row({ ruleName: 'no_hallucination_markers', kind: 'inference', classes: ['fabrication'] }),
      row({ ruleName: 'acme_account_scan', kind: 'detection', classes: ['pii_leak'], passed: false }),
      row({ ruleName: 'no_stub_output', kind: 'inference', classes: ['stub'], passed: false }),
    ];
    const result = evaluation(rows) as EvalResult;
    const rests = (config: ComposeConfig): string => interpretations(result, compose(result, config), config).find((i) => i.text.includes('rests on'))?.text ?? '';
    const now = cfg({ falsePassCost: 1_000_000 });
    // No class is more likely than not by itself: the estimate is the stub class's, at under a half.
    expect(Object.values(compose(result, now).risk?.perClass ?? {}).filter((q) => typeof q === 'number' && q > 0.5)).toEqual([]);
    expect(compose(result, now)).toMatchObject({ state: 'fail', basis: 'risk_over_loss', by: ['stub'] });
    expect(rests(now)).toContain('rests on no_stub_output. If its fires are');
    for (const rules of [1, 2]) {
      const earlier = cfg({ falsePassCost: 1_000_000, rules });
      expect(compose(result, earlier), `rules ${rules}`).toMatchObject({ state: 'fail', basis: 'risk_over_loss', by: [] });
      expect(rests(earlier), `rules ${rules}`).toContain('rests on acme_account_scan, no_stub_output. If their fires are');
    }
  });

  it('the sentence says why each check is there: critical, asked for and by whom, failed while it judged, or a gate here', () => {
    const sentence = (rows: EvalRuleResult[], over: Partial<ComposeConfig> = {}): string => {
      const result = evaluation(rows) as EvalResult;
      const verdict = compose(result, cfg(over));
      return interpretations(result, verdict, cfg(over)).find((i) => i.configKey === 'eval.onCriticalSkipped')?.text ?? '';
    };
    expect(sentence([unanswered({ ruleName: 'no_pii', kind: 'detection', critical: true }), plain])).toBe(
      'A critical check was asked and could not answer (no_pii), so this verdict is unknown rather than clean. Set eval.onCriticalSkipped to "pass" to accept that risk, or to "fail" to treat it as a failure.',
    );
    // A critical rule is named as critical, whoever else asked for it and however it stopped: the sentence is the one it always was.
    expect(sentence([unanswered({ ruleName: 'no_pii', kind: 'detection', critical: true, asked: 'config', threw: true }), plain])).toBe(
      'A critical check was asked and could not answer (no_pii), so this verdict is unknown rather than clean. Set eval.onCriticalSkipped to "pass" to accept that risk, or to "fail" to treat it as a failure.',
    );
    const mixed = [
      unanswered({ ruleName: 'no_tool_loop', kind: 'detection', threw: true }),
      unanswered({ ruleName: 'tool_sequence', kind: 'policy', asked: 'call' }),
      unanswered({ ruleName: 'max_steps', kind: 'policy', asked: 'config' }),
      unanswered({ ruleName: 'no_refund_promise', kind: 'policy', origin: 'plugin', skipClass: 'config_invalid', configInvalid: true }),
      unanswered({ ruleName: 'no_pii', kind: 'detection', critical: true }),
      plain,
    ];
    const NAMES = 'no_tool_loop, which failed while it judged this run; tool_sequence, which this call asked for; max_steps, which this deployment asked for; no_refund_promise, which gates here; no_pii';
    expect(sentence(mixed)).toBe(`A check that had to answer could not (${NAMES}), so this verdict is unknown rather than clean. Set eval.onCriticalSkipped to "pass" to accept that risk, or to "fail" to treat it as a failure.`);
    // On a verdict that failed on other grounds the same checks are named, each with its reason.
    const fired = row({ ruleName: 'no_secrets', kind: 'detection', passed: false, critical: true });
    expect(sentence([...mixed, fired])).toBe(`A check that had to answer could not (${NAMES}). The verdict failed on other grounds; that check is still not answered. Set eval.onCriticalSkipped to "pass" to accept that risk.`);
  });

  it('the clause of a later layer says what the layer reads, and under the earlier rules what it read then', () => {
    const rows = [unanswered({ ruleName: 'no_tool_loop', kind: 'detection', threw: true }), unanswered({ ruleName: 'no_secrets', kind: 'detection', critical: true }), row({ ruleName: 'no_pii', kind: 'detection', passed: false, critical: true }), plain];
    const clause = (over: Partial<ComposeConfig>): string => {
      const result = evaluation(rows) as EvalResult;
      return interpretations(result, compose(result, cfg(over)), cfg(over)).find((i) => i.text.includes('is not the only layer'))?.text ?? '';
    };
    expect(clause({})).toBe('detector_veto decided this verdict, and it is not the only layer that would have: a check whose answer would have counted could not answer (no_tool_loop, no_secrets). Clearing no_pii alone does not clear the verdict.');
    expect(clause({ rules: 2 })).toBe('detector_veto decided this verdict, and it is not the only layer that would have: a critical check was asked and could not answer (no_secrets). Clearing no_pii alone does not clear the verdict.');
  });
});
