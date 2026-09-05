import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { evaluateWithLLMJudge } from '../eval/llm-judge/evaluator.js';
import { findPricing, MODEL_PRICING } from '../eval/llm-judge/pricing.js';
import type { LLMProvider } from '../eval/llm-judge/client.js';
import type { TemplateName } from '../eval/llm-judge/templates/index.js';
import { generateEvalId } from '../utils/ids.js';
import { JUDGE_COST_CAP_VAR, JUDGE_DEFAULT_COST_CAP_USD, JUDGE_KEY_VARS, judgeCostCapUsd, judgeRecovery } from '../judge-enablement.js';
import { strictInput } from './strict-input.js';
import { assertTraceExists, insertLinkedEvalResult } from './trace-link.js';
import { describeTool, ERROR_ENVELOPE_SENTENCE } from './describe.js';
import { irisError } from './errors.js';
import { evaluationLinks, guarded, respond } from './respond.js';
import { CAPABILITIES_RESOURCE_URI } from '../resources/uris.js';

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
      'Model ID. Supported: anthropic = claude-opus-4-7 | claude-sonnet-4-6 | claude-haiku-4-5 | claude-haiku-4-5-20251001; openai = gpt-4o | gpt-4o-mini | o1-mini. Required — cost varies a hundredfold across models',
    ),
  provider: z.enum(['anthropic', 'openai']).optional().describe('Auto-detected from model when omitted'),
  input: z.string().optional().describe('User question / prompt that produced the output (improves accuracy for helpfulness/safety)'),
  expected: z.string().optional().describe('Reference answer (required for correctness template)'),
  source_material: z.string().optional().describe('Provided RAG sources (required for faithfulness template)'),
  trace_id: z.string().optional().describe('Link this evaluation to a stored trace (id from log_trace / get_traces); an unknown id is rejected BEFORE the judge is called'),
  max_cost_usd: z.number().positive().optional().describe(`Cost cap in USD for this call; defaults to ${JUDGE_COST_CAP_VAR} or ${JUDGE_DEFAULT_COST_CAP_USD}. The worst case (two attempts, full max_output_tokens) is computed before the call and refused if it exceeds the cap`),
  max_output_tokens: z.number().int().positive().max(4096).optional().describe('Judge output token cap; default 512'),
  temperature: z.number().min(0).max(2).optional().describe('Sampling temperature; default 0 (deterministic)'),
  timeout_ms: z.number().int().positive().optional().describe('Per-request timeout; default 60_000'),
};

/** The models the pricing table knows, so an unknown one can be refused with the valid list. */
export function supportedModels(): string[] {
  return MODEL_PRICING.map((m) => m.model);
}

export function inferProvider(model: string): LLMProvider {
  const pricing = findPricing(model);
  if (!pricing) {
    throw irisError('IRIS_JUDGE_UNKNOWN_MODEL', `Unknown model "${model}": its provider and price are not known, so the cost cap cannot be enforced.`, {
      field: 'model',
      valid: supportedModels(),
      recovery: ['Pass one of the supported models (see valid).', 'Pass provider explicitly only for a model in the list whose id is ambiguous.'],
    });
  }
  return pricing.provider;
}

/**
 * The key for the provider, from this process's environment. Missing is
 * IRIS_JUDGE_NOT_ENABLED with the enable steps as recovery — the fact
 * users get wrong is that a shell export does not reach the process an
 * MCP client spawns, and the steps say so.
 */
export function resolveApiKey(provider: LLMProvider, toolName = 'evaluate_with_llm_judge'): string {
  const variable = JUDGE_KEY_VARS[provider];
  const key = process.env[variable];
  if (!key) {
    throw irisError('IRIS_JUDGE_NOT_ENABLED', `${toolName} needs ${variable} in the environment of the process that runs Iris; no key for ${provider} reached this process. Nothing was spent.`, {
      field: variable,
      recovery: judgeRecovery(provider),
      see: CAPABILITIES_RESOURCE_URI,
    });
  }
  return key;
}

