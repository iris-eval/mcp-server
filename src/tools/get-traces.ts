import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { strictInput } from './strict-input.js';
import { describeTool, ERROR_ENVELOPE_SENTENCE } from './describe.js';
import { guarded, respond } from './respond.js';

/*
 * An ISO-8601 instant (2026-08-01T00:00:00Z, offsets allowed) or calendar
 * date (2026-08-01). Stored timestamps are ISO strings and the adapter
 * compares them lexically, so both forms bound the query correctly; a
 * date-only value is the natural "since the 1st" spelling and is kept
 * rather than forced into a full timestamp.
 */
const isoInstant = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
export function isIsoTimestamp(value: string): boolean {
  return isoInstant.safeParse(value).success || isoDate.safeParse(value).success;
}
const TIMESTAMP_HINT = 'must be an ISO 8601 timestamp (e.g. 2026-08-01T00:00:00Z) or date (2026-08-01)';
/**
 * The `since` / `until` field schema. Shared with the dashboard's trace
 * query (dashboard/validation.ts) so both read paths refuse the same
 * unparseable bounds with the same hint.
 */
export const isoTimestamp = z.string().refine(isIsoTimestamp, {
  // The rejected value is echoed so the error names what was sent, as the
  // crossed-bound errors already do (v0.6.0 acceptance pass, B8/C9).
  error: (issue) => `${JSON.stringify(issue.input)} ${TIMESTAMP_HINT}`,
});

/** The cross-field bounds a trace query can carry. */
export interface TraceRangeArgs {
  min_score?: number;
  max_score?: number;
  since?: string;
  until?: string;
}

/**
 * Cross-field checks the per-field schema cannot express (#373). A range
 * whose bounds cross — min_score 0.9 / max_score 0.1, or since after until
 * — used to be accepted and return an empty page, which reads as "no such
 * traces" when the truth is "no trace could ever match this". Refusing it
 * with the two values named is what the argument descriptions promise.
 *
 * One function for both read paths: `get_traces` (MCP) and
 * `GET /api/v1/traces` (dashboard) call it from their `superRefine`, so a
 * bound the tool rejects is never one the HTTP query quietly accepts.
 */
export function addTraceRangeIssues(args: TraceRangeArgs, ctx: z.RefinementCtx): void {
  if (args.min_score !== undefined && args.max_score !== undefined && args.min_score > args.max_score) {
    ctx.addIssue({
      code: 'custom',
      path: ['min_score'],
      message: `min_score (${args.min_score}) must be <= max_score (${args.max_score}) — the range is empty and no trace could match it`,
    });
  }
  if (args.since !== undefined && args.until !== undefined && Date.parse(args.since) > Date.parse(args.until)) {
    ctx.addIssue({
      code: 'custom',
      path: ['since'],
      message: `since (${args.since}) must not be later than until (${args.until}) — the window is empty and no trace could match it`,
    });
  }
}

