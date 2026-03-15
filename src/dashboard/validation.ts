import { z } from 'zod';

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
