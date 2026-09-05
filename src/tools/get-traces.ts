import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { strictInput } from './strict-input.js';

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
  limit: z.number().int().min(1).max(1000).default(50).describe('Results per page (default 50, max 1000 — values >1000 return 400)'),
  offset: z.number().int().min(0).default(0).describe('Zero-based pagination offset — skip first N results (non-negative integer)'),
  sort_by: z.enum(['timestamp', 'latency_ms', 'cost_usd']).default('timestamp').describe('Sort by timestamp | latency_ms | cost_usd (default timestamp)'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort order: asc | desc (default desc — most recent / highest first)'),
  include_summary: z.boolean().default(false).describe('Include dashboard summary stats in same response — saves a round-trip when ingesting for dashboards'),
};

// Cross-field range checks — see addTraceRangeIssues above.
const inputSchemaWithRanges = strictInput(inputSchema).superRefine(addTraceRangeIssues);

export function registerGetTracesTool(server: McpServer, storage: IStorageAdapter): void {
  server.registerTool(
    'get_traces',
    {
      title: 'Get Traces',
      description: [
        'Query stored agent-execution traces with filters, pagination, and optional dashboard summary.',
        '',
        'Sibling tools — log_trace creates traces, delete_trace removes a single trace, evaluate_output / evaluate_with_llm_judge / verify_citations score them, list_rules / deploy_rule / delete_rule manage the custom-rule lifecycle. get_traces is the READ path for historical agent executions — never mutates anything.',
        '',
        'Behavior. Read-only: never mutates storage, never calls external services. Idempotent: repeated calls with the same args return consistent results (new traces logged after the call obviously show up on subsequent calls). Tenant-scoped: queries only the caller\'s tenant rows (LOCAL_TENANT in OSS). Paginates results (default limit 50, max 1000). Rate-limited to 20 req/min on HTTP MCP, unlimited on stdio.',
        '',
        'Output shape. Returns JSON: `{ "traces": [{...traceRow}], "total": number, "limit": number, "offset": number, "summary"?: { total_traces, avg_latency_ms, total_cost_usd, error_rate, eval_pass_rate, traces_per_hour, top_agents } }`. Each trace row includes trace_id, agent_name, framework, input, output, tool_calls, latency_ms, token_usage, cost_usd, metadata, timestamp. `summary` only included when `include_summary: true`.',
        '',
        'Use when you need historical data: investigating a past failure, computing quality trends, comparing agents, or feeding an analytics job. Set `agent_name` / `framework` / `since` / `until` to narrow the query. Set `min_score` / `max_score` to surface outliers. Set `sort_by: "cost_usd"` + `sort_order: "desc"` to find the most expensive traces. Set `include_summary: true` when you want dashboard-style aggregates in one round-trip.',
        '',
        'Don\'t use to score a trace (use evaluate_output). Don\'t use to create a trace (use log_trace). Don\'t use as a live event stream — it\'s a query, not a subscription, and Iris has no event-stream endpoint; poll with exponential backoff.',
        '',
        'Parameters. limit defaults to 50, max 1000 (anything higher returns 400). offset is zero-based pagination (non-negative integer). since / until must be ISO 8601 timestamps or dates — `since` is inclusive (timestamp >= since), `until` is inclusive (timestamp <= until), and `since` may not be later than `until`. min_score / max_score are 0..1 and filter on the LATEST eval per trace, not all evals (so a trace with one failing + one passing eval may or may not match depending on which landed last); min_score may not exceed max_score. Combining since + sort_by="latency_ms" + sort_order="desc" is the canonical "find slow recent traces" query. include_summary returns dashboard-style aggregates in the SAME response (saves a round-trip; use true for dashboard ingest, false for analytics queries that don\'t need them). agent_name and framework are exact-match (no wildcards). Defaults: limit=50, offset=0, sort_by="timestamp", sort_order="desc", include_summary=false.',
        '',
        'Error modes. Returns 400 on invalid sort_by / sort_order (Zod enum). Returns 400 if limit > 1000 or offset < 0. Returns 400 — naming both values — on an empty range: min_score > max_score, since later than until, a score outside 0..1, or a since/until that is not an ISO 8601 timestamp or date (an unparseable bound is refused, never silently ignored). Returns 429 when HTTP rate limit exceeded. Storage failures propagate as 500. Empty result with `total: 0` on no matches (not an error).',
      ].join('\n'),
      inputSchema: inputSchemaWithRanges,
      annotations: {
        readOnlyHint: true,      // Pure query: never writes, never deletes
        destructiveHint: false,  // Inverse of readOnly — trivially false
        idempotentHint: true,    // Same args → same result (modulo new traces that may have landed since)
        openWorldHint: false,    // Queries local storage only; no external network
      },
    },
    async (args) => {
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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(response),
          },
        ],
      };
    },
  );
}
