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
import { compose, verdictPath, DEFAULT_COMPOSE, type ComposeConfig } from '../../../src/eval/compose.js';
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
    rows: [row({ ruleName: 'cost_ceiling', kind: 'policy', passed: false, evidence: [{ type: 'count', name: 'cost', value: 1, threshold: 0.1, thresholdSource: 'config' }] })],
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
