/*
 * The two injection lists cannot come apart (arc 4, A4-9).
 *
 * `no_injection_patterns` reads the agent's OUTPUT with regular expressions.
 * `no_injection_compliance` reads TOOL OUTPUT with literal phrases, because
 * the trajectory law forbids a regular expression there and records why: the
 * text is attacker-controlled and the last denial of service in this family
 * was in the JavaScript glue, not in any pattern.
 *
 * Two lists describing one idea will drift. They share MEANING rather than
 * code, so this test is what holds them together, in both directions:
 *
 *   COVERAGE  — a new phrase-tier pattern with no literal counterpart means
 *               the tool-output side stopped seeing something the output
 *               side sees.
 *   SOUNDNESS — a literal nothing in the pattern library recognises means
 *               the tool-output side started calling something an injection
 *               that the product does not consider one.
 */
import { describe, expect, it } from 'vitest';
import { INJECTION_PATTERNS, PHRASE_PATTERN_COUNT } from '../../../src/eval/rules/safety.js';
import { INJECTED_DIRECTIVE_PHRASES, TOOL_ONLY_DIRECTIVE_PHRASES } from '../../../src/eval/text/directives.js';

const phraseTier = INJECTION_PATTERNS.slice(0, PHRASE_PATTERN_COUNT);

describe('the injection phrase lists stay in step', () => {
  it('the tier boundary is where the pattern library says it is', () => {
    expect(phraseTier).toHaveLength(PHRASE_PATTERN_COUNT);
    expect(INJECTION_PATTERNS.length).toBeGreaterThan(PHRASE_PATTERN_COUNT);
  });

  it('coverage: every phrase-tier pattern has at least one literal counterpart', () => {
    const uncovered = phraseTier
      .filter((pattern) => !INJECTED_DIRECTIVE_PHRASES.some((phrase) => pattern.test(phrase)))
      .map((pattern) => pattern.source);
    expect(uncovered, 'add a literal for each of these to INJECTED_DIRECTIVE_PHRASES').toEqual([]);
  });

  it('soundness: every literal is recognised by the pattern library', () => {
    const unrecognised = INJECTED_DIRECTIVE_PHRASES.filter(
      (phrase) => !phraseTier.some((pattern) => pattern.test(phrase)),
    );
    expect(unrecognised, 'these literals call something an injection that no pattern does').toEqual([]);
  });

  it('the tool-only list is exempt from soundness, and says why by being separate', () => {
    // "do not tell the user" in a retrieved page is an attacker addressing a
    // model. The same words in an agent's own answer are a different and
    // stranger event, which is why the output-side library does not carry
    // them and why this list is not held to the soundness half.
    const overlap = TOOL_ONLY_DIRECTIVE_PHRASES.filter((p) => (INJECTED_DIRECTIVE_PHRASES as readonly string[]).includes(p));
    expect(overlap, 'a phrase belongs to one list or the other').toEqual([]);
    expect(TOOL_ONLY_DIRECTIVE_PHRASES.length).toBeGreaterThan(0);
  });

  it('every literal is lowercase, because matching folds case once and not per entry', () => {
    for (const phrase of [...INJECTED_DIRECTIVE_PHRASES, ...TOOL_ONLY_DIRECTIVE_PHRASES]) {
      expect(phrase, phrase).toBe(phrase.toLowerCase());
    }
  });
});
