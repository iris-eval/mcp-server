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
import { carriedBy, compose, interpretations, verdictPath, DEFAULT_COMPOSE, type ComposeConfig } from '../../../src/eval/compose.js';
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

describe('a check that could not answer leaves the verdict unknown when its answer would have counted', () => {
  const plain = row({ ruleName: 'plain', kind: 'measurement' });
  /** A rule that could not answer: skipped, and not for want of something to judge. */
  const unanswered = (r: Partial<EvalRuleResult> & { ruleName: string }): EvalRuleResult => row({ skipped: true, skipClass: 'defeated', passed: false, ...r });
  const unknownOf = (rows: EvalRuleResult[], over: Partial<ComposeConfig> = {}): string[] => verdictPath(evaluation(rows), cfg(over)).find((n) => n.node === 'unknown')?.by ?? [];

  it('somebody asked for it: the deployment or the call, whatever stopped it', () => {
    for (const asked of ['config', 'call'] as const) {
      for (const skipClass of ['defeated', 'config_invalid'] as const) {
        const rows = [unanswered({ ruleName: 'tool_sequence', kind: 'policy', asked, skipClass }), plain];
        expect(compose(evaluation(rows), cfg()), `${asked}, ${skipClass}`).toMatchObject({ state: 'unknown', passed: false, basis: 'critical_unknown', by: ['tool_sequence'] });
      }
    }
    // Nobody asked, it did not throw and it is not critical: it takes no part, as before.
    const nobody = [unanswered({ ruleName: 'no_tool_loop', kind: 'detection' }), plain];
    expect(unknownOf(nobody)).toEqual([]);
    expect(compose(evaluation(nobody), cfg())).toMatchObject({ state: 'pass', basis: 'clean' });
    // A rule with nothing to judge was not asked, whoever set its threshold.
    const nothingToJudge = [row({ ruleName: 'max_steps', kind: 'policy', skipped: true, skipClass: 'not_applicable', passed: false, asked: 'config' }), plain];
    expect(unknownOf(nothingToJudge)).toEqual([]);
  });

  it('it threw, whoever asked: a detection or an inference the estimate weighs, a judgment', () => {
    // no_tool_loop and no_pii are weighed by their published accuracy; nobody set a threshold or made them critical.
    for (const name of ['no_tool_loop', 'no_pii']) {
      const rows = [unanswered({ ruleName: name, kind: 'detection', threw: true }), plain];
      expect(unknownOf(rows), name).toEqual([name]);
      expect(compose(evaluation(rows), cfg()), name).toMatchObject({ state: 'unknown', passed: false, basis: 'critical_unknown', by: [name] });
    }
    expect(unknownOf([unanswered({ ruleName: 'answers_the_ask', kind: 'judgment', threw: true }), plain])).toEqual(['answers_the_ask']);
    // A policy that threw is read by who asked for it: its row carries no threshold to say whose it was.
    expect(unknownOf([unanswered({ ruleName: 'cost_ceiling', kind: 'policy', threw: true, asked: 'config' }), plain])).toEqual(['cost_ceiling']);
    expect(unknownOf([unanswered({ ruleName: 'cost_ceiling', kind: 'policy', threw: true }), plain])).toEqual([]);
    // Two that threw are both named, beside one somebody asked for.
    const three = [unanswered({ ruleName: 'no_tool_loop', kind: 'detection', threw: true }), unanswered({ ruleName: 'grounded_in_reads', kind: 'inference', threw: true }), unanswered({ ruleName: 'tool_sequence', kind: 'policy', asked: 'call' }), plain];
    expect(compose(evaluation(three), cfg()).by).toEqual(['no_tool_loop', 'grounded_in_reads', 'tool_sequence']);
  });

  it('a rule that only reports takes no part by its throw, as it takes none by its fire', () => {
    // Told to report (eval.advisoryRules), or of a kind no layer reads: a plugin\'s detection with no published accuracy, a policy at a threshold nobody set, a measurement.
    const REPORTS: EvalRuleResult[] = [
      unanswered({ ruleName: 'no_tool_loop', kind: 'detection', threw: true, advisory: true }),
      unanswered({ ruleName: 'acme_pii_scan', kind: 'detection', threw: true }),
      unanswered({ ruleName: 'max_steps', kind: 'policy', threw: true }),
      unanswered({ ruleName: 'length_report', kind: 'measurement', threw: true }),
    ];
    for (const reporting of REPORTS) {
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
  });

  it('a row stored under the earlier rules reads back as the verdict its caller was given', () => {
    // A row carries `threw` since 0.20.0. Read under the rules it was stamped with, a rule that threw and nobody asked for takes no part, as it did.
    const rows = [unanswered({ ruleName: 'no_tool_loop', kind: 'detection', threw: true }), plain];
    for (const rules of [1, 2]) {
      expect(compose(evaluation(rows), cfg({ rules })), `rules ${rules}`).toMatchObject({ state: 'pass', basis: 'clean' });
      expect(unknownOf(rows, { rules }), `rules ${rules}`).toEqual([]);
    }
    expect(compose(evaluation(rows), cfg({ rules: 3 }))).toMatchObject({ state: 'unknown', basis: 'critical_unknown' });
    // A critical rule that threw was unknown under every rule set.
    const critical = [unanswered({ ruleName: 'no_pii', kind: 'detection', threw: true, critical: true }), plain];
    for (const rules of [1, 2, 3]) expect(compose(evaluation(critical), cfg({ rules })).state, `rules ${rules}`).toBe('unknown');
  });

  it('the sentence says why each check is there: critical, asked for and by whom, or failed while it judged', () => {
    const sentence = (rows: EvalRuleResult[]): string => {
      const result = evaluation(rows) as EvalResult;
      const verdict = compose(result, cfg());
      return interpretations(result, verdict, cfg()).find((i) => i.configKey === 'eval.onCriticalSkipped')?.text ?? '';
    };
    expect(sentence([unanswered({ ruleName: 'no_pii', kind: 'detection', critical: true }), plain])).toBe(
      'A critical check was asked and could not answer (no_pii), so this verdict is unknown rather than clean. Set eval.onCriticalSkipped to "pass" to accept that risk, or to "fail" to treat it as a failure.',
    );
    expect(sentence([unanswered({ ruleName: 'no_tool_loop', kind: 'detection', threw: true }), unanswered({ ruleName: 'tool_sequence', kind: 'policy', asked: 'call' }), unanswered({ ruleName: 'max_steps', kind: 'policy', asked: 'config' }), plain])).toBe(
      'A check was asked and could not answer (no_tool_loop, which failed while it judged this run; tool_sequence, which this call asked for; max_steps, which this deployment asked for), so this verdict is unknown rather than clean. Set eval.onCriticalSkipped to "pass" to accept that risk, or to "fail" to treat it as a failure.',
    );
  });
});
