import { z } from 'zod';
import { logTraceInputShape } from '../tools/log-trace.js';

/*
 * POST /api/v1/traces body — the log_trace tool contract plus the
 * HTTP-only evaluation opt-in. Built FROM logTraceInputShape rather than
 * restating it so the two capture paths (MCP tool, HTTP ingest) cannot
 * drift. `trace_id` is deliberately absent: the server mints it, and
 * zod's default unknown-key stripping discards any client-supplied one.
 */
export const ingestTraceSchema = z
  .object({
    ...logTraceInputShape,
    evaluate: z.boolean().default(false),
    eval_type: z.enum(['completeness', 'relevance', 'safety', 'cost', 'custom']).default('completeness'),
  })
  .superRefine((body, ctx) => {
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
