/*
 * The confidence label.
 *
 * "decisive" used to mean only that the credible interval on p_bad excluded
 * τ. The composite corpus showed that interval says nothing about the error
 * in the model that combines the detectors: clean passes stated p_bad near
 * 0.13 and were bad about a third of the time. These tests pin the three
 * conditions "decisive" now needs, each against a table built here so the
 * test does not move when the corpus is regenerated, and then check the
 * shipped table against the case the change was made for.
 */
import { describe, expect, it } from 'vitest';
import { binOf, verdictConfidence, MIN_BIN_N, MIN_BIN_PATTERNS, type CalibrationTable } from '../../../src/eval/confidence.js';
import { PUBLISHED_CALIBRATION } from '../../../src/eval/published-calibration.js';
import { compose, interpretations, DEFAULT_COMPOSE } from '../../../src/eval/compose.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import type { EvalResult, EvalRuleResult } from '../../../src/types/eval.js';

type BinOver = Record<number, { n: number; bad: number; meanPredicted: number; patterns?: number }>;

// Unless a test says otherwise, every verdict in a bin has its own detector pattern.
const bins = (over: BinOver): CalibrationTable['bins'] =>
  Array.from({ length: 10 }, (_, i) => ({ from: i / 10, to: (i + 1) / 10, n: 0, bad: 0, patterns: 0, meanPredicted: null, ...(over[i] ? { patterns: over[i].n, ...over[i] } : {}) }));

const table = (over: BinOver): CalibrationTable => ({
  compositeVersion: 'test',
  split: 'dev',
  prior: 0.5,
  priorMode: 'per-output',
  bins: bins(over),
});

const setting = { prior: 0.5, priorMode: 'per-output' as const, localLabels: false };

