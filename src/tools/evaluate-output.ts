import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import type { EvalType, CustomRuleDefinition } from '../types/eval.js';
import type { EvalEngine } from '../eval/engine.js';
import { LOCAL_TENANT } from '../types/tenant.js';

const CustomRuleSchema = z.object({
  name: z.string(),
  type: z.enum([
    'regex_match', 'regex_no_match', 'min_length', 'max_length',
    'contains_keywords', 'excludes_keywords', 'json_schema', 'cost_threshold',
  ]),
  config: z.record(z.unknown()),
  weight: z.number().optional(),
});

const inputSchema = {
  output: z.string().describe('The output text to evaluate (the agent\'s response that gets scored against rules)'),
  eval_type: z.enum(['completeness', 'relevance', 'safety', 'cost', 'custom']).default('completeness').describe('Rule bundle to apply: completeness | relevance | safety | cost | custom — picks which built-in rules fire'),
  expected: z.string().optional().describe('Expected output for comparison — REQUIRED when eval_type="relevance" (used as keyword-overlap target)'),
  input: z.string().optional().describe('Original input for context — improves relevance scoring (keyword overlap vs input)'),
  trace_id: z.string().optional().describe('Link evaluation to a trace — surfaces this eval in the dashboard\'s trace drill-through'),
  custom_rules: z.array(CustomRuleSchema).optional().describe('Custom evaluation rules — fires REGARDLESS of eval_type; pass eval_type="custom" if you want ONLY these'),
  cost_usd: z.number().optional().describe('Cost in USD — only consulted when eval_type="cost" (compared against cost_threshold rules)'),
  token_usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  }).optional().describe('Token usage breakdown — only consulted when eval_type="cost" (used for token-budget rules)'),
};

export function registerEvaluateOutputTool(
  server: McpServer,
  storage: IStorageAdapter,
  evalEngine: EvalEngine,
): void {
  server.registerTool(
    'evaluate_output',
    {
      title: 'Evaluate Output',
      description: [
        'Score agent output against configurable eval rules and return a 0..1 score + per-rule breakdown.',
        '',
        'Sibling tools — evaluate_with_llm_judge runs semantic LLM-based scoring (slower, costs money; this tool is heuristic, free, deterministic), verify_citations checks citation grounding specifically, log_trace records executions, get_traces queries them, list_rules / deploy_rule / delete_rule manage the custom-rule lifecycle. evaluate_output is the FAST PATH for length / keyword / PII / injection / cost-threshold checks where rules are sufficient.',
        '',
        'Behavior. Deterministic, in-process scoring — same inputs always produce the same result. Writes one eval_result row to Iris storage (linked to trace_id if provided; unlinked otherwise). No external network calls in heuristic mode (v0.4 adds an llm_as_judge eval_type that DOES call LLM APIs; see the separate evaluate_with_llm_judge tool for that). Rate-limited to 20 req/min on HTTP MCP, unlimited on stdio. Runs in ~5-50ms for rule-based evaluation.',
        '',
        'Output shape. Returns JSON: `{ "id": "<uuid>", "score": 0..1, "passed": boolean, "rule_results": [{ "ruleName", "passed", "score", "message", "skipped?" }], "suggestions": string[], "rules_evaluated": number, "rules_skipped": number, "insufficient_data": boolean }`. `insufficient_data=true` means no applicable rules fired (e.g., safety eval with only cost data).',
        '',
        'Use when you want a quality score on a specific output — typically after log_trace records the execution. Pass `eval_type` to route to the right rule bundle: `completeness` (length, sentence count, relevance to input), `relevance` (keyword overlap, topic consistency), `safety` (PII leak, prompt injection, hallucination markers, stub-output detection), `cost` (budget threshold), or `custom` (bring your own rules via `custom_rules`).',
        '',
        'Don\'t use when the output is empty or has no applicable rules — the eval_type decides which rules apply, and invalid combinations return score=0 + insufficient_data=true (not an error, but not actionable). Don\'t use to VALIDATE JSON schemas directly (use your language\'s JSON Schema validator — Iris\'s `json_schema` custom rule type is for output-shape assertions, not arbitrary validation).',
        '',
        'Parameters. expected is REQUIRED when eval_type="relevance" (used as the comparison target for keyword overlap + topic consistency); ignored for other eval_types. cost_usd + token_usage are ONLY consulted when eval_type="cost" (ignored otherwise). custom_rules ALWAYS fires regardless of eval_type — pass eval_type="custom" if you want ONLY your rules to run (otherwise both your rules AND the eval_type bundle run together). trace_id is optional but recommended (linking the eval to its trace surfaces it in the dashboard\'s drill-through). input adds context to keyword-overlap relevance checks; ignored otherwise. Defaults: eval_type="completeness".',
        '',
        'Error modes. Throws on malformed custom_rules (Zod rejects). Returns 400 on regex patterns that fail safe-regex2 ReDoS check or exceed 1000-char limit. Returns 429 when HTTP rate limit exceeded. Storage failures propagate as 500. The eval itself never throws — failing rules report `passed: false` with a message, they don\'t bubble exceptions.',
      ].join('\n'),
      inputSchema,
      annotations: {
        readOnlyHint: false,     // Writes an eval_result row
        destructiveHint: false,  // Creates new data; doesn't overwrite or delete
        idempotentHint: true,    // Deterministic: same inputs → same score (each call writes a distinct result row, but the SCORE is stable)
        openWorldHint: false,    // No external network in heuristic mode; LLM-as-judge has its own tool with openWorldHint:true
      },
    },
    async (args) => {
      const evalType = args.eval_type as EvalType;

      const result = evalEngine.evaluate(
        evalType,
        {
          output: args.output,
          expected: args.expected,
          input: args.input,
          costUsd: args.cost_usd,
          tokenUsage: args.token_usage,
        },
        args.custom_rules as CustomRuleDefinition[] | undefined,
      );

      if (args.trace_id) {
        result.trace_id = args.trace_id;
      }

      // OSS single-tenant: MCP tool callers are the local user. Cloud
      // will derive tenant from the authenticated MCP session.
      await storage.insertEvalResult(LOCAL_TENANT, result);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              id: result.id,
              score: result.score,
              passed: result.passed,
              rule_results: result.rule_results,
              suggestions: result.suggestions,
              rules_evaluated: result.rules_evaluated,
              rules_skipped: result.rules_skipped,
              insufficient_data: result.insufficient_data,
            }),
          },
        ],
      };
    },
  );
}
