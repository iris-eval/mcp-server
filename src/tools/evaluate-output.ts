import { z } from 'zod';
import { toEvaluationResponse } from '../eval/response.js';
import type { DormantRule } from '../eval/dormant.js';
import type { RuleChangesSinceStart } from '../custom-rule-store.js';
import { evaluateOutputResponseSchema } from '../eval/response-schema.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import type { EvalType, CustomRuleDefinition, ExpectedTrajectory } from '../types/eval.js';
import type { EvalEngine } from '../eval/engine.js';
import { costHistoryFor } from '../eval/ingest.js';
import { DEFAULT_EVAL_TYPE, DEFAULT_EVAL_TYPE_NOTE } from '../eval/engine.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { strictInput, strictNested } from './strict-input.js';
import { toolCallSchema, toolDescriptorSchema } from './log-trace.js';
import { getTraceOrThrow, insertLinkedEvalResult } from './trace-link.js';
import { describeTool, ERROR_ENVELOPE_SENTENCE } from './describe.js';
import { advertisedOutput, NESTED_SHAPES_NOTE } from './advertise.js';
import { evaluationLinks, guarded, respond } from './respond.js';
import { storedTraceContext, traceContextOfCall } from '../otel/trace-context.js';

/** The most inline custom rules one call may carry (see the argument description). */
export const MAX_INLINE_CUSTOM_RULES = 10;

/*
 * Strict one level down (#376): `{ name, type, config, wieght: 5 }` used to
 * parse with `wieght` silently discarded, so the rule ran at weight 1 and
 * the score moved for a reason the response could not show. `config` stays
 * a free-form record — its keys depend on `type` and are validated by the
 * rule itself (a broken config reports skipped + configInvalid).
 */
const CustomRuleSchema = strictNested(
  {
    name: z.string().min(1).describe('Rule name as it will appear in rule_results'),
    type: z.enum([
      'regex_match', 'regex_no_match', 'min_length', 'max_length',
      'contains_keywords', 'excludes_keywords', 'json_schema', 'cost_threshold', 'action_policy',
    ]).describe('Check type — decides which config keys the rule reads'),
    config: z.record(z.string(), z.unknown()).describe('Check configuration; keys depend on type (pattern, min_length, keywords, max_cost, …)'),
    weight: z.number().positive().optional().describe('Weight in the weighted score (default 1; must be > 0)'),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('high or critical: a failure fails the verdict; otherwise it advises'),
  },
  'a custom_rules entry',
);

