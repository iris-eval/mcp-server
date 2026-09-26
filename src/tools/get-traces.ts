import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { strictInput } from './strict-input.js';
import { describeTool, ERROR_ENVELOPE_SENTENCE } from './describe.js';
import { advertisedOutput } from './advertise.js';
import { guarded, respond } from './respond.js';
import { parseSearch, SEARCH_MAX_LENGTH } from '../storage/search.js';

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
  q?: string;
  sort_by?: string;
}

/**
 * The search text (#7), shared by both read paths. Any string is safe to
 * send — it is parsed into terms, never passed to SQLite as query syntax
 * (src/storage/search.ts) — so the only refusals are length and a query
 * with no word in it at all, which would otherwise read as "no matches".
 */
export const traceSearchText = z.string().max(SEARCH_MAX_LENGTH, { error: `q is at most ${SEARCH_MAX_LENGTH} characters` });

/** Blank search text is no search: an empty search box, not a query for nothing. */
export function searchOf(q: string | undefined): string | undefined {
  return q !== undefined && q.trim() !== '' ? q : undefined;
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
  const q = searchOf(args.q);
  if (q !== undefined && parseSearch(q).terms.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['q'],
      message: `q (${JSON.stringify(q)}) has no word to search for — search matches words and numbers; punctuation and a bare * are not searchable`,
    });
  }
  if (args.sort_by === 'relevance' && q === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['sort_by'],
      message: 'sort_by "relevance" ranks a search, and this query has no q — pass q, or sort by timestamp, latency_ms or cost_usd',
    });
  }
}

const inputSchema = {
  agent_name: z.string().optional().describe('Filter by agent name — exact match (no wildcards)'),
  framework: z.string().optional().describe('Filter by agent framework — exact match (e.g., langchain, autogen)'),
  session: z.string().optional().describe('Filter by session id — the turns of one conversation, as logged with session_id'),
  q: traceSearchText.optional().describe('Full-text search over input, output, tool-call values and metadata values. Every word must appear; "quoted phrase"; word* for a prefix. Case and accents ignored'),
  since: isoTimestamp.optional().describe('Inclusive lower bound, an ISO 8601 timestamp or date; anything else is rejected'),
  until: isoTimestamp.optional().describe('ISO 8601 timestamp (or date) upper bound — return traces with timestamp <= this; must not be earlier than `since`'),
  min_score: z.number().min(0).max(1).optional().describe('Minimum score (0..1) of each trace\'s latest evaluation; at most max_score'),
  max_score: z.number().min(0).max(1).optional().describe('Maximum eval score filter (0..1; values outside are rejected) — applied to LATEST eval per trace'),
  // Mirrors traceQuerySchema in dashboard/validation.ts — both capture paths
  // (MCP tool, HTTP query) enforce the same 1..1000 bound. Unclamped, limit:-1
  // meant "LIMIT -1" in SQLite, i.e. every row (#332).
  limit: z.number().int().min(1).max(1000).default(50).describe('Results per page (default 50, max 1000 — values above are rejected)'),
  offset: z.number().int().min(0).default(0).describe('Zero-based pagination offset — skip first N results (non-negative integer)'),
  sort_by: z.enum(['timestamp', 'latency_ms', 'cost_usd', 'relevance']).optional().describe('Sort by timestamp | latency_ms | cost_usd | relevance (default relevance with q, else timestamp)'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort order: asc | desc (default desc — most recent / highest first)'),
  include_summary: z.boolean().default(false).describe('Include dashboard summary stats in same response — saves a round-trip when ingesting for dashboards'),
};

// Cross-field range checks — see addTraceRangeIssues above.
const inputSchemaWithRanges = strictInput(inputSchema).superRefine(addTraceRangeIssues);

export const getTracesOutputSchema = z.looseObject({
  traces: z.array(z.looseObject({ trace_id: z.string() })).describe('the page of traces: trace_id, agent_name, framework, input, output, tool_calls, latency_ms, token_usage, cost_usd, metadata, timestamp; with q, match { field, snippet, fragments } too'),
  total: z.number().int().describe('how many traces match the filters, across every page'),
  limit: z.number().int().describe('the page size applied'),
  offset: z.number().int().describe('the offset applied'),
  summary: z.looseObject({}).optional().describe('the dashboard aggregates for the last hour, when include_summary was true'),
  search: z
    .looseObject({ terms: z.array(z.string()), index: z.enum(['fts5', 'scan']) })
    .optional()
    .describe('with q: the terms searched, and whether the full-text index or a scan answered'),
});

export function registerGetTracesTool(server: McpServer, storage: IStorageAdapter): void {
  server.registerTool(
    'get_traces',
    {
      title: 'Get Traces',
      description: describeTool({
        summary:
          'Query stored traces with filters, pagination and sorting; optionally with the dashboard summary.',
        does:
          'Read-only, local. Exact-match agent_name and framework, inclusive since and until, min_score and max_score on each trace\'s latest evaluation, and q: full-text search, ranked, with a snippet. limit is 1..1000 (default 50). A crossed range is refused, never returned as an empty page.',
        whenNot:
          'To score a trace (evaluate_output) or create one (log_trace). As a live stream: poll with backoff.',
        returns: getTracesOutputSchema,
        errors:
          'IRIS_STORAGE_ERROR. Out-of-range bounds are refused, naming the values; no match is total 0, not an error. ' + ERROR_ENVELOPE_SENTENCE,
        siblings: {
          log_trace: 'record an execution',
          evaluate_output: 'score one output',
          delete_trace: 'remove one trace',
        },
      }),
      inputSchema: inputSchemaWithRanges,
      outputSchema: advertisedOutput(getTracesOutputSchema),
      annotations: {
        readOnlyHint: true,      // Pure query: never writes, never deletes
        destructiveHint: false,  // Inverse of readOnly — trivially false
        idempotentHint: true,    // Same args → same result (modulo new traces that may have landed since)
        openWorldHint: false,    // Queries local storage only; no external network
      },
    },
    guarded(async (args) => {
      // OSS single-tenant: MCP caller is the local user.
      const search = searchOf(args.q);
      const result = await storage.queryTraces(LOCAL_TENANT, {
        ...(search !== undefined ? { search } : {}),
        filter: {
          agent_name: args.agent_name,
          framework: args.framework,
          session_id: args.session,
          since: args.since,
          until: args.until,
          min_score: args.min_score,
          max_score: args.max_score,
        },
        limit: args.limit,
        offset: args.offset,
        ...(args.sort_by !== undefined ? { sort_by: args.sort_by as 'timestamp' | 'latency_ms' | 'cost_usd' | 'relevance' } : {}),
        sort_order: args.sort_order as 'asc' | 'desc',
      });

      const response: Record<string, unknown> = {
        traces: result.traces,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        ...(result.search ? { search: result.search } : {}),
      };

      if (args.include_summary) {
        response.summary = await storage.getDashboardSummary(LOCAL_TENANT);
      }

      return respond(getTracesOutputSchema, response);
    }),
  );
}
