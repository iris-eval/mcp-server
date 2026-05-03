import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { LOCAL_TENANT } from '../types/tenant.js';

const inputSchema = {
  agent_name: z.string().optional().describe('Filter by agent name — exact match (no wildcards in v0.4)'),
  framework: z.string().optional().describe('Filter by agent framework — exact match (e.g., langchain, autogen)'),
  since: z.string().optional().describe('ISO timestamp lower bound — return traces with timestamp >= this'),
  until: z.string().optional().describe('ISO timestamp upper bound — return traces with timestamp < this'),
  min_score: z.number().optional().describe('Minimum eval score filter (0..1) — applied to LATEST eval per trace, not all evals'),
  max_score: z.number().optional().describe('Maximum eval score filter (0..1) — applied to LATEST eval per trace'),
  limit: z.number().default(50).describe('Results per page (default 50, max 1000 — values >1000 return 400)'),
  offset: z.number().default(0).describe('Zero-based pagination offset — skip first N results'),
  sort_by: z.enum(['timestamp', 'latency_ms', 'cost_usd']).default('timestamp').describe('Sort by timestamp | latency_ms | cost_usd (default timestamp)'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort order: asc | desc (default desc — most recent / highest first)'),
  include_summary: z.boolean().default(false).describe('Include dashboard summary stats in same response — saves a round-trip when ingesting for dashboards'),
};

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
        'Don\'t use to score a trace (use evaluate_output). Don\'t use to create a trace (use log_trace). Don\'t use as a live event stream — it\'s a query, not a subscription; poll with exponential backoff or use the dashboard\'s SSE endpoint for real-time.',
        '',
        'Parameters. limit defaults to 50, max 1000 (anything higher returns 400). offset is zero-based pagination. min_score / max_score filter on the LATEST eval per trace, not all evals (so a trace with one failing + one passing eval may or may not match depending on which landed last). Combining since + sort_by="latency_ms" + sort_order="desc" is the canonical "find slow recent traces" query. include_summary returns dashboard-style aggregates in the SAME response (saves a round-trip; use true for dashboard ingest, false for analytics queries that don\'t need them). agent_name and framework are exact-match (no wildcards in v0.4). Defaults: limit=50, offset=0, sort_by="timestamp", sort_order="desc", include_summary=false.',
        '',
        'Error modes. Returns 400 on invalid sort_by / sort_order (Zod enum). Returns 400 if limit > 1000. Returns 429 when HTTP rate limit exceeded. Storage failures propagate as 500. Empty result with `total: 0` on no matches (not an error).',
      ].join('\n'),
      inputSchema,
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
