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
 * `errorResult` is the failure shape: the IrisError envelope as the text,
 * `isError: true`, and a link to iris://capabilities. It carries no
 * structuredContent (see there). `failureResult` builds it from whatever
 * was thrown, and `guarded` wraps a handler with it, so nothing thrown
 * inside a handler reaches the SDK's flattener.
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

/**
 * A tool's failure: the envelope as JSON text, `isError: true`, and a link
 * to iris://capabilities.
 *
 * The envelope is not sent as `structuredContent`. A tool's structured
 * content is what its output schema describes, and that schema describes
 * the tool's answer, not this envelope: a client built on the MCP
 * TypeScript SDK checks structured content against the schema on every
 * result once it has listed the tools, an error result's too, and threw the
 * whole result away ("Structured content does not match the tool's output
 * schema"). The code, the message and the recovery steps never reached it.
 * Sent as text alone, the envelope passes both of that SDK's checks: its
 * server does not check an error result against the output schema, and its
 * client checks structured content only where there is some (measured on
 * 1.32.2, the version this server builds against). The text is the same
 * object.
 */
export function errorResult(err: IrisError): CallToolResult {
  const body = normalise({ error: err.envelope });
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }, linkItem(CAPABILITIES_LINK)],
    isError: true,
  };
}

/**
 * The result for whatever a handler, or the gate in front of it, failed
 * with. A promise can reject with anything, and a value the mapping itself
 * cannot read (it reads the value's class and its fields) is answered as
 * the internal error rather than let past as a flattened line.
 */
export function failureResult(err: unknown): CallToolResult {
  let mapped: IrisError;
  try {
    mapped = toIrisError(err);
  } catch {
    mapped = toIrisError(undefined);
  }
  return errorResult(mapped);
}

/** Wrap a handler so every failure returns an envelope instead of a flattened line. */
export function guarded<A extends unknown[]>(
  fn: (...args: A) => Promise<CallToolResult> | CallToolResult,
): (...args: A) => Promise<CallToolResult> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      return failureResult(err);
    }
  };
}

/** Links for what an evaluation created: the evaluation, and the trace when linked. */
export function evaluationLinks(evalId: string, traceId?: string): ResourceLink[] {
  const links: ResourceLink[] = [{ uri: evaluationUri(evalId), name: `evaluation ${evalId}`, description: 'The stored evaluation, as every reader sees it' }];
  if (traceId) links.push({ uri: traceUri(traceId), name: `trace ${traceId}`, description: 'The trace this evaluation is linked to, with its spans and every evaluation' });
  return links;
}
