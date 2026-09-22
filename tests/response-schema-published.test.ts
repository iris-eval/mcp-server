/*
 * The published response schema is the schema the server validates with (arc 9, N-22).
 *
 * website/public/response-schema-v1.json is served at
 * https://iris-eval.com/response-schema-v1.json for anyone generating types
 * or validating a stored response. It is rendered from
 * `evaluateOutputResponseSchema` — the same object the `evaluate_output`
 * tool advertises as its `outputSchema` and parses its answer through — so
 * the only way it can describe a response Iris does not return is if the
 * committed file drifts from the render. This fails when it has.
 *
 * It also holds the two things a published schema promises beyond its
 * shape: it validates a real response the engine produced, and it does not
 * carry a field the product removed.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { EvalEngine } from '../src/eval/engine.js';
import { defaultConfig } from '../src/config/defaults.js';
import { toEvaluationResponse } from '../src/eval/response.js';
import { renderResponseSchema, responseSchemaDocument, RESPONSE_SCHEMA_ID, RESPONSE_SCHEMA_PATH } from '../src/eval/response-schema-json.js';

const root = resolve(__dirname, '..');
const committed = readFileSync(join(root, RESPONSE_SCHEMA_PATH), 'utf8').replace(/\r\n/g, '\n');

describe('the published response schema', () => {
  it('is what the renderer produces — the committed file has not drifted from the zod schema', () => {
    expect(committed).toBe(renderResponseSchema());
  });

  it('carries its identity, is JSON Schema 2020-12, and names the fields a reader depends on', () => {
    const doc = JSON.parse(committed) as { $id: string; $schema: string; title: string; type: string; properties: Record<string, unknown>; required: string[] };
    expect(doc.$id).toBe(RESPONSE_SCHEMA_ID);
    expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(doc.title).toMatch(/^Iris evaluation response/);
    expect(doc.type).toBe('object');
    for (const field of ['id', 'eval_type', 'score', 'passed', 'rule_results', 'verdict', 'coverage', 'provenance', 'interpretations']) {
      expect(Object.keys(doc.properties), field).toContain(field);
    }
    for (const field of ['id', 'eval_type', 'score', 'passed', 'rule_results']) {
      expect(doc.required, field).toContain(field);
    }
  });

  it('does not carry `suggestions` — the field this release removed', () => {
    expect(committed).not.toMatch(/"suggestions"/);
    expect(responseSchemaDocument()).not.toHaveProperty('properties.suggestions');
  });

  it('validates a response the engine actually produced', async () => {
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validate = ajv.compile(JSON.parse(committed) as object);
    for (const output of ['TODO: write the summary.', 'The customer record is complete and the invoice was sent on Tuesday.']) {
      const result = await engine.evaluateAll({ output, input: 'summarise the account' });
      const response = toEvaluationResponse(result, { traceId: 'trace-1' });
      expect(validate(response), `${output.slice(0, 20)}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });
});
