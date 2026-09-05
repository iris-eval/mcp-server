/*
 * One way to answer a tool call.
 *
 * `respond` parses the payload through the tool's own output schema
 * BEFORE serialising it — a field the schema does not describe fails a
 * test, not a user — and emits the same object twice: as the text a
 * client without structured-content support reads, and as
 * `structuredContent` for one that has it. Beside the payload go
 * `resource_link` items for what the call created and what explains its
 * limits, so a client can follow them with resources/read instead of
 * guessing a URI.
 *
 * `errorResult` is the failure shape: the IrisError envelope as the text
 * and as structuredContent, `isError: true`, and a link to
 * iris://capabilities. `guarded` wraps a handler so nothing thrown inside
 * it reaches the SDK's flattener.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ERROR_CODE_CATALOGUE, IrisError, toIrisError } from './errors.js';
import { CAPABILITIES_RESOURCE_URI, evaluationUri, traceUri } from '../resources/uris.js';

export const CAPABILITIES_URI = CAPABILITIES_RESOURCE_URI;

export interface ResourceLink {
  uri: string;
  name: string;
  description?: string;
}

export const CAPABILITIES_LINK: ResourceLink = {
  uri: CAPABILITIES_URI,
  name: 'capabilities',
  description: 'What this server can judge, what each rule needs, judge state, limits, tools and resources',
};

const linkItem = (l: ResourceLink) => ({
  type: 'resource_link' as const,
  uri: l.uri,
  name: l.name,
  ...(l.description ? { description: l.description } : {}),
  mimeType: 'application/json',
});

/** JSON round-trip: what the text carries is exactly what structuredContent carries. */
function normalise(payload: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

export function respond<S extends z.ZodType>(schema: S, payload: object, links: ResourceLink[] = []): CallToolResult {
  const body = normalise(payload);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // A programming error: the tool built a response its own schema does
    // not describe. Loud on purpose — the drift-lock tests catch it.
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`);
    throw new Error(`response does not match the tool's output schema: ${issues.join('; ')}`);
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }, ...links.map(linkItem)],
    structuredContent: body,
  };
}

export const errorEnvelopeSchema = z.looseObject({
  error: z.looseObject({
    code: z.enum(ERROR_CODE_CATALOGUE),
    message: z.string(),
    recovery: z.array(z.string()),
    retryable: z.boolean(),
    field: z.string().optional(),
    valid: z.array(z.string()).optional(),
    see: z.string().optional(),
    kind: z.string().optional(),
    retryAfterMs: z.number().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export function errorResult(err: IrisError): CallToolResult {
  const body = normalise({ error: err.envelope });
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }, linkItem(CAPABILITIES_LINK)],
    structuredContent: body,
    isError: true,
  };
}

/** Wrap a handler so every failure returns an envelope instead of a flattened line. */
export function guarded<A extends unknown[]>(
  fn: (...args: A) => Promise<CallToolResult> | CallToolResult,
): (...args: A) => Promise<CallToolResult> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResult(toIrisError(err));
    }
  };
}

/** Links for what an evaluation created: the evaluation, and the trace when linked. */
export function evaluationLinks(evalId: string, traceId?: string): ResourceLink[] {
  const links: ResourceLink[] = [{ uri: evaluationUri(evalId), name: `evaluation ${evalId}`, description: 'The stored evaluation, as every reader sees it' }];
  if (traceId) links.push({ uri: traceUri(traceId), name: `trace ${traceId}`, description: 'The trace this evaluation is linked to, with its spans and every evaluation' });
  return links;
}
