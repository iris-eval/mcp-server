/*
 * The verdict corrections decided on 2026-09-23, from the red
 * team's measurements on 0.16.0:
 * - answers_the_ask failed 6 of 10 correct paraphrased answers and passed
 *   every refusal and every copy of the ask. It now ADVISES at the shipped
 *   thresholds (it gates once a deployment sets one) and names refusals and
 *   echoes directly, before the brevity skip that let them through.
 * - An inline custom rule could never fail a verdict. It now takes the same
 *   severity field a deployed rule has.
 * - The note for an advising custom rule blamed "a threshold Iris ships".
 */
import { describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';

const engine = new EvalEngine();
const ASK = 'How long do I have to return an item for a refund?';
const ata = async (output: string, eng = engine) => {
  const r = await eng.evaluateAll({ output, input: ASK });
  return { result: r, rule: r.rule_results.find((x) => x.ruleName === 'answers_the_ask')! };
};

describe('answers_the_ask advises at the shipped thresholds', () => {
  it('a correct paraphrase that reuses few of the ask\'s words passes the verdict', async () => {
    const { result } = await ata('You get thirty days from delivery to send it back for a full refund.');
    expect(result.passed).toBe(true);
  });

  it('an off-task answer fires the rule but does not decide the verdict at the defaults', async () => {
    const { result, rule } = await ata('Our office is open nine to five on weekdays and the parking lot is behind the building near the loading dock.');
    expect(rule.passed).toBe(false);
    expect(result.verdict?.by ?? []).not.toContain('answers_the_ask');
  });

  it('gates once the deployment sets a relevance threshold of its own', async () => {
    const tuned = new EvalEngine(undefined, { keyword_overlap: 0.3 });
    const { result, rule } = await ata('Our office is open nine to five on weekdays and the parking lot is behind the building near the loading dock.', tuned);
    expect(rule.passed).toBe(false);
    expect(result.passed).toBe(false);
  });
});

describe('answers_the_ask names refusals and copies of the ask', () => {
  for (const [name, output, why] of [
    ['a bare refusal', 'I cannot help with that.', 'declines'],
    ['a curt no', 'Sorry, no.', 'declines'],
    ['the ask copied back', ASK, 'hands the ask back'],
  ] as const) {
    it(`fires on ${name}`, async () => {
      const { rule } = await ata(output);
      expect(rule.skipped).toBeFalsy();
      expect(rule.passed).toBe(false);
      expect(rule.message).toContain(why);
    });
  }

  it('does not call a decline that goes on to answer a refusal', async () => {
    const { rule } = await ata("I'm not able to see your order, but our policy gives you thirty days from delivery to return any item for a refund.");
    expect(rule.passed).toBe(true);
  });
});

describe('an inline custom rule gates when given severity high or critical', () => {
  const OUT = 'It is guaranteed risk-free.';
  const rule = (severity?: 'low' | 'medium' | 'high' | 'critical') => [
    { name: 'no_promises', type: 'excludes_keywords' as const, config: { keywords: ['guaranteed', 'risk-free'] }, ...(severity ? { severity } : {}) },
  ];
  for (const [severity, gates] of [[undefined, false], ['medium', false], ['high', true], ['critical', true]] as const) {
    it(`severity ${severity ?? 'absent'} ${gates ? 'fails' : 'advises on'} the verdict`, async () => {
      const r = await engine.evaluate('custom', { output: OUT }, rule(severity));
      expect(r.passed).toBe(!gates);
    });
  }

  it('the note for an advising custom rule names severity, not a threshold Iris ships', async () => {
    const r = await engine.evaluate('custom', { output: OUT }, rule());
    const texts = (r.interpretations ?? []).map((i) => i.text).join(' ');
    expect(texts).toContain('Give it severity high or critical');
    expect(texts).not.toContain('a threshold Iris ships');
  });
});
