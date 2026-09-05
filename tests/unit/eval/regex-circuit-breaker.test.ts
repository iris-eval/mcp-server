import { describe, it, expect, afterAll } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { shutdownRegexSandbox } from '../../../src/eval/rules/regex-sandbox.js';
import type { CustomRuleDefinition } from '../../../src/types/eval.js';

/*
 * One hostile output must not stall a request once per regex rule it
 * carries. The breaker lives in the engine-scoped context: after 3 sandbox
 * budget breaches in a single evaluation, remaining regex rules skip
 * WITHOUT running (still flagged budgetExceeded). Pre-breaker measurement:
 * ~186ms per hostile rule, linear — 9.3s for one 50-rule request.
 */

const HOSTILE_FUEL = 'a'.repeat(40) + 'b';

function hostileRule(name: string): CustomRuleDefinition {
  // lgtm[js/redos] — intentionally hostile test input
  return { name, type: 'regex_match', config: { pattern: '^(a|a)*$' } }; // codeql-suppress js/redos
}

afterAll(() => {
  shutdownRegexSandbox();
});

describe('per-evaluation regex circuit breaker', () => {
  it('opens after 3 budget breaches; later regex rules skip without running', async () => {
    const engine = new EvalEngine(0.7);
    const rules = Array.from({ length: 6 }, (_, i) => hostileRule(`hostile-${i}`));

    const started = Date.now();
    const result = await engine.evaluate('custom', { output: HOSTILE_FUEL }, rules);
    const elapsed = Date.now() - started;

    // 3 real breaches (~190ms each incl. respawn) + 3 short-circuits (~0ms).
    // Without the breaker this would be ~1.2s; without the sandbox, hours.
    expect(elapsed).toBeLessThan(2500);

    const skipped = result.rule_results.filter((r) => r.skipped);
    expect(skipped).toHaveLength(6);
    for (const r of skipped) {
      expect(r.budgetExceeded).toBe(true);
    }
    // The short-circuited tail says the breaker opened, not that the
    // pattern itself was measured.
    const circuitSkips = skipped.filter((r) => r.message.includes('circuit breaker'));
    expect(circuitSkips.length).toBe(3);
  });

  it('the breaker is per-evaluation: a fresh evaluate() starts closed', async () => {
    const engine = new EvalEngine(0.7);
    await engine.evaluate('custom', { output: HOSTILE_FUEL }, [
      hostileRule('a'),
      hostileRule('b'),
      hostileRule('c'),
      hostileRule('d'),
    ]);
    // Next evaluation: a benign regex rule must run normally, not hit an
    // inherited open breaker.
    const benign = await engine.evaluate('custom', { output: 'hello world' }, [
      { name: 'ok', type: 'regex_match', config: { pattern: 'hello' } },
    ]);
    expect(benign.rule_results[0].skipped).toBeUndefined();
    expect(benign.rule_results[0].passed).toBe(true);
  });

  it('suggestions quote the real skip reason, not "(missing context)"', async () => {
    const engine = new EvalEngine(0.7);
    // Mix: one hostile rule (budget skip) + one benign rule that evaluates,
    // so we exercise the MIXED path, not the all-skipped path.
    const result = await engine.evaluate('custom', { output: HOSTILE_FUEL }, [
      hostileRule('stalled-policy'),
      { name: 'has-an-a', type: 'regex_match', config: { pattern: 'a' } },
    ]);
    const skipLine = result.suggestions.find((s) => s.includes('stalled-policy'));
    expect(skipLine).toBeDefined();
    expect(skipLine).toContain('matching budget');
    expect(skipLine).not.toContain('missing context');
  });
});
