import { z } from 'zod';
import { toEvaluationResponse } from '../eval/response.js';
import type { DormantRule } from '../eval/dormant.js';
import { evaluateOutputResponseSchema } from '../eval/response-schema.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import type { EvalType, CustomRuleDefinition } from '../types/eval.js';
import type { EvalEngine } from '../eval/engine.js';
import { DEFAULT_EVAL_TYPE, DEFAULT_EVAL_TYPE_NOTE } from '../eval/engine.js';
import { INJECTION_SCOPE_SENTENCE } from '../eval/rules/safety.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { strictInput, strictNested } from './strict-input.js';
import { toolCallSchema } from './log-trace.js';
import { getTraceOrThrow, insertLinkedEvalResult } from './trace-link.js';
import { describeTool, ERROR_ENVELOPE_SENTENCE } from './describe.js';
import { evaluationLinks, guarded, respond } from './respond.js';

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
      'contains_keywords', 'excludes_keywords', 'json_schema', 'cost_threshold',
    ]).describe('Check type — decides which config keys the rule reads'),
    config: z.record(z.string(), z.unknown()).describe('Check configuration; keys depend on type (pattern, min_length, keywords, max_cost, …)'),
    weight: z.number().positive().optional().describe('Weight in the weighted score (default 1; must be > 0)'),
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
  eval_type: z.enum(['completeness', 'relevance', 'safety', 'cost', 'custom', 'all']).optional().describe('Rule bundle to apply: completeness | relevance | safety | cost | custom | all — picks which built-in rules fire. "all" runs every bundle in one call and adds a per-category breakdown. Defaults to "all" when omitted — every bundle runs, safety included, and the response carries a note saying the default ran'),
  expected: z.string().optional().describe('Expected output for comparison — consulted only by the completeness bundle\'s expected_coverage rule; NOT used by relevance (the relevance rules compare the output against `input`)'),
  input: z.string().optional().describe('Original input for context (the ask + any source material the agent was given) — REQUIRED when eval_type="relevance" (keyword_overlap and topic_consistency compare the output against it and skip without it); also grounds the safety bundle\'s hallucination signals'),
  trace_id: z.string().optional().describe('Link evaluation to a trace — surfaces this eval in the dashboard\'s trace drill-through and lets the tool reuse the trace\'s stored tool_calls. Must be the id of a stored trace (from log_trace / get_traces); an unknown id is rejected before anything is evaluated'),
  // .max(10): inline rules skip the deploy-time probe, and the engine runs
  // rules synchronously — without a cap, one request carrying N sandbox-
  // defeating regex rules stalls the server linearly in N (measured 9.3s at
  // N=50). Ten is ample for per-call rules; persistent sets belong in
  // deploy_rule, where deploy-time validation probes each pattern.
  custom_rules: z.array(CustomRuleSchema).max(MAX_INLINE_CUSTOM_RULES).optional().describe('Custom evaluation rules, max 10 per call (deploy persistent rule sets via deploy_rule instead) — fires REGARDLESS of eval_type; pass eval_type="custom" if you want ONLY these. Each entry accepts exactly name, type, config, weight — an unknown key (e.g. a misspelled weight) is rejected'),
  cost_usd: z.number().optional().describe('Cost in USD — consulted by the cost bundle (eval_type="cost" or "all") AND by any cost_threshold custom rule regardless of eval_type; omit it and such a rule skips rather than passes (a critical one is listed in critical_skipped)'),
  token_usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  }).optional().describe('Token usage breakdown — only consulted by the cost bundle (eval_type="cost" or "all"; used for token-budget rules)'),
  // Same schema log_trace validates tool_calls with, imported rather than
  // restated: the trajectory rules read `error`, and a second declaration
  // is how that field goes missing on one path and not the other.
  tool_calls: z.array(toolCallSchema).optional().describe('What the agent DID — the tool calls it made, in order, each { tool_name, input?, output?, latency_ms?, error? } exactly as log_trace records them. Read by the trajectory rules — the rules that judge what the agent DID rather than what it wrote. Omit it and those rules SKIP rather than pass — an evaluation with no trajectory data reports "not judged", never "clean". When trace_id names a stored trace and this argument is omitted, the tool_calls stored on that trace are loaded and used, so a caller who already logged them need not resend them'),
};

