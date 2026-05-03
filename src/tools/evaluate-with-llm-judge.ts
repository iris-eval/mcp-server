import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { evaluateWithLLMJudge } from '../eval/llm-judge/evaluator.js';
import { findPricing } from '../eval/llm-judge/pricing.js';
import type { LLMProvider } from '../eval/llm-judge/client.js';
import type { TemplateName } from '../eval/llm-judge/templates/index.js';
import { generateEvalId } from '../utils/ids.js';

const inputSchema = {
  output: z.string().min(1).describe('The agent output text to evaluate'),
  template: z
    .enum(['accuracy', 'helpfulness', 'safety', 'correctness', 'faithfulness'])
    .describe(
      'Judge dimension: accuracy (factual correctness), helpfulness (does it address the ask), safety (harm potential), correctness (vs reference answer — requires `expected`), faithfulness (RAG grounding — requires `source_material`).',
    ),
  model: z
    .string()
    .describe(
      'Model ID. Supported: anthropic = claude-opus-4-7 | claude-sonnet-4-6 | claude-haiku-4-5 | claude-haiku-4-5-20251001; openai = gpt-4o | gpt-4o-mini | o1-mini.',
    ),
  provider: z.enum(['anthropic', 'openai']).optional().describe('Auto-detected from model when omitted'),
  input: z.string().optional().describe('User question / prompt that produced the output (improves accuracy for helpfulness/safety)'),
  expected: z.string().optional().describe('Reference answer (required for correctness template)'),
  source_material: z.string().optional().describe('Provided RAG sources (required for faithfulness template)'),
  trace_id: z.string().optional().describe('Link this evaluation to a trace'),
  max_cost_usd: z.number().positive().optional().describe('Cost cap in USD; defaults to IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL or 0.25'),
  max_output_tokens: z.number().int().positive().max(4096).optional().describe('Judge output token cap; default 512'),
  temperature: z.number().min(0).max(2).optional().describe('Sampling temperature; default 0 (deterministic)'),
  timeout_ms: z.number().int().positive().optional().describe('Per-request timeout; default 60_000'),
};

function inferProvider(model: string): LLMProvider {
  const pricing = findPricing(model);
  if (!pricing) {
    throw new Error(
      `Unknown model "${model}". Provider cannot be inferred. Supported models are listed in src/eval/llm-judge/pricing.ts.`,
    );
  }
  return pricing.provider;
}

function resolveApiKey(provider: LLMProvider): string {
  if (provider === 'anthropic') {
    const key = process.env.IRIS_ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        'Anthropic judge requires IRIS_ANTHROPIC_API_KEY. Set it in the environment or use a different provider.',
      );
    }
    return key;
  }
  const key = process.env.IRIS_OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      'OpenAI judge requires IRIS_OPENAI_API_KEY. Set it in the environment or use a different provider.',
    );
  }
  return key;
}

function resolveMaxCost(paramValue?: number): number {
  if (paramValue !== undefined) return paramValue;
  const envRaw = process.env.IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL;
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0.25;
}

