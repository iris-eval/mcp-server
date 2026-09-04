/**
 * Playground demo presets actually demonstrate what they are named after.
 *
 * The "Fabricated citations" preset was wired to `category: "relevance"`
 * while `no_hallucination_markers` had moved to the safety bundle. Clicking
 * it ran keyword_overlap + topic_consistency and nothing else — the marquee
 * hallucination demo on the public playground never fired the one detector
 * it exists to show, and the page still rendered a confident result.
 *
 * A demo that cannot fail the way its label promises is worse than no demo:
 * it is a live, clickable counter-example to the product claim. So each
 * preset declares `expectFailure`, and this suite runs it through the same
 * vendored rule library the playground API uses, under the same category the
 * preset selects.
 */
import { describe, expect, it } from 'vitest';
import { evaluateOutput } from '../website/src/lib/eval/rules.js';
import { PRESETS } from '../website/src/components/playground/presets.js';

describe('playground presets', () => {
  it('has at least one failure preset per safety rule it advertises', () => {
    const named = PRESETS.filter((p) => p.expectFailure).map((p) => p.expectFailure);
    expect(named).toContain('no_pii');
    expect(named).toContain('no_injection_patterns');
    expect(named).toContain('no_stub_output');
    expect(named).toContain('no_hallucination_markers');
  });

  for (const preset of PRESETS) {
    if (!preset.expectFailure) continue;

    it(`"${preset.label}" runs ${preset.expectFailure} under its own category`, () => {
      const summary = evaluateOutput(
        { output: preset.output, input: preset.input, expected: preset.expected },
        preset.category,
      );
      const names = summary.ruleResults.map((r) => r.ruleName);
      // The category the preset selects must INCLUDE the detector. This is
      // the assertion the old wiring failed: relevance simply never ran
      // no_hallucination_markers, so no verdict about it existed at all.
      expect(names).toContain(preset.expectFailure);
    });

    it(`"${preset.label}" actually fails ${preset.expectFailure}`, () => {
      const summary = evaluateOutput(
        { output: preset.output, input: preset.input, expected: preset.expected },
        preset.category,
      );
      const result = summary.ruleResults.find((r) => r.ruleName === preset.expectFailure);
      expect(result, `${preset.expectFailure} did not run`).toBeDefined();
      expect(result!.passed).toBe(false);
      expect(summary.passed).toBe(false);
    });
  }

  /*
   * The clean-response preset must not trip any rule another preset exists
   * to demonstrate — otherwise the "this is what good looks like" sample
   * undercuts the four "this is what bad looks like" samples beside it.
   *
   * Scoped to those rules on purpose, and the full failure list is pinned
   * beneath so a rule change shows up here rather than silently altering
   * the public demo. Measured 2026-08-12 under the old relevance measures,
   * the clean sample failed `keyword_overlap` and `topic_consistency`: a
   * one-line complaint answered by a longer resolution had low lexical
   * overlap, and the test recorded that coarseness rather than gaming the
   * sample. Since the relevance redesign (#416, vendored 2026-09-03) the
   * measures read the same answer as on topic — three of the ask's four
   * content terms recur, and both content sentences connect — so the clean
   * sample now passes every rule, as a "this is what good looks like"
   * sample should.
   */
  it('the clean-response preset trips none of the rules the other presets demonstrate', () => {
    const clean = PRESETS.find((p) => !p.expectFailure);
    expect(clean, 'no clean preset defined').toBeDefined();
    const demonstrated = new Set(
      PRESETS.map((p) => p.expectFailure).filter((n): n is string => Boolean(n)),
    );
    const summary = evaluateOutput(
      { output: clean!.output, input: clean!.input, expected: clean!.expected },
      clean!.category,
    );
    const failures = summary.ruleResults
      .filter((r) => !r.passed)
      .map((r) => r.ruleName);
    expect(failures.filter((n) => demonstrated.has(n))).toEqual([]);
    expect(failures).toEqual([]);
  });
});