const inputSchema = {
  agent_name: z.string().optional().describe('Filter by agent name — exact match (no wildcards)'),
  framework: z.string().optional().describe('Filter by agent framework — exact match (e.g., langchain, autogen)'),
  since: isoTimestamp.optional().describe('ISO 8601 timestamp (or date) lower bound — return traces with timestamp >= this; anything that is not an ISO timestamp is rejected, never treated as "no bound"'),
  until: isoTimestamp.optional().describe('ISO 8601 timestamp (or date) upper bound — return traces with timestamp <= this; must not be earlier than `since`'),
  min_score: z.number().min(0).max(1).optional().describe('Minimum eval score filter (0..1; values outside are rejected) — applied to LATEST eval per trace, not all evals; must be <= max_score when both are set'),
  max_score: z.number().min(0).max(1).optional().describe('Maximum eval score filter (0..1; values outside are rejected) — applied to LATEST eval per trace'),
  // Mirrors traceQuerySchema in dashboard/validation.ts — both capture paths
  // (MCP tool, HTTP query) enforce the same 1..1000 bound. Unclamped, limit:-1
  // meant "LIMIT -1" in SQLite, i.e. every row (#332).
  limit: z.number().int().min(1).max(1000).default(50).describe('Results per page (default 50, max 1000 — values above are rejected)'),
  offset: z.number().int().min(0).default(0).describe('Zero-based pagination offset — skip first N results (non-negative integer)'),
  sort_by: z.enum(['timestamp', 'latency_ms', 'cost_usd']).default('timestamp').describe('Sort by timestamp | latency_ms | cost_usd (default timestamp)'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort order: asc | desc (default desc — most recent / highest first)'),
  include_summary: z.boolean().default(false).describe('Include dashboard summary stats in same response — saves a round-trip when ingesting for dashboards'),
};

// Cross-field range checks — see addTraceRangeIssues above.
const inputSchemaWithRanges = strictInput(inputSchema).superRefine(addTraceRangeIssues);

export const getTracesOutputSchema = z.looseObject({
  traces: z.array(z.looseObject({ trace_id: z.string() })).describe('the page of traces: trace_id, agent_name, framework, input, output, tool_calls, latency_ms, token_usage, cost_usd, metadata, timestamp'),
  total: z.number().int().describe('how many traces match the filters, across every page'),
  limit: z.number().int().describe('the page size applied'),
  offset: z.number().int().describe('the offset applied'),
  summary: z.looseObject({}).optional().describe('the dashboard aggregates for the last hour, when include_summary was true'),
});

export function registerGetTracesTool(server: McpServer, storage: IStorageAdapter): void {
  server.registerTool(
    'get_traces',
    {
      title: 'Get Traces',
      description: describeTool({
        summary: 'Query stored traces with filters, pagination and sorting; optionally include the dashboard summary in the same response.',
        does:
          'Read-only, local storage only. Filters are exact-match (agent_name, framework), inclusive time bounds (since, until — an ISO 8601 timestamp or date) and a score range applied to the LATEST evaluation of each trace (min_score, max_score, 0..1). ' +
          'limit is 1..1000 (default 50), offset counts from 0, sort_by is timestamp, latency_ms or cost_usd, sort_order asc or desc (default: newest first). include_summary adds the one-hour dashboard aggregates. ' +
          'A crossed range (min above max, since after until) is refused naming both values rather than returning an empty page that reads as "no such traces".',
        whenNot:
          'To score a trace (evaluate_output). To create one (log_trace). As a live stream: this is a query, and Iris has no event stream — poll with backoff.',
        returns: getTracesOutputSchema,
        errors:
          'IRIS_STORAGE_ERROR when the database cannot be read. An out-of-range or crossed bound is refused before the handler runs, naming the values. An empty result is total 0, not an error. ' +
          ERROR_ENVELOPE_SENTENCE,
        siblings: {
          log_trace: 'record an execution',
          evaluate_output: 'score one output',
          delete_trace: 'remove one trace',
        },
      }),
      inputSchema: inputSchemaWithRanges,
      outputSchema: getTracesOutputSchema,
      annotations: {
        readOnlyHint: true,      // Pure query: never writes, never deletes
        destructiveHint: false,  // Inverse of readOnly — trivially false
        idempotentHint: true,    // Same args → same result (modulo new traces that may have landed since)
        openWorldHint: false,    // Queries local storage only; no external network
      },
    },
    guarded(async (args) => {
      // OSS single-tenant: MCP caller is the local user.
      const result = await storage.queryTraces(LOCAL_TENANT, {
        filter: {
          agent_name: args.agent_name,
          framework: args.framework,
          since: args.since,
          until: args.until,
          min_score: args.min_score,
          max_score: args.max_score,
        },
        limit: args.limit,
        offset: args.offset,
        sort_by: args.sort_by as 'timestamp' | 'latency_ms' | 'cost_usd',
        sort_order: args.sort_order as 'asc' | 'desc',
      });

      const response: Record<string, unknown> = {
        traces: result.traces,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      };

      if (args.include_summary) {
        response.summary = await storage.getDashboardSummary(LOCAL_TENANT);
      }

      return respond(getTracesOutputSchema, response);
    }),
  );
}
