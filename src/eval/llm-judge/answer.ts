/*
 * The object a judge answers with, as each provider is asked for it.
 *
 * A judge is asked for its answer as structured output where the provider
 * and the model offer it (client.ts): Anthropic's `output_config.format`,
 * OpenAI's `json_schema` response format in strict mode. The answer then
 * arrives as the object alone, held to the schema by the provider, and is
 * read whole; prose has nowhere to stand.
 *
 * One schema serves both providers, so it keeps to what both accept: every
 * object names all of its keys, requires every one, and allows no other
 * (`additionalProperties: false`), and no number carries a bound, which
 * Anthropic's schemas refuse. A score's range is read after the reply
 * arrives (reply.ts, unitNumber), as it always was.
 */

/** What a judge is asked to answer with: a name for the format (OpenAI's `json_schema.name`) and its JSON Schema. */
export interface JudgeAnswer {
  name: string;
  schema: Record<string, unknown>;
}

type FieldType = 'number' | 'boolean' | 'string';

/** An object of the fields named, each of the type given, every one required, and no other. */
function closedObject(fields: Record<string, FieldType | Record<string, unknown>>): Record<string, unknown> {
  const properties = Object.fromEntries(
    Object.entries(fields).map(([key, type]) => [key, typeof type === 'string' ? { type } : type]),
  );
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

/**
 * A judge template's answer: a score, the model's own pass, a rationale, and
 * the three dimensions the template names (templates/index.ts), in the order
 * the template's prompt asks for them.
 */
export function verdictAnswer(dimensions: readonly string[]): JudgeAnswer {
  return {
    name: 'verdict',
    schema: closedObject({
      score: 'number',
      passed: 'boolean',
      rationale: 'string',
      dimensions: closedObject(Object.fromEntries(dimensions.map((d) => [d, 'number' as const]))),
    }),
  };
}

/** The citation judge's answer: whether the source supports the claim, how sure it is, and why. */
export const CITATION_ANSWER: JudgeAnswer = {
  name: 'citation_verdict',
  schema: closedObject({ supported: 'boolean', confidence: 'number', rationale: 'string' }),
};