function resolveMaxCost(paramValue?: number): number {
  if (paramValue !== undefined) return paramValue;
  return judgeCostCapUsd();
}

export const judgeOutputSchema = z.looseObject({
  id: z.string().describe('the evaluation id; read it back at iris://evaluations/{id}'),
  trace_id: z.string().optional().describe('the linked trace, when one was named'),
  score: z.number().describe('0..1 from the judge'),
  passed: z.boolean().describe('the verdict: the score against the template\'s threshold, which is pass_threshold below. Not the model\'s own boolean — that is self_reported_pass'),
  pass_threshold: z.number().describe('the threshold the score was read against, so you can check the arithmetic'),
  self_reported_pass: z.boolean().optional().describe('what the model said about passing, when it said anything. Recorded, never obeyed'),
  disagreement: z.boolean().optional().describe('true when the model\'s own boolean disagrees with the threshold verdict — its rubric and its judgement have come apart on this output'),
  rationale: z.string().describe('the judge\'s reasoning, in its words'),
  dimensions: z.record(z.string(), z.unknown()).describe('per-dimension sub-scores for the template'),
  model: z.string().describe('the model that judged'),
  provider: z.enum(['anthropic', 'openai']).describe('the provider called'),
  template: z.string().describe('the template used'),
  input_tokens: z.number().describe('tokens sent, across both attempts when a retry ran'),
  output_tokens: z.number().describe('tokens received, across both attempts when a retry ran'),
  cost_usd: z.number().nullable().describe('the exact spend from the pricing table'),
  latency_ms: z.number().describe('wall time of the provider call(s)'),
  raw_response_id: z.string().optional().describe('the provider\'s response id, for your own audit'),
});

