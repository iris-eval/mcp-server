import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { generateTraceId, generateSpanId } from '../utils/ids.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { bestEffortExport } from '../otel/lazy.js';

const ToolCallSchema = z.object({
  tool_name: z.string(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  latency_ms: z.number().optional(),
  error: z.string().optional(),
});

const SpanSchema = z.object({
  span_id: z.string().optional(),
  parent_span_id: z.string().optional(),
  name: z.string(),
  kind: z.enum(['INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER', 'LLM', 'TOOL']).default('INTERNAL'),
  status_code: z.enum(['UNSET', 'OK', 'ERROR']).default('UNSET'),
  status_message: z.string().optional(),
  start_time: z.string(),
  end_time: z.string().optional(),
  attributes: z.record(z.unknown()).optional(),
  events: z.array(z.object({
    name: z.string(),
    timestamp: z.string(),
    attributes: z.record(z.unknown()).optional(),
  })).optional(),
});

const TokenUsageSchema = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
});

const inputSchema = {
  agent_name: z.string().describe('Agent name — used for filtering in get_traces (e.g., "customer-support-bot")'),
  framework: z.string().optional().describe('Agent framework identifier (e.g., langchain, autogen, custom)'),
  input: z.string().optional().describe('Agent input text — the user prompt or upstream input that produced this output'),
  output: z.string().optional().describe('Agent output text — what the agent produced (pass to evaluate_output for scoring)'),
  tool_calls: z.array(ToolCallSchema).optional().describe('Tool calls made during execution (per-call latency, errors, input/output)'),
  latency_ms: z.number().optional().describe('Total execution time in milliseconds (end-to-end agent latency)'),
  token_usage: TokenUsageSchema.optional().describe('Token usage breakdown (prompt/completion/total — used for cost analysis)'),
  cost_usd: z.number().optional().describe('Total cost in USD — overrides per-span aggregation when provided (treated as authoritative)'),
  metadata: z.record(z.unknown()).optional().describe('Opaque key-value tags (e.g. {requestId, userId, env}) — queryable in dashboard, not via get_traces filters'),
  spans: z.array(SpanSchema).optional().describe('Detailed execution spans (hierarchical span tree with timings, attributes, events)'),
  timestamp: z.string().optional().describe('Trace timestamp (ISO 8601); defaults to now() when omitted'),
};

export function registerLogTraceTool(server: McpServer, storage: IStorageAdapter): void {
  server.registerTool(
    'log_trace',
    {
      title: 'Log Trace',
      description: [
        'Persist a single agent execution trace (input, output, spans, tool calls, cost, latency, token usage).',
        '',
        'Sibling tools — evaluate_output runs heuristic scoring on the trace; evaluate_with_llm_judge runs semantic LLM-based scoring; verify_citations checks citation grounding; get_traces queries stored traces; delete_trace removes a single trace; list_rules / deploy_rule / delete_rule manage custom evaluation rules. log_trace is the WRITE path that records executions; everything else reads, scores, or manages around it.',
        '',
        'Behavior. Writes one row to Iris storage (SQLite by default; Postgres in Cloud tier). When IRIS_OTEL_ENDPOINT is set, ALSO fires a best-effort async export to the configured OTLP/HTTP collector (Jaeger, Tempo, Datadog OTLP, OTEL Collector). The OTel export is fire-and-forget — its success does not affect the tool response; failures are logged but the trace is still stored locally. No authentication in stdio mode; HTTP mode requires Bearer token. Rate-limited to 20 req/min on HTTP MCP, unlimited on stdio. Not idempotent: each call mints a fresh trace_id, so resubmitting the same payload creates a duplicate trace.',
        '',
        'Output shape. Returns a JSON string: `{ "trace_id": "<32-hex>", "status": "stored" }`. The trace_id is the key you pass to evaluate_output or get_traces afterwards.',
        '',
        'Use when you want to record an agent execution for later evaluation, analysis, or audit. Call it AFTER the agent has produced output; call evaluate_output afterwards to score it; call get_traces to query historical traces. Store rich context: spans (span tree), tool_calls (which tools were invoked with latency/errors), token_usage, cost_usd, metadata (arbitrary key-value). All optional except agent_name.',
        '',
        'Don\'t use when you only need a transient log (use console logging). Don\'t use to update an existing trace — there is no update path in v0.4 (traces are immutable once stored).',
        '',
        'Parameters. agent_name is required; everything else is optional. token_usage and cost_usd are summary fields — if you ALSO pass spans with per-tool-call costs, the summary fields are treated as authoritative (no auto-aggregation). spans without an explicit start_time fall back to the trace timestamp; spans with an end_time get a duration_ms derived. metadata is opaque key-value (queryable in the dashboard, not via get_traces filters). tool_calls record per-tool latency + errors; missing latency_ms means "not reported," not "zero." Defaults: span.kind="INTERNAL", span.status_code="UNSET", timestamp=now() if omitted.',
        '',
        'Error modes. Throws on missing agent_name. Throws on malformed span or tool_call objects (Zod rejects). Returns 500 on storage failure (disk full, DB locked). Never blocks on the agent — returns within ~50ms for typical payloads.',
      ].join('\n'),
      inputSchema,
      annotations: {
        readOnlyHint: false,     // Writes a row to storage
        destructiveHint: false,  // Creates new data; doesn't overwrite or delete
        idempotentHint: false,   // Each call mints a fresh trace_id; duplicate payloads produce distinct traces
        openWorldHint: false,    // Local storage first. When IRIS_OTEL_ENDPOINT is set a best-effort async OTel export runs but is non-blocking (tool succeeds even if export fails).
      },
    },
    async (args) => {
      const traceId = generateTraceId();
      const timestamp = args.timestamp ?? new Date().toISOString();

      const trace = {
        trace_id: traceId,
        agent_name: args.agent_name,
        framework: args.framework,
        input: args.input,
        output: args.output,
        tool_calls: args.tool_calls,
        latency_ms: args.latency_ms,
        token_usage: args.token_usage,
        cost_usd: args.cost_usd,
        metadata: args.metadata as Record<string, unknown> | undefined,
        timestamp,
        spans: args.spans?.map((s) => ({
          ...s,
          span_id: s.span_id ?? generateSpanId(),
          trace_id: traceId,
        })),
      };

      await storage.insertTrace(LOCAL_TENANT, trace);

      // Best-effort async OTel export (fire-and-forget). No-op when
      // IRIS_OTEL_ENDPOINT isn't configured. Errors are logged via the
      // server logger but never affect the tool response — if the OTel
      // collector is down we still want to store traces locally.
      bestEffortExport(trace, (err) => {
        // eslint-disable-next-line no-console
        console.warn(`[iris.otel] ${err.message}`);
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ trace_id: traceId, status: 'stored' }),
          },
        ],
      };
    },
  );
}
