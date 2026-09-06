import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { generateTraceId, generateSpanId } from '../utils/ids.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { bestEffortExport } from '../otel/lazy.js';
import { strictInput, strictNested } from './strict-input.js';
import { describeTool, ERROR_ENVELOPE_SENTENCE } from './describe.js';
import { guarded, respond } from './respond.js';
import { traceUri } from '../resources/uris.js';

/*
 * The tool-call record — one entry of `tool_calls[]`.
 *
 * Exported because it is now read on THREE paths, not one: log_trace and
 * the HTTP ingest capture it, and evaluate_output accepts it directly so
 * the trajectory rules (no_silent_tool_failure, no_tool_loop) can judge
 * what the agent DID. All three must agree on the field names, so they all
 * derive from this one schema rather than restating it.
 *
 * Strict for the same reason custom_rules entries are (#376): a dropped
 * key here is silent AND load-bearing. `{ tool_name, output, err: "..." }`
 * used to parse with `err` discarded, and a trajectory rule reading
 * `error` would then score a failed call as a clean one — the exact
 * failure mode the rules exist to catch, reintroduced by a typo.
 */
export const toolCallSchema = strictNested(
  {
    tool_name: z.string(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    latency_ms: z.number().optional(),
    error: z.string().optional(),
    /*
     * Added in 0.11.0, all optional, all read by nothing yet. Each is
     * knowable only to the producer and unrecoverable afterwards, so they
     * land with the step layer rather than with the first rule that wants
     * them — adding a capture field once corpus cases exist means
     * relabelling those cases.
     *
     * The object is STRICT, so a caller who was already sending these was
     * being rejected; accepting them is a widening, not a behaviour change.
     */
    call_id: z.string().optional(),
    truncated: z.boolean().optional(),
    token_usage: z
      .object({
        prompt_tokens: z.number().optional(),
        completion_tokens: z.number().optional(),
        total_tokens: z.number().optional(),
      })
      .optional(),
    cost_usd: z.number().optional(),
  },
  'a tool_calls entry',
);

const SpanSchema = z.object({
  span_id: z.string().optional(),
  parent_span_id: z.string().optional(),
  name: z.string(),
  kind: z.enum(['INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER', 'LLM', 'TOOL']).default('INTERNAL'),
  status_code: z.enum(['UNSET', 'OK', 'ERROR']).default('UNSET'),
  status_message: z.string().optional(),
  start_time: z.string(),
  end_time: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  events: z.array(z.object({
    name: z.string(),
    timestamp: z.string(),
    attributes: z.record(z.string(), z.unknown()).optional(),
  })).optional(),
});

const TokenUsageSchema = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
});

/*
 * The log_trace input contract. Exported because POST /api/v1/traces
 * (src/dashboard/routes/traces.ts) accepts the SAME body — one schema,
 * two capture paths. Duplicating it there would let the tool and the
 * HTTP endpoint drift apart silently; importing it means a field added
 * here is accepted (and validated identically) on both.
 */
export const logTraceInputShape = {
  agent_name: z.string().describe('Agent name — used for filtering in get_traces (e.g., "customer-support-bot")'),
  framework: z.string().optional().describe('Agent framework identifier (e.g., langchain, autogen, custom)'),
  input: z.string().optional().describe('Agent input text — the user prompt or upstream input that produced this output'),
  output: z.string().optional().describe('Agent output text — what the agent produced (pass to evaluate_output for scoring)'),
  tool_calls: z.array(toolCallSchema).optional().describe('Tool calls made during execution, in order, each { tool_name, input?, output?, latency_ms?, error? } — what the trajectory rules judge; evaluate_output reuses them when given this trace_id'),
  latency_ms: z.number().optional().describe('Total execution time in milliseconds (end-to-end agent latency)'),
  token_usage: TokenUsageSchema.optional().describe('Token usage breakdown (prompt/completion/total — used for cost analysis)'),
  cost_usd: z.number().optional().describe('Total cost in USD — overrides per-span aggregation when provided (treated as authoritative)'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Opaque key-value tags (e.g. {requestId, userId, env}) — queryable in dashboard, not via get_traces filters'),
  spans: z.array(SpanSchema).optional().describe('Detailed execution spans (hierarchical span tree with timings, attributes, events); a span without start_time takes the trace timestamp'),
  timestamp: z.string().optional().describe('Trace timestamp (ISO 8601); defaults to now() when omitted'),
};

export const logTraceOutputSchema = z.looseObject({
  trace_id: z.string().describe('the stored trace id, 32 hex — pass it to evaluate_output, get_traces or delete_trace'),
  status: z.literal('stored').describe('always "stored" on success'),
});

export function registerLogTraceTool(server: McpServer, storage: IStorageAdapter): void {
  server.registerTool(
    'log_trace',
    {
      title: 'Log Trace',
      description: describeTool({
        summary:
          'Store one agent execution — input, output, tool calls, spans, cost, latency, token usage — and get the trace_id every later call keys on.',
        does:
          'Writes one trace row to local SQLite and mints a fresh trace_id; nothing is deduplicated, so resubmitting the same payload stores a second trace. ' +
          'Only agent_name is required. Store what you have: tool_calls so the trajectory rules can later judge what the agent did, cost_usd and token_usage so the cost rules can, input and output so everything else can. ' +
          'When IRIS_OTEL_ENDPOINT is set the trace is also exported to that collector, best-effort and asynchronous; the local write never waits on it. ' +
          'Traces are immutable: there is no update path. In stdio mode nothing authenticates the caller; over HTTP a Bearer token is required only when an API key is configured.',
        whenNot:
          'For a transient log line (use your logger). To score an output: log first, then call evaluate_output with the trace_id, which also lets it reuse the stored tool_calls. To change a stored trace: delete_trace and log again.',
        returns: logTraceOutputSchema,
        errors:
          'IRIS_STORAGE_ERROR when the database cannot be written. An unknown argument or a malformed span or tool_calls entry is refused before the handler runs, naming the valid keys. ' +
          ERROR_ENVELOPE_SENTENCE,
        siblings: {
          evaluate_output: 'score the stored output',
          get_traces: 'query what was logged',
          delete_trace: 'remove one trace',
        },
      }),
      // Strict at the MCP boundary (unknown args rejected, not stripped).
      // The dashboard's HTTP ingest builds its own — equally strict —
      // schema FROM this shape (dashboard/validation.ts): a client-supplied
      // trace_id is rejected there with a 400 whose message says the server
      // mints it, exactly as this tool mints its own in the handler below.
      inputSchema: strictInput(logTraceInputShape),
      outputSchema: logTraceOutputSchema,
      annotations: {
        readOnlyHint: false,     // Writes a row to storage
        destructiveHint: false,  // Creates new data; doesn't overwrite or delete
        idempotentHint: false,   // Each call mints a fresh trace_id; duplicate payloads produce distinct traces
        openWorldHint: false,    // Local storage first. When IRIS_OTEL_ENDPOINT is set a best-effort async OTel export runs but is non-blocking (tool succeeds even if export fails).
      },
    },
    guarded(async (args) => {
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

      return respond(logTraceOutputSchema, { trace_id: traceId, status: 'stored' }, [
        { uri: traceUri(traceId), name: `trace ${traceId}`, description: 'The stored trace with its spans and, later, its evaluations' },
      ]);
    }),
  );
}