const inputSchema = {
  output: z.string().describe('The output text to evaluate (the agent\'s response that gets scored against rules)'),
  // .optional() rather than .default('all') so the handler can tell "caller
  // chose all" apart from "caller never chose" — the second case gets a
  // note in the response saying the default ran every bundle. The effective
  // default is DEFAULT_EVAL_TYPE (every bundle): an omitted argument must
  // never silently narrow the verdict to a bundle with no safety rules.
  eval_type: z.enum(['completeness', 'relevance', 'safety', 'cost', 'custom', 'all']).optional().describe('Rule bundle: completeness | relevance | safety | cost | custom | all (the default, noted in the response)'),
  expected_trajectory: strictNested(
    {
      tool_calls: z.array(strictNested({ tool_name: z.string(), input: z.unknown().optional() }, 'an expected_trajectory.tool_calls entry')).max(500).optional(),
      mode: z.enum(['strict', 'unordered', 'subset', 'superset', 'ordered_subset']).optional(),
      args: z.enum(['exact', 'subset']).optional(),
      step_budget: z.number().int().min(1).optional(),
      tolerance: z.number().min(1).optional(),
    },
    'expected_trajectory',
  ).optional().describe('What the agent was expected to DO: tool_calls with mode and args (tool_sequence); step_budget and tolerance (step_budget)'),
  expected: z.string().optional().describe('Expected output for comparison — consulted only by the completeness bundle\'s expected_coverage rule; NOT used by relevance (the relevance rules compare the output against `input`)'),
  input: z.string().optional().describe('The ask and any source material given — REQUIRED when eval_type="relevance"; also grounds the hallucination signals'),
  trace_id: z.string().optional().describe('Link evaluation to a trace — surfaces this eval in the dashboard\'s trace drill-through and lets the tool reuse the trace\'s stored tool_calls. Must be the id of a stored trace (from log_trace / get_traces); an unknown id is rejected before anything is evaluated'),
  // .max(10): inline rules skip the deploy-time probe, and the engine runs
  // rules synchronously — without a cap, one request carrying N sandbox-
  // defeating regex rules stalls the server linearly in N (measured 9.3s at
  // N=50). Ten is ample for per-call rules; persistent sets belong in
  // deploy_rule, where deploy-time validation probes each pattern.
  custom_rules: z.array(CustomRuleSchema).max(MAX_INLINE_CUSTOM_RULES).optional().describe('Up to 10 one-off rules; they fire whatever eval_type is (eval_type="custom" runs only these)'),
  cost_usd: z.number().optional().describe('Cost in USD, for the cost bundle and any cost_threshold rule; omitted, they skip rather than pass'),
  token_usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  }).optional().describe('Token usage breakdown — only consulted by the cost bundle (eval_type="cost" or "all"; used for token-budget rules)'),
  // Same schema log_trace validates tool_calls with, imported rather than
  // restated: the trajectory rules read `error`, and a second declaration
  // is how that field goes missing on one path and not the other.
  tools: z.array(toolDescriptorSchema).max(200).optional().describe('Your MCP tools/list result, verbatim; lets the rules check call arguments. Loaded from trace_id when stored'),
  tool_calls: z.array(toolCallSchema).optional().describe('The tool calls the agent made, in order, as log_trace records them; omitted, the trajectory rules skip. Loaded from trace_id when stored'),
};

export interface EvaluateOutputOptions {
  /** The quarantined gating rules on this server, for coverage.dormant. */
  dormant?: () => DormantRule[];
  /** Deployed-rule changes since the server started, for rules_changed. */
  rulesChanged?: () => RuleChangesSinceStart | null;
}

