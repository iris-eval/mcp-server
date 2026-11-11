/*
 * The server instructions and the critical list they quote.
 *
 * The text has a ceiling, because every session pays for it. The critical
 * list inside it is the deployment's: eval.criticalRules adds names. From
 * 0.18.0 the text ran close enough to the ceiling that a promoted rule put
 * it over, and from 0.20.0 any built-in rule did, so a server whose config
 * promoted one refused to start. What is held here: every promotion builds,
 * the list is quoted whole while it fits and counted past that, and the
 * ceiling measures the text this build writes and nothing a config adds.
 */
import { describe, expect, it } from 'vitest';
import { CRITICAL_LIST_MAX_CHARS, INSTRUCTIONS_MAX_CHARS, buildInstructions, criticalListText, type InstructionsInput } from '../../src/instructions.js';
import { builtInRuleRoster } from '../../src/eval/criticality.js';
import { rulesByType } from '../../src/eval/rules/index.js';
import type { JudgeState } from '../../src/judge-enablement.js';

const roster = builtInRuleRoster();
const shipped = roster.filter((r) => r.critical).map((r) => r.name);
const others = roster.filter((r) => !r.critical).map((r) => r.name);
const categories = Object.entries(rulesByType)
  .filter(([, rules]) => rules.length > 0)
  .map(([category]) => category);
const judgeOff: JudgeState = { enabled: false, provider: null, providers: [], costCapUsd: 0.25 };
const judgeOn: JudgeState = { enabled: true, provider: 'anthropic', providers: ['anthropic', 'openai'], costCapUsd: 0.25 };
const input = (critical: readonly string[], judge: JudgeState = judgeOff): InstructionsInput => ({ ruleCount: roster.length, categories, threshold: 0.7, critical, judge });

describe('the critical list the instructions quote', () => {
  it('is every name while they fit, "none" when there are none, and whole names with a count past the limit', () => {
    expect(criticalListText([])).toBe('none');
    expect(criticalListText(shipped)).toBe(shipped.join(', '));
    const every = [...shipped, ...others];
    const text = criticalListText(every);
    expect(every.join(', ').length).toBeGreaterThan(CRITICAL_LIST_MAX_CHARS);
    expect(text.length).toBeLessThanOrEqual(CRITICAL_LIST_MAX_CHARS);
    const match = /^(.*) and (\d+) more$/.exec(text)!;
    const shown = match[1].split(', ');
    // Whole names, in order, and the count is the rest.
    expect(shown).toEqual(every.slice(0, shown.length));
    expect(Number(match[2])).toBe(every.length - shown.length);
    expect(shown.length).toBeGreaterThan(shipped.length);
  });

  it('a list of names too long to show even one is counted', () => {
    const long = Array.from({ length: 3 }, (_, i) => `${'x'.repeat(CRITICAL_LIST_MAX_CHARS)}_${i}`);
    expect(criticalListText(long)).toBe('3 rules');
  });
});

describe('the instructions build under every critical list a config can make', () => {
  it('promoting any one built-in rule builds, and the text names it', () => {
    expect(others.length).toBeGreaterThan(20);
    for (const judge of [judgeOff, judgeOn]) {
      for (const name of others) {
        const text = buildInstructions(input([...shipped, name], judge));
        expect(text, name).toContain(`Critical on this server: ${[...shipped, name].join(', ')} (configurable`);
      }
    }
  });

  it('promoting every rule builds, and so does demoting every one', () => {
    for (const judge of [judgeOff, judgeOn]) {
      const all = buildInstructions(input([...shipped, ...others], judge));
      expect(all).toMatch(/Critical on this server: .* and \d+ more \(configurable/);
      expect(buildInstructions(input([], judge))).toContain('Critical on this server: none (configurable');
    }
  });

  it('the ceiling holds the text this build writes, and the whole text at the shipped list', () => {
    for (const judge of [judgeOff, judgeOn]) {
      const atShipped = buildInstructions(input(shipped, judge));
      // The whole text a default server sends stays under the ceiling.
      expect(atShipped.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
      // And no list adds more than its own quoted length to it.
      const all = buildInstructions(input([...shipped, ...others], judge));
      expect(all.length - criticalListText([...shipped, ...others]).length).toBe(atShipped.length - shipped.join(', ').length);
      expect(all.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS + CRITICAL_LIST_MAX_CHARS);
    }
  });
});
