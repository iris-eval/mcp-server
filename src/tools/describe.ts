/*
 * One template for every tool description.
 *
 * Every description is five fixed headings in a fixed order, and the
 * "Returns" heading is GENERATED from the tool's output schema, so the
 * prose cannot name a field the schema does not have.
 *
 * tools/list is paid for in context on every session of the agent being
 * evaluated, so a description carries only what an agent needs to choose
 * and call the tool, and a size cap is enforced at registration: an
 * overlong description fails every test instead of costing every agent.
 * The long explanation of each tool — thresholds, algorithms, caveats —
 * lives in src/tools/guide.ts and is served once, on request, as
 * `toolGuide` in iris://capabilities. Field meanings live on the output
 * schema's field descriptions, so the Returns heading names the fields and
 * does not repeat them.
 *
 * The frame an agent needs before it lists tools — what Iris is, how to
 * read a verdict, what the judge needs — travels once, in the server
 * instructions (src/instructions.ts), not in a copy per tool.
 */
import type { z } from 'zod';

export const DESCRIPTION_HEADINGS = ['What it does.', 'When not to use it.', 'Returns.', 'Errors.', 'Siblings.'] as const;
/** UTF-8 bytes. About 250 tokens: enough to choose and call a tool, not to teach it. */
export const DESCRIPTION_BYTE_CAP = 1024;

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

/** The top-level field names, from the schema; each field's meaning is its own description there. */
export function returnsFrom(schema: z.ZodObject<z.ZodRawShape>): string {
  const names: string[] = [];
  for (const [key, field] of Object.entries(schema.shape)) {
    const description = (field as { description?: string }).description;
    if (!description) throw new Error(`output field "${key}" has no description; add .describe() on the schema`);
    names.push(key);
  }
  return `JSON: ${names.join(', ')}.`;
}

export function descriptionBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Where the long form of every tool's behaviour is served. */
export const GUIDE_SENTENCE = 'Full detail: iris://capabilities.';

export function describeTool(spec: ToolDescriptionSpec): string {
  const siblings = Object.entries(spec.siblings)
    .map(([name, when]) => `${name} — ${when}`)
    .join('; ');
  const text = [
    spec.summary,
    `${DESCRIPTION_HEADINGS[0]} ${spec.does} ${GUIDE_SENTENCE}`,
    `${DESCRIPTION_HEADINGS[1]} ${spec.whenNot}`,
    `${DESCRIPTION_HEADINGS[2]} ${returnsFrom(spec.returns)}`,
    `${DESCRIPTION_HEADINGS[3]} ${spec.errors}`,
    `${DESCRIPTION_HEADINGS[4]} ${siblings}.`,
  ].join('\n\n');
  const bytes = descriptionBytes(text);
  if (bytes > DESCRIPTION_BYTE_CAP) {
    throw new Error(`tool description is ${bytes} bytes; the cap is ${DESCRIPTION_BYTE_CAP}`);
  }
  return text;
}

/** The sentence every "Errors" heading ends with, so the envelope is stated once. */
export const ERROR_ENVELOPE_SENTENCE = 'Failures return {"error":{code,message,recovery}} with isError; follow recovery.';
