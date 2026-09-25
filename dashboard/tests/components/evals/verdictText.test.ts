/*
 * The verdict vocabulary table.
 */
import { describe, it, expect } from 'vitest';
import {
  BASIS_TEXT,
  QUESTION_LABEL,
  STATE_TEXT,
  composerFacts,
  confidenceChip,
  fmtRisk,
  tauOf,
} from '../../../src/components/evals/verdictText';

describe('verdictText', () => {
  it('every basis the composer can return has its own sentence', () => {
    const bases = ['policy_gate', 'detector_veto', 'critical_unknown', 'required_evidence_missing', 'risk_over_loss', 'clean', 'no_rules'];
    expect(Object.keys(BASIS_TEXT).sort()).toEqual([...bases].sort());
    const sentences = Object.values(BASIS_TEXT);
    for (const s of sentences) expect(s).toMatch(/\.$/);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('every question the server asks has a short label', () => {
    expect(Object.keys(QUESTION_LABEL).sort()).toEqual(
      ['safe_output', 'grounded', 'complete', 'relevant', 'task_completed', 'tool_use_correct', 'within_budget'].sort(),
    );
  });

  it('the three states have a label and a tone', () => {
    expect(STATE_TEXT.pass.label).toBe('PASS');
    expect(STATE_TEXT.fail.label).toBe('FAIL');
    expect(STATE_TEXT.unknown.label).toBe('UNKNOWN');
  });

  it('the loss threshold derives from the stored cost, never typed', () => {
    expect(tauOf({ defaultsGate: false, falsePassCost: 1, onCriticalSkipped: 'unknown' })).toBeCloseTo(0.5);
    expect(tauOf({ defaultsGate: false, falsePassCost: 3, onCriticalSkipped: 'unknown' })).toBeCloseTo(0.25);
  });

  it('the composer facts are three, each naming its key and carrying a sentence', () => {
    const facts = composerFacts({ defaultsGate: true, falsePassCost: 4, onCriticalSkipped: 'fail' });
    expect(facts.map((f) => f.key)).toEqual(['eval.falsePassCost', 'eval.defaultsGate', 'eval.onCriticalSkipped']);
    expect(facts[0].sentence).toContain('0.20');
    expect(facts[1].sentence).toMatch(/gate/);
    expect(facts[2].sentence).toMatch(/fails the verdict/);
  });

  it('the risk prints to two places with its interval', () => {
    expect(fmtRisk({ pBad: 0.123, lo: 0.05, hi: 0.3, perClass: {}, assumptions: [] })).toBe('p(bad) 0.12 [0.05, 0.30]');
  });

  it('the confidence chip: a marginal pass that clears the threshold is neutral; a marginal fail or a straddle warns; nothing promises a note that is absent', () => {
    const composer = { defaultsGate: false, falsePassCost: 1, onCriticalSkipped: 'unknown' as const };
    const risk = (pBad: number, lo: number, hi: number) => ({ pBad, lo, hi, perClass: {}, assumptions: [] });
    const pass = confidenceChip({ state: 'pass', risk: risk(0.13, 0.1, 0.16), confidence: 'marginal' }, composer, true)!;
    expect(pass.tone).toBe('muted');
    expect(pass.tooltip).toContain('not yet been confirmed by labelled data');
    expect(pass.tooltip).toContain('The note below says which');
    expect(confidenceChip({ state: 'fail', risk: risk(0.75, 0.6, 0.9), confidence: 'marginal' }, composer, true)!.tone).toBe('warn');
    expect(confidenceChip({ state: 'pass', risk: risk(0.45, 0.3, 0.6), confidence: 'marginal' }, composer, true)!.tone).toBe('warn');
    // A row stored without composer facts carries no notes: the tooltip must not point at one.
    expect(confidenceChip({ state: 'pass', risk: risk(0.13, 0.1, 0.16), confidence: 'marginal' }, null, false)!.tooltip).not.toContain('note below');
    expect(confidenceChip({ state: 'pass', risk: null, confidence: undefined }, composer, true)).toBeNull();
  });
});