export function registerEvaluateWithLLMJudgeTool(
  server: McpServer,
  storage: IStorageAdapter,
): void {
  server.registerTool(
    'evaluate_with_llm_judge',
    {
      title: 'Evaluate With LLM Judge',
      description: describeTool({
        summary:
          'Score an output with an LLM judge on your own provider key: a 0..1 score, a rationale, per-dimension sub-scores and the exact spend.',
        does:
          `Calls Anthropic or OpenAI directly with the key in this process's environment (${JUDGE_KEY_VARS.anthropic} or ${JUDGE_KEY_VARS.openai}); Iris never proxies. ` +
          'template picks the question: accuracy, helpfulness, safety, correctness (needs expected) or faithfulness (needs source_material); input improves helpfulness and safety. model is required; provider is inferred from it. ' +
          `The worst-case spend — both attempts, full max_output_tokens — is computed BEFORE the call and refused if it exceeds max_cost_usd (default ${JUDGE_COST_CAP_VAR} or ${JUDGE_DEFAULT_COST_CAP_USD}). ` +
          'temperature defaults to 0; a rate-limited call is retried once. One evaluation row is stored with the provider response id, tokens, cost and latency, linked to trace_id when given. ' +
          "The judge's own accuracy is measurable on a key you supply and is not yet published (see iris://proof).",
        whenNot:
          'For length, keyword, PII, injection or cost checks: evaluate_output is free and deterministic. Without a key: the call returns IRIS_JUDGE_NOT_ENABLED with the enable steps — do not search for them. On very large outputs without raising max_cost_usd: the pre-check refuses.',
        returns: judgeOutputSchema,
        errors:
          'IRIS_JUDGE_NOT_ENABLED (no key for the provider reached this process; recovery carries the steps). IRIS_JUDGE_UNKNOWN_MODEL (valid lists the models). IRIS_UNKNOWN_TRACE, checked before any spend. ' +
          'IRIS_BUDGET_EXCEEDED (nothing spent; the message carries both numbers). IRIS_PROVIDER_ERROR with kind auth, rate_limit, bad_request, server_error, timeout or malformed_response, and retryable set. ' +
          ERROR_ENVELOPE_SENTENCE,
        siblings: {
          evaluate_output: 'the free deterministic path',
          verify_citations: 'citation grounding, the narrower judge',
          log_trace: 'record the execution first',
        },
      }),
      inputSchema: strictInput(inputSchema),
      outputSchema: judgeOutputSchema,
      annotations: {
        readOnlyHint: false,      // Writes eval_result; also spends money (external API cost)
        destructiveHint: false,   // Creates data; doesn't overwrite or delete
        idempotentHint: false,    // Temperature > 0 may vary; even at T=0 provider non-determinism is possible; cost also varies per call
        openWorldHint: true,      // Calls external APIs (Anthropic / OpenAI) — touches the world beyond local process
      },
    },
    guarded(async (args) => {
      const provider = (args.provider as LLMProvider | undefined) ?? inferProvider(args.model);
      const apiKey = resolveApiKey(provider);
      const maxCostUsd = resolveMaxCost(args.max_cost_usd);

      // An unknown trace_id is refused BEFORE the provider call — the old
      // path spent the judge's money and then failed the INSERT with a raw
      // "FOREIGN KEY constraint failed" (#376).
      if (args.trace_id) {
        await assertTraceExists(storage, LOCAL_TENANT, args.trace_id);
      }

      const result = await evaluateWithLLMJudge({
        output: args.output,
        template: args.template as TemplateName,
        model: args.model,
        provider,
        apiKey,
        input: args.input,
        expected: args.expected,
        sourceMaterial: args.source_material,
        maxCostUsdPerEval: maxCostUsd,
        maxOutputTokens: args.max_output_tokens,
        temperature: args.temperature,
        timeoutMs: args.timeout_ms,
      });

      // Persist to eval_results so the dashboard can surface it.
      // eval_type='custom' — LLM judge scores span all 4 heuristic
      // categories (accuracy, helpfulness, safety, faithfulness); 'custom'
      // is the honest bucket. rule_results[0] captures per-dimension
      // breakdown + provider metadata for audit.
      const evalId = generateEvalId();
      await insertLinkedEvalResult(storage, LOCAL_TENANT, {
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
            /*
             * The row says what KIND of claim it is (0.10.0). Without it a
             * stored judge evaluation read back through the composer had no
             * layer to fall into — not a policy, not a detector with a
             * published rate — and a FAILED judgement read back as clean.
             * A judgment the caller asked and paid for decides.
             */
            kind: 'judgment',
            role: 'gate',
            saw: ['output'],
            evidence: [
              {
                type: 'sample',
                score: result.score,
                ...(result.selfReportedPass !== undefined ? { selfReportedPass: result.selfReportedPass } : {}),
                rationaleHash: '',
              },
            ],
            uncertainty: {
              basis: 'unmeasured',
              why: 'the judge is user-keyed and its accuracy is measured only by a run on a key you or the maintainer supplies (npm run proof:judge)',
            },
          },
        ],
        suggestions: result.passed ? [] : [result.rationale],
        rules_evaluated: 1,
        rules_skipped: 0,
        insufficient_data: false,
        // What the evaluation itself cost — the description promised it was
        // kept and the write path stored none of it (arc zero, G15).
        eval_cost_usd: result.costUsd ?? undefined,
        eval_tokens: result.inputTokens + result.outputTokens,
      });

      return respond(
        judgeOutputSchema,
        {
          id: evalId,
          ...(args.trace_id ? { trace_id: args.trace_id } : {}),
          score: result.score,
          passed: result.passed,
          pass_threshold: result.passThreshold,
          ...(result.selfReportedPass !== undefined ? { self_reported_pass: result.selfReportedPass } : {}),
          ...(result.disagreement ? { disagreement: true } : {}),
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
        },
        evaluationLinks(evalId, args.trace_id),
      );
    }),
  );
}
