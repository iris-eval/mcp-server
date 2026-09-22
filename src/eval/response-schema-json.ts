/*
 * The published response schema, rendered from the one that validates (arc 9, N-22).
 *
 * `evaluateOutputResponseSchema` is what `evaluate_output` actually returns
 * and what the tool advertises as its `outputSchema`. Until now a consumer
 * who wanted to generate types, validate a stored response, or write a
 * client in another language had to read the zod source. This renders that
 * same schema as JSON Schema 2020-12 and publishes it at
 * https://iris-eval.com/response-schema-v1.json.
 *
 * Rendered, never hand-kept: a hand-written schema beside a zod schema is
 * two definitions of one response, and the day they disagree the published
 * one is the lie, because nothing validates against it.
 * tests/response-schema-published.test.ts fails when the committed file
 * differs from this render.
 *
 * The `v1` in the name is a promise about the SHAPE, not the version of
 * Iris: a field may be added, and a field that must be removed or re-meant
 * takes a v2 file beside this one, so a consumer pinned to v1 keeps a
 * schema that describes what it was written against.
 */
import { z } from 'zod';
import { evaluateOutputResponseSchema } from './response-schema.js';

export const RESPONSE_SCHEMA_ID = 'https://iris-eval.com/response-schema-v1.json';
export const RESPONSE_SCHEMA_PATH = 'website/public/response-schema-v1.json';

/**
 * The published document: the rendered schema with its identity on the
 * front. `io: 'output'` renders what a reader RECEIVES (the zod input and
 * output types differ wherever a default or a coercion is declared), and
 * `unrepresentable: 'any'` keeps a refinement — a rule JSON Schema has no
 * word for — from aborting the render; the field still appears with its
 * type, only the extra constraint is unstated.
 */
export function responseSchemaDocument(): Record<string, unknown> {
  const rendered = z.toJSONSchema(evaluateOutputResponseSchema, {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  // The renderer emits its own `$schema`; the identity goes in front of it.
  const { $schema, ...body } = rendered;
  return {
    $schema: $schema ?? 'https://json-schema.org/draft/2020-12/schema',
    $id: RESPONSE_SCHEMA_ID,
    title: 'Iris evaluation response (schema version 1)',
    description:
      "The object the evaluate_output MCP tool returns, and the `evaluation` block POST /api/v1/traces returns when asked to evaluate. Rendered from the schema the server validates against; see https://iris-eval.com/capabilities for what each field means.",
    ...body,
  };
}

/** The document as it is committed: two-space JSON with a trailing newline. */
export function renderResponseSchema(): string {
  return `${JSON.stringify(responseSchemaDocument(), null, 2)}\n`;
}
