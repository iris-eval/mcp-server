import { z } from 'zod';
import { MAX_TOOLS, MAX_TOOLS_BYTES } from '../eval/catalogue.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { generateTraceId, generateSpanId } from '../utils/ids.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { bestEffortExport } from '../otel/lazy.js';
import { strictInput, strictNested } from './strict-input.js';
import { describeTool, ERROR_ENVELOPE_SENTENCE } from './describe.js';
import { evaluationLinks, guarded, respond } from './respond.js';
import { traceUri } from '../resources/uris.js';
import type { EvalEngine } from '../eval/engine.js';
import type { DormantRule } from '../eval/dormant.js';
import { evaluateStoredTrace } from '../eval/ingest.js';
import { evaluateOutputResponseSchema } from '../eval/response-schema.js';
import { irisError } from './errors.js';

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

/*
 * One tools/list entry.
 *
 * The strictness question here has a principle rather than a preference:
 * STRICTNESS PROTECTS THE FIELDS IRIS READS; PERMISSIVENESS IS CORRECT FOR
 * THE FIELDS IT ONLY CARRIES. Exactly three things can change a verdict —
 * name, inputSchema, annotations.readOnlyHint — and a misspelled
 * "inputSchma" must be caught, because the tool would otherwise be treated
 * as schemaless and every call to it would silently pass. A vendor key Iris
 * never reads changes nothing, and a real tools/list result carries several.
 *
 * So: a strict envelope over an allowlist that is already a SUPERSET of the
 * MCP specification (a verbatim paste passes), loose inside annotations
 * (clients may add hints), free-form inside the three document fields.
 */
export const toolDescriptorSchema = strictNested(
  {
    name: z.string().min(1).max(128),
    title: z.string().max(512).optional(),
    description: z.string().max(4096).optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    annotations: z
      .looseObject({
        title: z.string().optional(),
        readOnlyHint: z.boolean().optional(),
        destructiveHint: z.boolean().optional(),
        idempotentHint: z.boolean().optional(),
        openWorldHint: z.boolean().optional(),
      })
      .optional(),
    /*
     * Carried, never read. Found by the drift-lock on its first run: the
     * SDK puts an execution block on every tool it advertises, so a
     * verbatim paste of a real tools/list result would have been rejected
     * with a message about a misspelled key. That is the whole reason the
     * allowlist is checked against a live tools/list rather than against
     * the specification as read by a person.
     */
    execution: z.record(z.string(), z.unknown()).optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  },
  'a tools entry',
);

/*
 * The catalogue, with the two limits that are REJECTIONS rather than
 * truncations. A truncated catalogue makes "not in the catalogue" a lie,
 * and that sentence is evidence on a security-relevant class. Duplicate
 * names are refused for the same reason: a duplicate silently decides which
 * schema a call is validated against.
 */