export function registerEvaluateWithLLMJudgeTool(
  server: McpServer,
  storage: IStorageAdapter,
): void {
  server.registerTool(
    'evaluate_with_llm_judge',
    {
      title: 'Evaluate With LLM Judge',
      description: [
        'Score agent output using an LLM as the judge (Anthropic or OpenAI). Returns a calibrated 0..1 score with rationale, per-dimension breakdown, and exact cost.',
        '',
        'Sibling tools — evaluate_output runs heuristic rules (free, deterministic, ~ms latency, no API key needed); this tool runs LLM-based semantic scoring (paid, 1-10s latency, requires API key). verify_citations is a SPECIALIZED form of LLM judging that focuses on citation grounding only. log_trace / get_traces handle trace I/O; list_rules / deploy_rule / delete_rule manage heuristic-rule lifecycle. evaluate_with_llm_judge is the GENERAL semantic-scoring path.',
        '',
        'Behavior. Calls an external LLM API (Anthropic or OpenAI) — costs money per call, takes 1-10 seconds, respects an IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL cap. Non-deterministic at temperature > 0; default temperature=0 gives near-deterministic scores. Writes one eval_result row to Iris storage (linked to trace_id if provided) plus captures provider response id + latency + token counts + cost in the rule_results payload. Rate-limited to 20 req/min on HTTP MCP; your LLM provider also enforces its own rate limits (we transparently retry once on 429).',
        '',
        'Output shape. Returns JSON: `{ "id": "<uuid>", "score": 0..1, "passed": boolean, "rationale": string, "dimensions": {...}, "model": string, "provider": "anthropic"|"openai", "template": string, "input_tokens": number, "output_tokens": number, "cost_usd": number, "latency_ms": number }`. `dimensions` has per-dimension sub-scores (e.g., accuracy template returns `{factual_claims, citations, internal_consistency}`).',
        '',
        'Use when heuristic rules (via evaluate_output) are too coarse for the quality signal you need — semantic correctness, factual accuracy vs a reference, RAG faithfulness to sources, nuanced safety/helpfulness. Pick the template that matches: `accuracy` (hallucination detection), `helpfulness` (does it address the ask), `safety` (harm potential beyond regex PII), `correctness` (vs reference answer — pass `expected`), `faithfulness` (RAG grounding — pass `source_material`).',
        '',
        "Don't use for simple regex/length/keyword checks (use evaluate_output with heuristic rules — they're free, deterministic, 1000x faster). Don't use without an API key set (IRIS_ANTHROPIC_API_KEY or IRIS_OPENAI_API_KEY). Don't use on very large outputs (>8K tokens) without raising max_cost_usd — the pre-check will refuse the call.",
        '',
        'Parameters. model is required (no default — pick consciously since cost varies 100x across models). provider is auto-detected from the model name; override only for ambiguous IDs. expected is REQUIRED when template="correctness" (the reference answer to compare against); ignored for other templates. source_material is REQUIRED when template="faithfulness" (the RAG sources to ground against); ignored otherwise. input is optional but improves scoring on helpfulness/safety templates (gives the judge the user prompt that produced the output). max_cost_usd defaults to env var IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL or $0.25 — the worst-case cost is computed BEFORE the call (input_tokens × prompt_price + max_output_tokens × completion_price); call refused upfront if it would exceed. max_output_tokens caps the judge response (default 512, max 4096); higher = more rationale detail + more cost. temperature default 0 (deterministic). timeout_ms default 60000. trace_id optional but recommended (links eval to trace in dashboard). Defaults: temperature=0, max_output_tokens=512, max_cost_usd=$0.25, timeout_ms=60000.',
        '',
        'Error modes. Throws when the required API key env var is missing. Throws when the estimated worst-case cost exceeds max_cost_usd (raise the cap or trim prompts). Throws LLMJudgeError on provider errors — kind=`auth` on 401/403, `rate_limit` on 429 (auto-retried once), `server_error` on 5xx, `timeout` on abort, `malformed_response` when the judge fails to emit valid JSON on both attempts. Throws "Unknown model" for unsupported model IDs — update src/eval/llm-judge/pricing.ts first.',
      ].join('\n'),
      inputSchema,
      annotations: {
        readOnlyHint: false,      // Writes eval_result; also spends money (external API cost)
        destructiveHint: false,   // Creates data; doesn't overwrite or delete
        idempotentHint: false,    // Temperature > 0 may vary; even at T=0 provider non-determinism is possible; cost also varies per call
        openWorldHint: true,      // Calls external APIs (Anthropic / OpenAI) — touches the world beyond local process
      },
    },
    async (args) => {
      const provider = (args.provider as LLMProvider | undefined) ?? inferProvider(args.model);
      const apiKey = resolveApiKey(provider);
      const maxCostUsd = resolveMaxCost(args.max_cost_usd);

      const result = await evaluateWithLLMJudge({
        output: args.output,
        template: args.template as TemplateName,
        provider,
        model: args.model,
        apiKey,
        input: args.input,
        expected: args.expected,
        sourceMaterial: args.source_material,
        maxCostUsdPerEval: maxCostUsd,
        maxOutputTokens: args.max_output_tokens,
        temperature: args.temperature,
        timeoutMs: args.timeout_ms,
      });

      const evalId = generateEvalId();

      // Persist as a normal eval_result so the dashboard picks it up
      // alongside heuristic scores. eval_type is 'custom' because LLM
      // judge doesn't fit completeness/relevance/safety/cost taxonomy
      // cleanly — it spans all four. The rule_results payload carries
      // the full judge provenance.
      await storage.insertEvalResult(LOCAL_TENANT, {
        id: evalId,
        trace_id: args.trace_id,
        eval_type: 'custom',
        output_text: args.output,
        expected_text: args.expected,
        score: result.score,
        passed: result.passed,
        rule_results: [
          {
            ruleName: `llm_judge:${result.template}:${result.provider}/${result.model}`,
            passed: result.passed,
            score: result.score,
            message: result.rationale || 'LLM judge evaluation',
          },
        ],
        suggestions: result.passed ? [] : [result.rationale],
        rules_evaluated: 1,
        rules_skipped: 0,
        insufficient_data: false,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              id: evalId,
              score: result.score,
              passed: result.passed,
              rationale: result.rationale,
              dimensions: result.dimensions,
              model: result.model,
              provider: result.provider,
              template: result.template,
              input_tokens: result.inputTokens,
              output_tokens: result.outputTokens,
              cost_usd: result.costUsd,
              latency_ms: result.latencyMs,
              raw_response_id: result.rawResponseId,
            }),
          },
        ],
      };
    },
  );
}
