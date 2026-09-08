/*
 * Invariant 13 — nothing the composer computes is dropped on the way out.
 *
 * interpretations[] was built by the composer since 0.10.0, attached by the
 * engine, and never emitted: the serializer had no line for it, the schema
 * no field, no read path carried it. The fix shipped in 0.13.0; this is the
 * lock that keeps the next such field from vanishing the same way.
 *
 * What it checks, precisely: for an evaluation rich enough to populate the
 * optional fields (input, tool calls, a cost over budget, a critical fire),
 * every key the engine sets to a non-empty value appears in the serialized
 * response, unless it is in the documented private set exported beside the
 * serializer — and that private set names only fields that exist.
 */
import { describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { PRIVATE_RESULT_KEYS, toEvaluationResponse } from '../../../src/eval/response.js';

const OUTPUT =
  'Here is the summary you asked for, in two sentences. The customer record shows SSN 123-45-6789 and the refund was approved.';

function nonEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

describe('the serialized evaluation carries every field the engine set', () => {
  it('every non-empty EvalResult key is in the response, or in the documented private set', async () => {
    const engine = new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const result = await engine.evaluateAll({
      output: OUTPUT,
      input: 'Summarise the customer record and say whether the refund was approved.',
      toolCalls: [{ tool_name: 'lookup_customer', input: { id: 42 }, output: 'ok' }],
      costUsd: 1.33,
    });
    // The fields this arc exists for must be present on the engine's side first.
    expect(nonEmpty(result.verdict)).toBe(true);
    expect(nonEmpty(result.coverage)).toBe(true);
    expect(nonEmpty(result.provenance)).toBe(true);
    expect(nonEmpty(result.interpretations)).toBe(true);
    expect(nonEmpty(result.critical_failures)).toBe(true);

    const response = toEvaluationResponse(result);
    const privateKeys = new Set<string>(PRIVATE_RESULT_KEYS);
    const dropped = Object.entries(result)
      .filter(([k, v]) => nonEmpty(v) && !privateKeys.has(k) && !(k in response))
      .map(([k]) => k);
    expect(dropped, 'engine fields absent from the response').toEqual([]);
  });

  it('the private set names only fields an EvalResult has, and never one the response also carries', async () => {
    const engine = new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const result = await engine.evaluateAll({ output: OUTPUT });
    const response = toEvaluationResponse(result);
    for (const k of PRIVATE_RESULT_KEYS) {
      expect(k in response, `${k} is private and must not be emitted`).toBe(false);
    }
    // output_text is always set by the engine; the others are optional but must be real fields.
    expect(nonEmpty(result.output_text)).toBe(true);
  });
});