const toolsCatalogueSchema = z
  .array(toolDescriptorSchema)
  .max(MAX_TOOLS, { message: `a tools catalogue may carry at most ${MAX_TOOLS} entries` })
  .superRefine((tools, ctx) => {
    const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
    if (bytes > MAX_TOOLS_BYTES) {
      ctx.addIssue({ code: 'custom', message: `the tools catalogue is ${bytes} bytes; the limit is ${MAX_TOOLS_BYTES}. Send the tools this agent can actually call, not every tool on the server` });
    }
    const seen = new Set<string>();
    for (const tool of tools) {
      if (seen.has(tool.name)) {
        ctx.addIssue({ code: 'custom', message: `the tools catalogue names "${tool.name}" twice; a duplicate decides silently which schema a call is checked against` });
        break;
      }
      seen.add(tool.name);
    }
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
  tools: toolsCatalogueSchema.optional().describe('What the agent COULD have called — your MCP tools/list result, pasted verbatim: [{ name, description?, inputSchema, annotations? }]. Stored on the trace and reused by evaluate_output when given this trace_id. Without it a tool call can be seen but not CHECKED, and the rules that judge argument validity skip rather than pass'),
  run: z.string().optional().describe('Name the batch this execution belongs to — a CI job id, a nightly sweep, an afternoon of manual pokes. Two runs of the same agent can then be compared with compare_runs. Never inferred: a guessed grouping produces a comparison nobody can act on'),
  case_key: z.string().optional().describe('What makes this the same QUESTION as a trace in another run — a fixture name, a test id. Supplying it PAIRS the two, and a paired comparison sees a regression an unpaired one cannot. Omit it and a key is derived from the input, so pairing still works'),
  spans: z.array(SpanSchema).optional().describe('Detailed execution spans (hierarchical span tree with timings, attributes, events); a span without start_time takes the trace timestamp'),
  timestamp: z.string().optional().describe('Trace timestamp (ISO 8601); defaults to now() when omitted'),
  /*
   * Evaluate on write — the same opt-in POST /api/v1/traces has carried
   * since 0.5.0, and the MCP path lacked. Two calls where one would do
   * taught agents to log and forget: a trace with no verdict looks like a
   * dead server. Declared HERE so both doors inherit it.
   */
  evaluate: z.boolean().default(false).describe('Score the stored trace in this same call, under exactly the rules evaluate_output runs (every bundle unless eval_type names one). Requires output. The response then carries the full evaluation — verdict, basis, every rule result, coverage — and links it'),
  eval_type: z.enum(['completeness', 'relevance', 'safety', 'cost', 'custom', 'all']).optional().describe('With evaluate: true, the bundle to run — completeness | relevance | safety | cost | custom | all. Omitted: every bundle runs and the evaluation carries a note saying the default ran'),
};

export const logTraceOutputSchema = z.looseObject({
  trace_id: z.string().describe('the stored trace id, 32 hex — pass it to evaluate_output, get_traces or delete_trace'),
  status: z.literal('stored').describe('always "stored" on success'),
  evaluation: evaluateOutputResponseSchema.optional().describe('present when evaluate was true: the same object evaluate_output returns for this trace, stored and linked'),
});

export interface LogTraceOptions {
  /** The quarantined gating rules on this server, for coverage.dormant when evaluate is true. */
  dormant?: () => DormantRule[];
}

export function registerLogTraceTool(server: McpServer, storage: IStorageAdapter, evalEngine?: EvalEngine, options?: LogTraceOptions): void {
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
          'Pass evaluate: true (with output) to score the stored trace in this same call under exactly the rules evaluate_output runs; the response then carries the full evaluation and links it. ' +
          'When IRIS_OTEL_ENDPOINT is set the trace is also exported to that collector, best-effort and asynchronous; the local write never waits on it. ' +
          'Traces are immutable: there is no update path. In stdio mode nothing authenticates the caller; over HTTP a Bearer token is required only when an API key is configured.',
        whenNot:
          'For a transient log line (use your logger). To score a trace you already stored: evaluate_output with its trace_id, which reuses the stored tool_calls and tools. To change a stored trace: delete_trace and log again.',
        returns: logTraceOutputSchema,
        errors:
          'IRIS_STORAGE_ERROR when the database cannot be written. IRIS_INVALID_ARGUMENT when evaluate is true without output, or on a server with no eval engine — nothing is stored in either case. An unknown argument or a malformed span or tool_calls entry is refused before the handler runs, naming the valid keys. ' +
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
      // Refuse before storing anything: a half-done write — stored, not
      // evaluated, error returned — is the shape a caller cannot recover
      // from without reading the database.
      if (args.evaluate && args.output === undefined) {
        throw irisError('IRIS_INVALID_ARGUMENT', 'evaluate: true needs an output to score, and none was supplied. Nothing was stored.', {
          field: 'output',
          recovery: ['Pass the agent\'s output alongside evaluate: true.', 'Or omit evaluate and call evaluate_output later with the trace_id.'],
        });
      }
      if (args.evaluate && !evalEngine) {
        throw irisError('IRIS_INVALID_ARGUMENT', 'Evaluation is not available on this server (no eval engine is wired), so evaluate: true cannot be honoured. Nothing was stored.', {
          field: 'evaluate',
          recovery: ['Retry without evaluate to store the trace.', 'Start Iris through its own entry point (iris-eval) so the eval engine is wired.'],
        });
      }
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
        /*
         * THE CATALOGUE WAS BEING DROPPED HERE.
         *
         * `tools` has been in this tool's input schema since 0.11.0, with a
         * description telling callers it is "stored on the trace and reused
         * by evaluate_output when given this trace_id" — and this object
         * never carried it, so every catalogue sent through the MCP path
         * was accepted and silently discarded. The HTTP ingest route did
         * carry it, which is how two paths came to honour one contract
         * differently. valid_tool_arguments and no_tool_loop's target
         * clause were dormant for anyone who logged a trace and then
         * evaluated it by id.
         */
        tools: args.tools,
        run_id: args.run,
        case_key: args.case_key,
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

      const traceLink = { uri: traceUri(traceId), name: `trace ${traceId}`, description: 'The stored trace with its spans and, later, its evaluations' };
      if (!args.evaluate || !evalEngine) {
        return respond(logTraceOutputSchema, { trace_id: traceId, status: 'stored' }, [traceLink]);
      }

      // The same primitive POST /api/v1/traces uses (src/eval/ingest.ts):
      // one context, one bundle default, one serializer, one linked row.
      const { result, response } = await evaluateStoredTrace(evalEngine, storage, LOCAL_TENANT, trace as typeof trace & { output: string }, {
        evalType: args.eval_type,
        dormant: options?.dormant?.(),
      });
      return respond(logTraceOutputSchema, { trace_id: traceId, status: 'stored', evaluation: response }, [
        ...evaluationLinks(result.id, traceId).filter((l) => l.uri !== traceLink.uri),
        traceLink,
      ]);
    }),
  );
}
