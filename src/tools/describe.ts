/*
 * One template for every tool description.
 *
 * The nine descriptions used to be nine essays (the longest ran to 1,400
 * words) written at different times, so the same fact was stated in
 * several tenses and the prose could disagree with the schema. Now each is
 * five fixed headings in a fixed order, the "Returns" heading is GENERATED
 * from the tool's output schema (a field's description lives on the
 * schema once; the prose cannot say something the schema does not), and a
 * word cap is enforced at registration, so an overlong description fails
 * every test instead of costing every agent context.
 *
 * The frame an agent needs before it lists tools — what Iris is, how to
 * read a verdict, what the judge needs — travels once, in the server
 * instructions (src/instructions.ts), not in nine copies here.
 */
import type { z } from 'zod';

export const DESCRIPTION_HEADINGS = ['What it does.', 'When not to use it.', 'Returns.', 'Errors.', 'Siblings.'] as const;
export const DESCRIPTION_WORD_CAP = 450;

export interface ToolDescriptionSpec {
  /** One sentence: what calling this does. */
  summary: string;
  does: string;
  whenNot: string;
  /** The tool's output schema; every top-level field must carry a description. */
  returns: z.ZodObject<z.ZodRawShape>;
  errors: string;
  /** Sibling tool → one clause on when it is the better call. */
  siblings: Record<string, string>;
}

/** `field` (its description); … — from the schema, never retyped. */
export function returnsFrom(schema: z.ZodObject<z.ZodRawShape>): string {
  const parts: string[] = [];
  for (const [key, field] of Object.entries(schema.shape)) {
    const description = (field as { description?: string }).description;
    if (!description) throw new Error(`output field "${key}" has no description; add .describe() on the schema`);
    parts.push(`\`${key}\` (${description})`);
  }
  return `JSON with ${parts.join('; ')}.`;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function describeTool(spec: ToolDescriptionSpec): string {
  const siblings = Object.entries(spec.siblings)
    .map(([name, when]) => `${name} — ${when}`)
    .join('; ');
  const text = [
    spec.summary,
    `${DESCRIPTION_HEADINGS[0]} ${spec.does}`,
    `${DESCRIPTION_HEADINGS[1]} ${spec.whenNot}`,
    `${DESCRIPTION_HEADINGS[2]} ${returnsFrom(spec.returns)}`,
    `${DESCRIPTION_HEADINGS[3]} ${spec.errors}`,
    `${DESCRIPTION_HEADINGS[4]} ${siblings}.`,
  ].join('\n\n');
  const words = wordCount(text);
  if (words > DESCRIPTION_WORD_CAP) {
    throw new Error(`tool description is ${words} words; the cap is ${DESCRIPTION_WORD_CAP}`);
  }
  return text;
}

/** The sentence every "Errors" heading ends with, so the envelope is stated once. */
export const ERROR_ENVELOPE_SENTENCE =
  'Every failure returns {"error":{"code","message","recovery":[]}} with isError true; follow recovery before retrying.';
