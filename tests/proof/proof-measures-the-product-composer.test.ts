/*
 * The published verdict numbers are measured on the composer the product
 * runs.
 *
 * The proof harness used to score `riskVerdict`, a second composer in
 * src/eval/risk.ts. It shared the gate predicate and the risk estimate with
 * the server's compose(), and was still a separate function: it had no
 * evidence layer, named an unknown verdict's basis differently, and nothing
 * asserted the two agreed on any case. A change to compose() could move
 * what ships without moving one published number.
 *
 * The harness now calls compose(). This holds that, and holds the stronger
 * statement on every labelled case: the verdict the proof scores is the
 * verdict the engine attached to the result.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvalEngine } from '../../src/eval/engine.js';
import { defaultConfig } from '../../src/config/defaults.js';
import * as risk from '../../src/eval/risk.js';
import { compositeContext, loadComposite } from '../../proof/lib/composite.js';
import { productVerdict } from '../../proof/lib/composite-report.js';

const root = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8');

describe('one composer', () => {
  it('src/eval/risk.ts exports no composer of its own', () => {
    expect(Object.keys(risk)).not.toContain('riskVerdict');
    expect(read('src/eval/risk.ts')).not.toMatch(/export function riskVerdict/);
  });

  it('the harness decides nothing itself: it calls compose() and reads no rule kind, criticality or gate predicate', () => {
    const source = read('proof/lib/composite-report.ts');
    expect(source).toMatch(/import \{ compose, DEFAULT_COMPOSE \} from '\.\.\/\.\.\/src\/eval\/compose\.js'/);
    // The predicates a composer is made of. Any of them here would be a second decision.
    expect(source).not.toMatch(/\bdecides\(|\bisCritical\(|\.critical === true|kind === 'policy'|kind === 'judgment'|skipClass/);
  });

  it('on every labelled case, the verdict the proof scores is the verdict the engine gave', async () => {
    const loaded = await loadComposite(root);
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    expect(loaded.cases.length).toBeGreaterThanOrEqual(100);
    for (const c of loaded.cases) {
      const result = await engine.evaluateAll(compositeContext(loaded, c));
      const scored = productVerdict(result, 'per-output');
      const given = result.verdict!;
      expect({ state: scored.state, basis: scored.basis, by: scored.by }, c.id).toEqual({ state: given.state, basis: given.basis, by: given.by });
      // Where the engine carried an estimate, the proof scores that estimate.
      if (given.risk !== null) expect(scored.risk?.pBad, c.id).toBe(given.risk.pBad);
      // A hard block still has a stated probability for the calibration tables, and no confidence label.
      if (given.basis === 'policy_gate' || given.basis === 'detector_veto') {
        expect(scored.risk, c.id).not.toBeNull();
        expect(scored.confidence, c.id).toBeNull();
      }
    }
  }, 120_000);
});
