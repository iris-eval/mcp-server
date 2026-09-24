/*
 * The output schema a tool ADVERTISES in tools/list: its top-level field
 * names, each with its type and optionality, and every nested object or
 * array collapsed to its container type.
 *
 * The full schema still decides what a tool may return: `respond` parses
 * every payload through it before anything is sent (src/tools/respond.ts),
 * so a response the full schema does not describe fails a test, never a
 * user. What changes is only what every client is sent at tools/list, which
 * the agent under evaluation pays for in context on every session. What
 * each field means is served once, on request, as `toolGuide.<tool>.returns`
 * in iris://capabilities (read from the full schema, so it cannot drift),
 * and the nested shape of an evaluation is published as JSON Schema at
 * https://iris-eval.com/response-schema-v1.json.
 *
 * The advertised schema accepts everything the full one accepts: it keeps
 * each field's optionality and nullability, loosens only what is nested,
 * and allows extra keys, so the SDK's own check of structuredContent
 * against it cannot reject a response the full schema passed.
 */
import { z } from 'zod';

type Def = { type: string; innerType?: z.ZodType };
const defOf = (s: z.ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

/** The field with its container contents replaced; wrappers (optional, nullable, default) kept. */
function shallow(field: z.ZodType): z.ZodType {
  const def = defOf(field);
  switch (def.type) {
    case 'optional':
      return shallow(def.innerType!).optional();
    case 'nullable':
      return shallow(def.innerType!).nullable();
    case 'default':
    case 'prefault':
      // The payload is checked before the default fills it in, so it may be absent.
      return shallow(def.innerType!).optional();
    case 'readonly':
      return shallow(def.innerType!);
    case 'object':
      return z.looseObject({});
    case 'array':
      return z.array(z.unknown());
    case 'record':
      return z.record(z.string(), z.unknown());
    // Scalars are rebuilt rather than reused, so no description or bound
    // rides along: an integer check alone renders as ±2^53 on every count.
    case 'number':
      return z.number();
    case 'string':
      return z.string();
    case 'boolean':
      return z.boolean();
    case 'enum':
      return z.enum((field as z.ZodEnum).options as [string, ...string[]]);
    case 'literal':
      return z.literal((def as unknown as { values: z.core.util.Literal[] }).values);
    default:
      // Unions, pipes and anything else nested.
      return z.unknown();
  }
}

/** Where the nested shape of an evaluation is published in full. */
export const NESTED_SHAPES_NOTE = 'Nested evaluation fields: https://iris-eval.com/response-schema-v1.json';

export function advertisedOutput(schema: z.ZodObject<z.ZodRawShape>, description?: string): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    shape[key] = shallow(field as z.ZodType);
  }
  const advertised = z.looseObject(shape);
  return description ? advertised.describe(description) : advertised;
}