export interface EvaluateOutputOptions {
  /** The quarantined gating rules on this server, for coverage.dormant. */
  dormant?: () => DormantRule[];
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
          'Score an agent output against the deterministic rule bundles: the ship verdict with its basis, every rule result with evidence and uncertainty, and what was not judged.',
        does:
          'In-process, no network, no key. eval_type picks one bundle (completeness, relevance, safety, cost, custom) or all (the default): every bundle plus deployed and inline custom rules, with a per-bundle breakdown in categories. ' +
          'Inputs decide what can be judged: input is REQUIRED when eval_type="relevance" (keyword_overlap and topic_consistency compare the output against it and skip without it) and grounds the hallucination signals; ' +
          'tool_calls, or a trace_id whose stored tool_calls are reused, feed the trajectory rules; cost_usd and token_usage feed the cost rules; expected feeds only expected_coverage. ' +
          'A rule without its input SKIPS, is named, and never counts as a pass. custom_rules always fire. One row is stored, linked to trace_id when given.',
        whenNot:
          'To validate arbitrary JSON Schema (the json_schema custom type asserts an output\'s shape only). ' +
          `To screen inputs before they reach an agent: ${INJECTION_SCOPE_SENTENCE} ` +
          'For semantic judgment, evaluate_with_llm_judge and verify_citations need a key you supply.',
        returns: evaluateOutputResponseSchema,
        errors:
          'IRIS_UNKNOWN_TRACE when trace_id names no stored trace — checked first, nothing scored or written. IRIS_STORAGE_ERROR when the row cannot be written. ' +
          'Unknown arguments or keys are refused before the handler runs, naming the valid ones; a regex rule over its budget or with a broken config reports skipped, not an error. ' +
          ERROR_ENVELOPE_SENTENCE,
        siblings: {
          log_trace: 'record the execution first',
          evaluate_with_llm_judge: 'semantic scoring on your key',
          verify_citations: 'citation grounding on your key',
          list_rules: 'the roster, needs and published accuracy',
        },
      }),
      inputSchema: strictInput(inputSchema),
      outputSchema: evaluateOutputResponseSchema,
      annotations: {
        readOnlyHint: false,     // Writes an eval_result row
        destructiveHint: false,  // Creates new data; doesn't overwrite or delete
        idempotentHint: true,    // Deterministic: same inputs → same score (each call writes a distinct result row, but the SCORE is stable)
        openWorldHint: false,    // No external network in heuristic mode; LLM-as-judge has its own tool with openWorldHint:true
      },
    },
    guarded(async (args) => {
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
      const toolCalls = args.tool_calls ?? trace?.tool_calls;

      // Track omission explicitly: a caller who never chose a bundle gets
      // every bundle (DEFAULT_EVAL_TYPE) AND a note saying so. The default
      // used to be completeness — six of seven UAT personas read passed:true
      // on PII-laden text with no hint that the safety bundle never ran.
      const evalTypeOmitted = args.eval_type === undefined;
      const evalType = args.eval_type ?? DEFAULT_EVAL_TYPE;
      const context = {
        output: args.output,
        expected: args.expected,
        input: args.input,
        costUsd: args.cost_usd,
        tokenUsage: args.token_usage,
        toolCalls,
      };
      const customRules = args.custom_rules as CustomRuleDefinition[] | undefined;

      const result =
        evalType === 'all'
          ? evalEngine.evaluateAll(context, customRules)
          : evalEngine.evaluate(evalType as EvalType, context, customRules);

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
        toEvaluationResponse(result, { traceId: args.trace_id, dormant: options?.dormant?.(), ...(evalTypeOmitted ? { note: DEFAULT_EVAL_TYPE_NOTE } : {}) }),
        evaluationLinks(result.id, args.trace_id),
      );
    }),
  );
}
