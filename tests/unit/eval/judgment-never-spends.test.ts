/*
 * The free evaluation path cannot spend money, and a paid-for judgement
 * cannot read back as clean (arc 3, A3-4).
 *
 * Two properties, both learned the hard way:
 *
 *  1. A judgment rule calls a provider. `evaluate_output` is free and must
 *     never reach one — a promise a tool description used to make and
 *     nothing enforced. The engine now refuses to run a judgment rule
 *     unless the caller said this evaluation may spend, so the guarantee
 *     belongs to the one path every evaluation takes.
 *
 *  2. A stored judge evaluation that FAILED must read back as failed. When
 *     the composer landed, a judge row carried no kind: it was not a policy
 *     and not a detector with a published error rate, so every layer
 *     declined it and a paid-for "fail" read back clean. The row now
 *     declares itself, and a failing judgment decides.
 */
import { describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { compose, DEFAULT_COMPOSE } from '../../../src/eval/compose.js';
import type { EvalResult, EvalRule } from '../../../src/types/eval.js';

/** A judgment rule that would spend money. If it is ever called, the test fails loudly. */
function spendingRule(): EvalRule {
  return {
    name: 'llm_judge:accuracy:anthropic/claude-haiku-4-5',
    description: 'a judge that would call a provider',
    evalType: 'custom',
    weight: 1,
    kind: 'judgment',
    mechanism: 'model',
    needs: ['output'],
    question: 'grounded',
    classes: ['fabrication'],
    version: 1,
    evaluate() {
      throw new Error('SPENT MONEY: a judgment rule was called on a path that may not spend');
    },
  };
}

describe('the free path never spends', () => {
  it('the engine skips a judgment rule rather than calling it', async () => {
    const engine = new EvalEngine(0.7);
    engine.registerRule('custom', spendingRule(), 'rule-judge');
    engine.registerRule('custom', {
      name: 'cheap',
      description: 'free',
      evalType: 'custom',
      weight: 1,
      kind: 'measurement',
      mechanism: 'formula',
      needs: ['output'],
      question: 'complete',
      classes: [],
      version: 1,
      evaluate: () => ({ ruleName: 'cheap', passed: true, score: 1, message: 'ok' }),
    }, 'rule-cheap');

    // No allowPaid: the throwing rule must not be reached.
    const r = await engine.evaluate('custom', { output: 'an ordinary answer that is long enough to evaluate' });
    const judge = r.rule_results.find((x) => x.ruleName.startsWith('llm_judge:'))!;
    expect(judge.skipped).toBe(true);
    expect(judge.skipReason).toContain('allowPaid');
  });

  it('and does call it when the caller has said this evaluation may spend', async () => {
    const engine = new EvalEngine(0.7);
    engine.registerRule('custom', spendingRule(), 'rule-judge-2');
    await expect(
      engine.evaluate('custom', { output: 'an ordinary answer that is long enough to evaluate', allowPaid: true }),
    ).rejects.toThrow('SPENT MONEY');
  });
});

describe('a paid-for judgement decides', () => {
  const judged = (passed: boolean): EvalResult =>
    ({
      id: 'e1',
      eval_type: 'custom',
      output_text: 'x',
      score: passed ? 0.9 : 0.2,
      passed,
      rule_results: [
        {
          ruleName: 'llm_judge:accuracy:anthropic/claude-haiku-4-5',
          passed,
          score: passed ? 0.9 : 0.2,
          message: 'the judge said so',
          kind: 'judgment',
        },
      ],
      suggestions: [],
      rules_evaluated: 1,
      rules_skipped: 0,
      insufficient_data: false,
    }) as EvalResult;

  it('a failing judgement is a failing verdict, not a clean one', () => {
    const v = compose(judged(false), DEFAULT_COMPOSE);
    expect(v.state).toBe('fail');
    expect(v.basis).toBe('policy_gate');
    expect(v.by).toEqual(['llm_judge:accuracy:anthropic/claude-haiku-4-5']);
  });

  it('a passing judgement passes', () => {
    expect(compose(judged(true), DEFAULT_COMPOSE).state).toBe('pass');
  });

  it('a judgement with no kind would have been dropped by every layer — the regression this locks', () => {
    const untyped = judged(false);
    delete (untyped.rule_results[0] as { kind?: unknown }).kind;
    // Without the kind there is no layer to fall into: not a policy, and no
    // published error rate to weigh. The verdict reads clean, which is the
    // defect. Asserted so the row can never quietly lose its kind again.
    expect(compose(untyped, DEFAULT_COMPOSE).state).toBe('pass');
  });
});