describe('verdictConfidence', () => {
  it('an interval that straddles τ is marginal whatever the table says', () => {
    const t = table({ 5: { n: 100, bad: 99, meanPredicted: 0.55 } });
    expect(verdictConfidence({ pBad: 0.55, lo: 0.4, hi: 0.7 }, 0.5, setting, t)).toMatchObject({ confidence: 'marginal', reason: 'interval_straddles' });
  });

  it('a region where the observed bad rate disagrees with the stated p_bad is marginal', () => {
    // States 0.13; 12 of 39 were bad (Wilson 95% about 0.19–0.46).
    const t = table({ 1: { n: 39, bad: 12, meanPredicted: 0.13 } });
    const call = verdictConfidence({ pBad: 0.13, lo: 0.11, hi: 0.17 }, 0.5, setting, t);
    expect(call).toMatchObject({ confidence: 'marginal', reason: 'region_miscalibrated' });
    expect(call.region!.observed[0]).toBeGreaterThan(0.13);
  });

  it('a calibrated region whose observed rate still reaches τ does not back the verdict', () => {
    const t = table({ 6: { n: 10, bad: 8, meanPredicted: 0.68 } });
    expect(verdictConfidence({ pBad: 0.68, lo: 0.55, hi: 0.8 }, 0.5, setting, t)).toMatchObject({ confidence: 'marginal', reason: 'region_not_backed' });
  });

  it('a calibrated region wholly on the verdict side is decisive, for a fail and for a pass', () => {
    const t = table({ 7: { n: 15, bad: 13, meanPredicted: 0.75 }, 1: { n: 200, bad: 26, meanPredicted: 0.13 } });
    expect(verdictConfidence({ pBad: 0.75, lo: 0.6, hi: 0.9 }, 0.5, setting, t).confidence).toBe('decisive');
    expect(verdictConfidence({ pBad: 0.13, lo: 0.11, hi: 0.17 }, 0.5, setting, t).confidence).toBe('decisive');
  });

  it('the side is read against the deployment τ, not the one the table was measured at', () => {
    const t = table({ 7: { n: 15, bad: 13, meanPredicted: 0.75 } });
    // At τ = 0.3 (falsePassCost ≈ 2.3) the region's interval, about 0.62–0.96, still clears it.
    expect(verdictConfidence({ pBad: 0.75, lo: 0.6, hi: 0.9 }, 0.3, setting, t).confidence).toBe('decisive');
    // At τ = 0.8 the verdict passes and the region says most such outputs were bad.
    expect(verdictConfidence({ pBad: 0.75, lo: 0.72, hi: 0.78 }, 0.8, setting, t)).toMatchObject({ confidence: 'marginal', reason: 'region_not_backed' });
  });

  it('a region with too few verdicts, or too few distinct detector patterns, is not tested', () => {
    // One verdict: its Wilson interval still clears a τ of 0.2, which is what made "decisive" easy at user-set τ.
    const one = table({ 5: { n: 1, bad: 1, meanPredicted: 0.52 } });
    expect(verdictConfidence({ pBad: 0.52, lo: 0.4, hi: 0.65 }, 0.2, setting, one)).toMatchObject({ confidence: 'marginal', reason: 'region_too_few' });
    // Ten verdicts from three patterns (eight of them one case repeated): a pass at τ = 0.95 where 8 of 10 were bad is not decisive.
    const dup = table({ 6: { n: 10, bad: 8, meanPredicted: 0.68, patterns: 3 } });
    expect(verdictConfidence({ pBad: 0.68, lo: 0.55, hi: 0.8 }, 0.95, setting, dup)).toMatchObject({ confidence: 'marginal', reason: 'region_too_few' });
    // At the floor exactly, the bin is tested.
    const floor = table({ 6: { n: MIN_BIN_N, bad: 9, meanPredicted: 0.68, patterns: MIN_BIN_PATTERNS } });
    expect(verdictConfidence({ pBad: 0.68, lo: 0.55, hi: 0.8 }, 0.95, setting, floor).reason).not.toBe('region_too_few');
  });

  it('the floor on patterns is the fewest independent observations that could exclude τ = 0.5 if all agreed', () => {
    const upperAllGood = (m: number): number => 1.96 ** 2 / (m + 1.96 ** 2);
    expect(upperAllGood(MIN_BIN_PATTERNS)).toBeLessThan(0.5);
    expect(upperAllGood(MIN_BIN_PATTERNS - 1)).toBeGreaterThan(0.5);
  });

  it('an empty region is not measured, so it is not decisive', () => {
    expect(verdictConfidence({ pBad: 0.25, lo: 0.2, hi: 0.3 }, 0.5, setting, table({}))).toMatchObject({ confidence: 'marginal', reason: 'region_unmeasured' });
  });

  it('a setting the corpus did not measure is not decisive: another prior, the per-class reading, or local labels', () => {
    const t = table({ 7: { n: 15, bad: 13, meanPredicted: 0.75 } });
    const risk = { pBad: 0.75, lo: 0.6, hi: 0.9 };
    expect(verdictConfidence(risk, 0.5, { ...setting, prior: 0.2 }, t).reason).toBe('setting_unmeasured');
    expect(verdictConfidence(risk, 0.5, { ...setting, priorMode: 'per-class' }, t).reason).toBe('setting_unmeasured');
    expect(verdictConfidence(risk, 0.5, { ...setting, localLabels: true }, t).reason).toBe('setting_unmeasured');
  });

  it('bins a p_bad the way the reliability table does, including the top edge', () => {
    const b = bins({});
    expect(binOf(0, b)!.from).toBe(0);
    expect(binOf(0.7, b)!.from).toBe(0.7);
    expect(binOf(1, b)!.from).toBe(0.9);
  });
});

