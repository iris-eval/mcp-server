import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import type { EvalType, CustomRuleDefinition } from '../types/eval.js';
import type { EvalEngine } from '../eval/engine.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { strictInput } from './strict-input.js';

const CustomRuleSchema = z.object({
  name: z.string(),
  type: z.enum([
    'regex_match', 'regex_no_match', 'min_length', 'max_length',
    'contains_keywords', 'excludes_keywords', 'json_schema', 'cost_threshold',
  ]),
  config: z.record(z.string(), z.unknown()),
  weight: z.number().optional(),
});

const inputSchema = {
  output: z.string().describe('The output text to evaluate (the agent\'s response that gets scored against rules)'),
  // .optional() rather than .default('completeness') so the handler can tell
  // "caller chose completeness" apart from "caller never chose" — the second
  // case gets a note in the response saying safety rules did not run. The
  // effective default is still completeness.
  eval_type: z.enum(['completeness', 'relevance', 'safety', 'cost', 'custom']).optional().describe('Rule bundle to apply: completeness | relevance | safety | cost | custom — picks which built-in rules fire. Defaults to "completeness" when omitted (the response then carries a note that safety rules did not run)'),
  expected: z.string().optional().describe('Expected output for comparison — REQUIRED when eval_type="relevance" (used as keyword-overlap target)'),
  input: z.string().optional().describe('Original input for context (the ask + any source material the agent was given) — improves relevance scoring and grounds the safety bundle\'s hallucination signals'),
  trace_id: z.string().optional().describe('Link evaluation to a trace — surfaces this eval in the dashboard\'s trace drill-through'),
  // .max(10): inline rules skip the deploy-time probe, and the engine runs
  // rules synchronously — without a cap, one request carrying N sandbox-
  // defeating regex rules stalls the server linearly in N (measured 9.3s at
  // N=50). Ten is ample for per-call rules; persistent sets belong in
  // deploy_rule, where deploy-time validation probes each pattern.
  custom_rules: z.array(CustomRuleSchema).max(10).optional().describe('Custom evaluation rules, max 10 per call (deploy persistent rule sets via deploy_rule instead) — fires REGARDLESS of eval_type; pass eval_type="custom" if you want ONLY these'),
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
        'Output shape. Returns JSON: `{ "id": "<uuid>", "eval_type": "<bundle that ran>", "score": 0..1, "passed": boolean, "critical_failures?": string[], "rule_results": [{ "ruleName", "passed", "score", "message", "skipped?" }], "suggestions": string[], "rules_evaluated": number, "rules_skipped": number, "insufficient_data": boolean, "note?": string }`. `insufficient_data=true` means no applicable rules fired (e.g., safety eval with only cost data). `note` appears only when eval_type was omitted, naming the defaulted bundle and that safety rules did not run.',
        '',
        'What `passed` means. `score` and `passed` answer different questions. `score` is the weighted average across the rules that ran — a 0..1 quality gradient. `passed` is the ship/no-ship verdict: true only when the score clears the pass threshold (default 0.7, configurable via config `eval.defaultThreshold`) AND no critical rule failed. Critical rules HARD-FAIL: if one fails, `passed` is false regardless of the weighted score, and the culprits are listed in `critical_failures`. The critical rules are the genuine safety violations — `no_pii`, `no_injection_patterns`, `no_blocklist_words` — plus any deployed custom rule with severity high/critical. A leaked SSN can never be averaged away by other rules passing.',
        '',
        'Use when you want a quality score on a specific output — typically after log_trace records the execution. Pass `eval_type` to route to the right rule bundle: `completeness` (length, sentence count, relevance to input), `relevance` (keyword overlap, topic consistency), `safety` (PII leak, prompt injection, hallucination markers, stub-output detection — pass `input` so the hallucination signals can cross-check the output against the material the agent was given), `cost` (budget threshold), or `custom` (bring your own rules via `custom_rules`).',
        '',
        'Don\'t use when the output is empty or has no applicable rules — the eval_type decides which rules apply, and invalid combinations return score=0 + insufficient_data=true (not an error, but not actionable). Don\'t use to VALIDATE JSON schemas directly (use your language\'s JSON Schema validator — Iris\'s `json_schema` custom rule type is for output-shape assertions, not arbitrary validation).',
        '',
        'Parameters. expected is REQUIRED when eval_type="relevance" (used as the comparison target for keyword overlap + topic consistency); ignored for other eval_types. cost_usd + token_usage are ONLY consulted when eval_type="cost" (ignored otherwise). custom_rules ALWAYS fires regardless of eval_type — pass eval_type="custom" if you want ONLY your rules to run (otherwise both your rules AND the eval_type bundle run together). trace_id is optional but recommended (linking the eval to its trace surfaces it in the dashboard\'s drill-through). input adds context to keyword-overlap relevance checks AND grounds the safety bundle\'s hallucination signals (without it those signals stay silent rather than guess); ignored otherwise. Defaults: eval_type="completeness" — and when you rely on that default, the response carries a `note` reminding you that the safety bundle did not run.',
        '',
        'Error modes. Throws on unknown argument names (strict schema — a misspelled argument is rejected with the valid argument list, never silently dropped). Throws on malformed custom_rules (Zod rejects) and on more than 10 custom_rules in one call (use deploy_rule for persistent rule sets). Returns 400 on regex patterns that fail safe-regex2 ReDoS check or exceed 1000-char limit. Returns 429 when HTTP rate limit exceeded. Storage failures propagate as 500. The eval itself never throws — failing rules report `passed: false` with a message, they don\'t bubble exceptions. A regex that exceeds the 100ms sandbox matching budget on a given output reports skipped with budgetExceeded=true instead of hanging the server (fail-open per rule — gate on that flag if you must fail closed).',
      ].join('\n'),
      inputSchema: strictInput(inputSchema),
      annotations: {
        readOnlyHint: false,     // Writes an eval_result row
        destructiveHint: false,  // Creates new data; doesn't overwrite or delete
        idempotentHint: true,    // Deterministic: same inputs → same score (each call writes a distinct result row, but the SCORE is stable)
        openWorldHint: false,    // No external network in heuristic mode; LLM-as-judge has its own tool with openWorldHint:true
      },
    },
    async (args) => {
      // Track omission explicitly: a caller who never chose a bundle gets
      // the completeness default AND a note saying so — six of seven UAT
      // personas read passed:true on PII-laden text with no hint that the
      // safety bundle never ran.
      const evalTypeOmitted = args.eval_type === undefined;
      const evalType = (args.eval_type ?? 'completeness') as EvalType;

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
              // Echo which bundle actually ran. Without this, a caller who
              // omitted eval_type could not tell a "safety pass" from a
              // completeness eval that never ran a single safety rule.
              eval_type: result.eval_type,
              score: result.score,
              passed: result.passed,
              ...(result.critical_failures ? { critical_failures: result.critical_failures } : {}),
              rule_results: result.rule_results,
              suggestions: result.suggestions,
              rules_evaluated: result.rules_evaluated,
              rules_skipped: result.rules_skipped,
              insufficient_data: result.insufficient_data,
              ...(evalTypeOmitted
                ? {
                    note:
                      'eval_type was omitted, so the default "completeness" bundle ran. Safety rules (PII, injection, blocklist, stub, hallucination) were NOT part of this evaluation — pass eval_type="safety" to run them.',
                  }
                : {}),
            }),
          },
        ],
      };
    },
  );
}
