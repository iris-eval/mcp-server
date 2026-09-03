import { z } from 'zod';
import { logTraceInputShape } from '../tools/log-trace.js';

/*
 * Strict request-body schema for the dashboard's MUTATING routes.
 *
 * A bare z.object() silently STRIPS unknown keys. On a read route that is
 * merely lenient; on a write route it is the exact defect v0.5.0 fixed at
 * the MCP boundary (tools/strict-input.ts) and then left open on its HTTP
 * twin: `POST /api/v1/traces {evaluate: true, eval_typ: "safety", output:
 * "<PII>"}` dropped the misspelled key, ran the DEFAULT completeness
 * bundle, and returned a green result with nothing saying an argument had
 * been ignored. Same family, one transport over (#376 item 2).
 *
 * `reserved` names keys the server owns and a client must never send —
 * each gets a pointed sentence appended to the rejection so the caller
 * learns WHY (e.g. trace_id is server-minted) instead of just "unknown".
 */
export function strictBody<T extends z.ZodRawShape>(
  shape: T,
  opts?: { reserved?: Record<string, string> },
) {
  const validKeys = Object.keys(shape).join(', ');
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== 'unrecognized_keys') return undefined;
      const reservedNotes = issue.keys
        .filter((k) => opts?.reserved?.[k] !== undefined)
        .map((k) => ` ${opts!.reserved![k]}`)
        .join('');
      return (
        `Unknown key(s): ${issue.keys.map((k) => `"${k}"`).join(', ')}. ` +
        `Valid keys: ${validKeys}. ` +
        'Unknown keys are rejected rather than silently dropped, so a misspelled field ' +
        'cannot change what gets stored or evaluated — check the spelling and retry.' +
        reservedNotes
      );
    },
  });
}

/*
 * POST /api/v1/traces body — the log_trace tool contract plus the
 * HTTP-only evaluation opt-in. Built FROM logTraceInputShape rather than
 * restating it so the two capture paths (MCP tool, HTTP ingest) cannot
 * drift.
 *
 * `trace_id` is deliberately absent: the server mints it. This schema
 * used to rely on default unknown-key stripping to discard a client-
 * supplied one — which also discarded every misspelled field. It is now
 * strict, and a client-supplied trace_id is REJECTED with a message that
 * says the server owns it, rather than silently replaced.
 */
export const ingestTraceSchema = strictBody(
  {
    ...logTraceInputShape,
    evaluate: z.boolean().default(false),
    eval_type: z.enum(['completeness', 'relevance', 'safety', 'cost', 'custom']).default('completeness'),
  },
  {
    reserved: {
      trace_id:
        'trace_id is minted by the server on every ingest and cannot be supplied by the client — ' +
        'read it from the 201 response instead.',
    },
  },
).superRefine((body, ctx) => {
  if (body.evaluate && body.output === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['output'],
      message: '"output" is required when "evaluate" is true — the eval engine scores the output text',
    });
  }
});

export const traceQuerySchema = z.object({
  agent_name: z.string().optional(),
  framework: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sort_by: z.enum(['timestamp', 'latency_ms', 'cost_usd']).default('timestamp'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export const evalQuerySchema = z.object({
  eval_type: z.string().optional(),
  passed: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const summaryQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(8760).default(24),
});

export const evalStatsPeriodSchema = z.object({
  period: z.enum(['24h', '2d', '7d', '14d', '30d', '60d', '90d', '180d', 'all']).default('24h'),
});

export const evalStatsFailuresSchema = z.object({
  period: z.enum(['24h', '2d', '7d', '14d', '30d', '60d', '90d', '180d', 'all']).default('24h'),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export const failuresQuerySchema = z.object({
  agent_name: z.string().min(1).max(200).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