describe('the shipped calibration', () => {
  it('is measured at the shipped prior and reading', () => {
    expect(PUBLISHED_CALIBRATION.prior).toBe(DEFAULT_COMPOSE.prior);
    expect(PUBLISHED_CALIBRATION.priorMode).toBe(DEFAULT_COMPOSE.priorMode);
    expect(PUBLISHED_CALIBRATION.bins).toHaveLength(10);
  });

  it('no longer calls a clean pass decisive where the corpus measured the estimate running low', () => {
    // The typical clean pass on the composite corpus: p_bad 0.13, interval [0.11, 0.17].
    // If a regeneration flips this, the estimate became calibrated there: say so in the CHANGELOG and update this line.
    expect(verdictConfidence({ pBad: 0.13, lo: 0.11, hi: 0.17 }, 0.5, setting)).toMatchObject({ confidence: 'marginal', reason: 'region_miscalibrated' });
  });

  it('the label compose() stamps is the one verdictConfidence gives, and a marginal one carries its sentence', () => {
    const result = {
      id: 'e1',
      eval_type: 'all',
      output_text: 'x',
      score: 1,
      passed: true,
      rule_results: [{ ruleName: 'no_stub_output', kind: 'detection', passed: true, score: 1, message: '', classes: ['stub'] } as EvalRuleResult],
      rules_evaluated: 1,
      rules_failed: 0,
      suggestions: [],
      duration_ms: 1,
      created_at: '2026-01-01T00:00:00Z',
    } as unknown as EvalResult;
    const v = compose(result, DEFAULT_COMPOSE);
    expect(v.state).toBe('pass');
    const bin = binOf(v.risk!.pBad, PUBLISHED_CALIBRATION.bins);
    const call = verdictConfidence(v.risk!, 0.5, { prior: 0.5, priorMode: 'per-output', localLabels: false });
    expect(v.confidence).toBe(call.confidence);
    // Whatever the table holds, the label and the sentence under it agree.
    if (v.confidence === 'marginal') {
      const notes = interpretations(result, v, DEFAULT_COMPOSE).filter((i) => i.text.includes('labelled data') || i.text.includes('credible interval'));
      expect(notes).toHaveLength(1);
      if (call.reason === 'region_miscalibrated') expect(notes[0].text).toContain(`${bin!.bad} of ${bin!.n}`);
    }
  });

  it('a clean pass that is marginal at the defaults is said plainly: the corpus measured the estimate as too low there, with the numbers, and it is not called a close call', async () => {
    // The typical clean pass: every shipped detector examines the output and none fires.
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const result = await engine.evaluateAll({
      input: 'What is the capital of France?',
      output: 'The capital of France is Paris. It has been the capital since the tenth century.',
    });
    const v = result.verdict!;
    expect(v).toMatchObject({ state: 'pass', basis: 'clean', confidence: 'marginal' });
    const notes = (result.interpretations ?? []).filter((i) => i.text.includes('labelled data'));
    expect(notes).toHaveLength(1);
    const [note] = notes;
    expect(note.severity).toBe('note');
    expect(note.text).toMatch(/^Risk estimate measured as too low at this level on labelled data; see iris-eval\.com\/proof\./);
    expect(note.text).not.toContain('close call');
    expect(note.text).not.toContain('scored');
    expect(note.text).toMatch(/outputs with a risk estimate of 0\.1–0\.2 were bad \d+% of the time \(\d+ of \d+/);
  });

  it('a stored verdict labelled under another calibration table reads back with no label and says why', () => {
    const result = {
      id: 'e1',
      eval_type: 'all',
      output_text: 'x',
      score: 1,
      passed: true,
      rule_results: [{ ruleName: 'no_stub_output', kind: 'detection', passed: true, score: 1, message: '', classes: ['stub'] } as EvalRuleResult],
      rules_evaluated: 1,
      rules_failed: 0,
      suggestions: [],
      duration_ms: 1,
      created_at: '2026-01-01T00:00:00Z',
    } as unknown as EvalResult;
    const now = compose(result, DEFAULT_COMPOSE);
    const same = compose(result, { ...DEFAULT_COMPOSE, calibration: PUBLISHED_CALIBRATION.compositeVersion });
    expect(same).toEqual(now);
    for (const calibration of ['000000000000', null]) {
      const cfg = { ...DEFAULT_COMPOSE, calibration };
      const old = compose(result, cfg);
      // The verdict itself is untouched; only the label is withheld.
      expect({ state: old.state, passed: old.passed, basis: old.basis, risk: old.risk }).toEqual({ state: now.state, passed: now.passed, basis: now.basis, risk: now.risk });
      expect(old.confidence).toBeUndefined();
      const notes = interpretations(result, old, cfg);
      expect(notes.map((n) => n.text).join(' ')).toContain('carries no confidence label');
      expect(notes.some((n) => n.text.includes('labelled data'))).toBe(false);
    }
  });
});
