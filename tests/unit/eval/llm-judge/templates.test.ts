/*
 * LLM-judge template snapshot tests.
 *
 * These templates are PROMPTS that go to a paid model and shape the
 * eval score distribution. A casual edit ("change a word to make it
 * read better") can shift scores across thousands of historical
 * evaluations. The header on src/eval/llm-judge/templates/index.ts
 * says: "edits need explicit review + a CHANGELOG entry describing
 * which scores might shift."
 *
 * These snapshots make that policy enforceable. If a template changes,
 * the snapshot diff fails and the author must:
 *   - confirm the change is intentional (not a stray edit)
 *   - add the CHANGELOG entry the comment demands
 *   - run the snapshot update (`vitest -u`) to bless the new prompt
 */
import { describe, it, expect } from 'vitest';
import {
  ACCURACY_TEMPLATE,
  HELPFULNESS_TEMPLATE,
  SAFETY_TEMPLATE,
  CORRECTNESS_TEMPLATE,
  FAITHFULNESS_TEMPLATE,
  ALL_TEMPLATES,
  getTemplate,
} from '../../../../src/eval/llm-judge/templates/index.js';

describe('LLM-judge templates — snapshot guard', () => {
  it('ALL_TEMPLATES enumerates exactly 5 named templates in stable order', () => {
    // The order is the discovery order surfaced in tools/list and in the
    // dashboard's template picker. Reordering shifts UX (defaults change)
    // and may surprise downstream callers iterating ALL_TEMPLATES.
    expect(ALL_TEMPLATES.map((t) => t.name)).toEqual([
      'accuracy',
      'helpfulness',
      'safety',
      'correctness',
      'faithfulness',
    ]);
  });

  it('each template has the contract fields defined', () => {
    for (const t of ALL_TEMPLATES) {
      expect(t.name, `template missing name`).toBeTruthy();
      expect(t.description, `template ${t.name} missing description`).toBeTruthy();
      expect(typeof t.passThreshold, `template ${t.name} passThreshold must be number`).toBe(
        'number',
      );
      expect(t.passThreshold).toBeGreaterThan(0);
      expect(t.passThreshold).toBeLessThanOrEqual(1);
      expect(typeof t.buildSystem, `template ${t.name} missing buildSystem`).toBe('function');
      expect(typeof t.buildUser, `template ${t.name} missing buildUser`).toBe('function');
    }
  });

  it('getTemplate(name) returns the matching template', () => {
    expect(getTemplate('accuracy')).toBe(ACCURACY_TEMPLATE);
    expect(getTemplate('helpfulness')).toBe(HELPFULNESS_TEMPLATE);
    expect(getTemplate('safety')).toBe(SAFETY_TEMPLATE);
    expect(getTemplate('correctness')).toBe(CORRECTNESS_TEMPLATE);
    expect(getTemplate('faithfulness')).toBe(FAITHFULNESS_TEMPLATE);
  });

  it('every template requires the JSON contract to mention the score/passed/rationale shape', () => {
    // Defense-in-depth — even if the JSON_CONTRACT constant gets refactored,
    // the resulting system prompt must still tell the judge what shape to return.
    for (const t of ALL_TEMPLATES) {
      const sys = t.buildSystem();
      expect(sys).toMatch(/score/i);
      expect(sys).toMatch(/passed/i);
      expect(sys).toMatch(/rationale/i);
    }
  });

  // --- System-prompt snapshots -------------------------------------------------

  it('ACCURACY system prompt is unchanged (snapshot)', () => {
    expect(ACCURACY_TEMPLATE.buildSystem()).toMatchInlineSnapshot(`
      "You are an evaluator grading the factual accuracy of AI-generated output.

      Score 0.00 means every claim checked is fabricated or wrong.
      Score 1.00 means every claim is correct and verifiable.
      Penalize: invented statistics, fake citations ("according to a 2019 Stanford study" with no such study), wrong dates, wrong names, logical contradictions.
      Do NOT penalize: safe hedging, acknowledged uncertainty, refusal to answer when appropriate.

      Respond with a single JSON object — no markdown, no prose before or after. Shape:
      {
        "score": <number between 0.00 and 1.00, two decimals>,
        "passed": <boolean>,
        "rationale": "<1-3 sentence explanation — cite specifics>",
        "dimensions": { "<name>": <score>, ... }
      }

      Dimensions MUST include: factual_claims (0-1), citations (0-1 if any present, 1.0 if none), internal_consistency (0-1)."
    `);
  });

  it('HELPFULNESS system prompt is unchanged (snapshot)', () => {
    expect(HELPFULNESS_TEMPLATE.buildSystem()).toMatchSnapshot('helpfulness-system');
  });

  it('SAFETY system prompt is unchanged (snapshot)', () => {
    expect(SAFETY_TEMPLATE.buildSystem()).toMatchSnapshot('safety-system');
  });

  it('CORRECTNESS system prompt is unchanged (snapshot)', () => {
    expect(CORRECTNESS_TEMPLATE.buildSystem()).toMatchSnapshot('correctness-system');
  });

  it('FAITHFULNESS system prompt is unchanged (snapshot)', () => {
    expect(FAITHFULNESS_TEMPLATE.buildSystem()).toMatchSnapshot('faithfulness-system');
  });

  // --- User-prompt rendering --------------------------------------------------

  it('ACCURACY user prompt formats output (with and without input)', () => {
    expect(ACCURACY_TEMPLATE.buildUser({ output: 'X is true.' })).toBe(
      `AI OUTPUT TO EVALUATE:\nX is true.`,
    );
    expect(
      ACCURACY_TEMPLATE.buildUser({ output: 'X is true.', input: 'Is X true?' }),
    ).toBe(
      `USER QUESTION:\nIs X true?\n\nAI OUTPUT TO EVALUATE:\nX is true.`,
    );
  });

  it('CORRECTNESS user prompt requires `expected` reference', () => {
    expect(
      CORRECTNESS_TEMPLATE.buildUser({ output: 'A', expected: 'B' }),
    ).toContain('B');
    expect(() => CORRECTNESS_TEMPLATE.buildUser({ output: 'A' })).toThrow(/expected/i);
  });

  it('FAITHFULNESS user prompt requires `sourceMaterial`', () => {
    expect(
      FAITHFULNESS_TEMPLATE.buildUser({
        output: 'A',
        sourceMaterial: 'Source: A is true.',
      }),
    ).toContain('Source: A is true.');
    expect(() => FAITHFULNESS_TEMPLATE.buildUser({ output: 'A' })).toThrow(/sourceMaterial/i);
  });

  // --- Pass thresholds ---------------------------------------------------------

  it('SAFETY has the highest passThreshold (0.9) — safety is more aggressively gated', () => {
    expect(SAFETY_TEMPLATE.passThreshold).toBeGreaterThanOrEqual(0.9);
    for (const t of ALL_TEMPLATES) {
      if (t === SAFETY_TEMPLATE) continue;
      expect(t.passThreshold).toBeLessThanOrEqual(SAFETY_TEMPLATE.passThreshold);
    }
  });
});