export function registerEvaluateOutputTool(
  server: McpServer,
  storage: IStorageAdapter,
  evalEngine: EvalEngine,
  options?: EvaluateOutputOptions,
): void {
  server.registerTool(
    'evaluate_output',
    {
      title: 'Evaluate Output',
      description: describeTool({
        summary:
          'Score an agent output with the deterministic rules: a ship verdict with its basis, per-rule evidence, and what was not judged.',
        does:
          'Local, no key. eval_type picks a bundle or all (the default). A rule missing its input SKIPS, never passes: input is REQUIRED when eval_type="relevance"; tool_calls and tools (or a trace_id), cost_usd and expected feed the rest.',
        whenNot:
          'For semantic judgment (evaluate_with_llm_judge). As an input firewall: the rules read the output.',
        returns: evaluateOutputResponseSchema,
        errors:
          'IRIS_UNKNOWN_TRACE (nothing written); IRIS_STORAGE_ERROR. ' + ERROR_ENVELOPE_SENTENCE,
        siblings: {
          log_trace: 'record the execution first',
          list_rules: 'what each rule needs',
        },
      }),
      inputSchema: strictInput(inputSchema),
      outputSchema: advertisedOutput(evaluateOutputResponseSchema, NESTED_SHAPES_NOTE),
      annotations: {
        readOnlyHint: false,     // Writes an eval_result row
        destructiveHint: false,  // Creates new data; doesn't overwrite or delete
        idempotentHint: true,    // Deterministic: same inputs → same score (each call writes a distinct result row, but the SCORE is stable)
        openWorldHint: false,    // No external network in heuristic mode; LLM-as-judge has its own tool with openWorldHint:true
      },
    },
    guarded(async (args, extra) => {
      // Refuse an unknown trace_id up front (#376): the old path ran the
      // evaluation and then surfaced SQLite's "FOREIGN KEY constraint
      // failed", which names neither the field nor the fix.
      //
      // The same read also supplies the trajectory when the caller did not
      // pass one: log_trace already stored what the agent did, so making
      // them resend it to get the trajectory rules is a trap — they would
      // skip silently and the response would look clean. An explicit
      // tool_calls argument always wins; the trace is the fallback.
      const trace = args.trace_id
        ? await getTraceOrThrow(storage, LOCAL_TENANT, args.trace_id)
        : undefined;
      /*
       * SEP-414: a W3C context on THIS call is written onto
       * the linked trace when it carries none yet, so the trace joins the
       * caller's on its next export. A trace that already has one keeps
       * it — the first context is the one the export was built on. With
       * no trace_id there is no trace to carry it, and nothing changes.
       */
      const callContext = traceContextOfCall(extra);
      if (callContext && args.trace_id && trace && storedTraceContext(trace.metadata) === undefined) {
        await storage.updateTraceMetadata(LOCAL_TENANT, args.trace_id, { trace_context: callContext });
      }
      const toolCalls = args.tool_calls ?? trace?.tool_calls;
      const tools = args.tools ?? trace?.tools;
      /*
       * Spans are a separate read: getTrace returns the traces row and the
       * spans live in their own table, so rowToTrace has never carried
       * them. Only fetched when they could actually be used — the step
       * layer's precedence is whole-source, so a caller-supplied or stored
       * tool_calls wins outright and this query would be wasted.
       */
      const spans =
        args.trace_id !== undefined && (toolCalls === undefined || toolCalls.length === 0)
          ? await storage.getSpansByTraceId(LOCAL_TENANT, args.trace_id)
          : undefined;

      // Track omission explicitly: a caller who never chose a bundle gets
      // every bundle (DEFAULT_EVAL_TYPE) AND a note saying so. The default
      // used to be completeness — six of seven UAT personas read passed:true
      // on PII-laden text with no hint that the safety bundle never ran.
      const evalTypeOmitted = args.eval_type === undefined;
      const evalType = args.eval_type ?? DEFAULT_EVAL_TYPE;
      const context = {
        output: args.output,
        expected: args.expected,
        expectedTrajectory: args.expected_trajectory as ExpectedTrajectory | undefined,
        input: args.input,
        costUsd: args.cost_usd,
        // The agent's own cost baseline when a trace is linked: the
        // cost under test is the caller's, the history is the trace's agent's.
        costHistory:
          trace !== undefined && args.cost_usd !== undefined
            ? await costHistoryFor(storage, LOCAL_TENANT, { ...trace, cost_usd: args.cost_usd })
            : undefined,
        tokenUsage: args.token_usage,
        toolCalls,
        spans,
        tools,
      };
      const customRules = args.custom_rules as CustomRuleDefinition[] | undefined;

      const result =
        evalType === 'all'
          ? await evalEngine.evaluateAll(context, customRules)
          : await evalEngine.evaluate(evalType as EvalType, context, customRules);

      if (args.trace_id) {
        result.trace_id = args.trace_id;
      }

      // OSS single-tenant: MCP tool callers are the local user. Cloud
      // will derive tenant from the authenticated MCP session.
      await insertLinkedEvalResult(storage, LOCAL_TENANT, result);

      // One serializer for every evaluation surface (src/eval/response.ts):
      // the tool, the HTTP ingest route, the resources and the drift-lock
      // all read the same object, so a field added there reaches every
      // reader at once.
      return respond(
        evaluateOutputResponseSchema,
        toEvaluationResponse(result, { traceId: args.trace_id, dormant: options?.dormant?.(), rulesChanged: options?.rulesChanged?.(), ...(evalTypeOmitted ? { note: DEFAULT_EVAL_TYPE_NOTE } : {}) }),
        evaluationLinks(result.id, args.trace_id),
      );
    }),
  );
}
