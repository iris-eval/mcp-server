import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { verifyCitations } from '../eval/citation-verify/verifier.js';
import type { LLMProvider } from '../eval/llm-judge/client.js';
import { generateEvalId } from '../utils/ids.js';
import { JUDGE_KEY_VARS } from '../judge-enablement.js';
import { strictInput } from './strict-input.js';
import { assertTraceExists, insertLinkedEvalResult } from './trace-link.js';
import { inferProvider, resolveApiKey } from './evaluate-with-llm-judge.js';
import { describeTool, ERROR_ENVELOPE_SENTENCE } from './describe.js';
import { irisError } from './errors.js';
import { evaluationLinks, guarded, respond } from './respond.js';

const inputSchema = {
  output: z.string().min(1).describe('The agent output containing citations to verify'),
  model: z
    .string()
    .describe(
      'Judge model for per-citation verification. Supported: anthropic = claude-opus-4-7 | claude-sonnet-4-6 | claude-haiku-4-5 | claude-haiku-4-5-20251001; openai = gpt-4o | gpt-4o-mini | o1-mini.',
    ),
  provider: z.enum(['anthropic', 'openai']).optional().describe('Auto-detected from model when omitted'),
  allow_fetch: z.boolean().optional().describe('Permit outbound HTTP to resolve URLs/DOIs. Defaults to IRIS_CITATION_ALLOW_FETCH=1; false otherwise. SSRF-guarded regardless.'),
  domain_allowlist: z
    .array(z.string())
    .optional()
    .describe('Restrict fetches to hostnames in this list (suffix match allowed). Merged with IRIS_CITATION_DOMAINS env.'),
  max_cost_usd_total: z.number().positive().optional().describe('Cap TOTAL judge cost across all citations in this call; default 1.00 USD — the pipeline stops when the next call would exceed it'),
  max_citations: z.number().int().positive().max(50).optional().describe('Max citations to verify (extras skipped, not errored); default 20, at most 50'),
  per_source_timeout_ms: z.number().int().positive().optional().describe('Per-URL fetch timeout; default 10_000'),
  per_source_max_bytes: z.number().int().positive().optional().describe('Per-URL body cap; default 5MB'),
  trace_id: z.string().optional().describe('Link verification result to a stored trace (id from log_trace / get_traces); an unknown id is rejected before any fetch or judge call'),
};

function resolveAllowFetch(paramValue?: boolean): boolean {
  if (paramValue !== undefined) return paramValue;
  return process.env.IRIS_CITATION_ALLOW_FETCH === '1';
}

function resolveDomainAllowlist(paramValue?: string[]): readonly string[] | undefined {
  const envRaw = process.env.IRIS_CITATION_DOMAINS;
  const fromEnv = envRaw ? envRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (paramValue && paramValue.length > 0) {
    return [...new Set([...fromEnv, ...paramValue])];
  }
  return fromEnv.length > 0 ? fromEnv : undefined;
}

/**
 * `passed: true` with `overall_score: null` is the honest answer when there
 * was nothing to judge (no citations, none resolved). It is NOT the honest
 * answer when citations resolved and the judge then failed on every one —
 * a wrong API key, a model the provider refused, a parse failure — because
 * the caller reads "passed" and ships. That case is IRIS_JUDGE_FAILED
 * naming the cause; nothing is stored. (v0.6.0 acceptance pass, observation 3.)
 */
export function assertJudgeRan(result: {
  totalResolved: number;
  totalJudged: number;
  citations: ReadonlyArray<{ resolveStatus: string; resolveError?: { kind: string; message: string } }>;
}): void {
  if (result.totalResolved === 0 || result.totalJudged > 0) return;
  const judgeFailures = result.citations.filter((c) => c.resolveStatus === 'ok' && c.resolveError);
  if (judgeFailures.length === 0) return;
  const kinds = [...new Set(judgeFailures.map((c) => c.resolveError!.kind))].join(', ');
  const first = judgeFailures[0].resolveError!.message;
  throw irisError(
    'IRIS_JUDGE_FAILED',
    `verify_citations could not judge any of the ${result.totalResolved} resolved citation(s): the judge failed on every one (${kinds}). ` +
      `Nothing was verified and nothing was stored, so there is no verdict. First error: ${first}`,
    {
      retryable: /timeout|rate_limit|server_error/.test(kinds),
      recovery: [
        'Check the key and the model: a refused key or an unknown model fails every citation the same way.',
        'Retry when the kind is a timeout, a rate limit or a provider server error.',
        'Raise max_cost_usd_total when the kind is cost_cap_reached.',
      ],
    },
  );
}

export const verifyCitationsOutputSchema = z.looseObject({
  id: z.string().describe('the evaluation id; read it back at iris://evaluations/{id}'),
  trace_id: z.string().optional().describe('the linked trace, when one was named'),
  overall_score: z.number().nullable().describe('supported / judged; null when nothing was judged'),
  passed: z
    .boolean()
    .nullable()
    .describe(
      'true when every judged citation was supported; false when any judged citation was not; NULL when nothing was judged — no verdict, because nothing was verified. Until 0.10.0 that last case returned true.',
    ),
  total_unsupported: z.number().int().describe('judged citations the judge ruled unsupported — the number the verdict turns on'),
  total_citations_found: z.number().int().describe('citations extracted from the output'),
  total_resolved: z.number().int().describe('citations whose source was fetched'),
  total_judged: z.number().int().describe('citations the judge ruled on'),
  total_supported: z.number().int().describe('citations the judge found supported'),
  total_cost_usd: z.number().describe('the spend across every judge call'),
  citations: z.array(z.looseObject({ resolve_status: z.string() })).describe('per citation: the citation (raw, kind, identifier, offsets), resolve_status ok | skipped | error, resolve_error, source (url, status, content_type, bytes_fetched, truncated), judge (supported, confidence, rationale, cost_usd, latency_ms, tokens)'),
});

export function registerVerifyCitationsTool(server: McpServer, storage: IStorageAdapter): void {
  server.registerTool(
    'verify_citations',
    {
      title: 'Verify Citations',
      description: describeTool({
        summary:
          'Extract the citations in an output, fetch the sources (opt-in, SSRF-guarded) and ask an LLM judge on your key whether each source supports its claim.',
        does:
          'Three phases. Extraction, no network: [N] references, (Author, Year), bare URLs and DOIs. Fetch of URL and DOI citations only when allow_fetch is true or IRIS_CITATION_ALLOW_FETCH=1, through a scheme allowlist, private and cloud-metadata address blocking, an optional hostname allowlist (domain_allowlist, merged with IRIS_CITATION_DOMAINS), a per-source timeout and byte cap, and at most three re-checked redirects. ' +
          'Then one judge call per resolved citation on your own key, reading the first part of each source, capped in total by max_cost_usd_total. Up to max_citations are verified; extras are skipped, not errored. ' +
          'overall_score is supported / judged and null when nothing was judged. Per-citation failures (bad scheme, blocked address, timeout, too large, cost cap, fetch disabled) are reported on the citation, never scored as unsupported. One evaluation row is stored.',
        whenNot:
          "When the output has no citations: the score is null, and evaluate_output's hallucination signals are the cheap check. " +
          `Without a key (${JUDGE_KEY_VARS.anthropic} or ${JUDGE_KEY_VARS.openai}): the call returns IRIS_JUDGE_NOT_ENABLED with the enable steps. ` +
          'With fetch enabled and an open allowlist on untrusted output: you are running a user-directed fetcher — set IRIS_CITATION_DOMAINS.',
        returns: verifyCitationsOutputSchema,
        errors:
          'IRIS_JUDGE_NOT_ENABLED, IRIS_JUDGE_UNKNOWN_MODEL and IRIS_UNKNOWN_TRACE before any fetch or spend. IRIS_JUDGE_FAILED when citations resolved but the judge failed on every one — an error, not a passing verdict; nothing is stored. ' +
          ERROR_ENVELOPE_SENTENCE,
        siblings: {
          evaluate_with_llm_judge: 'general semantic scoring',
          evaluate_output: 'the free deterministic path, including the hallucination signals',
          log_trace: 'record the execution first',
        },
      }),
      inputSchema: strictInput(inputSchema),
      outputSchema: verifyCitationsOutputSchema,
      annotations: {
        readOnlyHint: false,      // Writes eval_result + spends money
        destructiveHint: false,   // Creates data; doesn't overwrite/delete
        idempotentHint: false,    // External fetches + provider non-determinism
        openWorldHint: true,      // Outbound HTTP to citation URLs + LLM provider API
      },
    },
    guarded(async (args) => {
      const provider = (args.provider as LLMProvider | undefined) ?? inferProvider(args.model);
      const apiKey = resolveApiKey(provider, 'verify_citations');
      const allowFetch = resolveAllowFetch(args.allow_fetch);
      const domainAllowlist = resolveDomainAllowlist(args.domain_allowlist);

      // Refused before any fetch or judge call spends anything (#376).
      if (args.trace_id) {
        await assertTraceExists(storage, LOCAL_TENANT, args.trace_id);
      }

      const result = await verifyCitations({
        output: args.output,
        provider,
        model: args.model,
        apiKey,
        allowFetch,
        domainAllowlist,
        maxCostUsdTotal: args.max_cost_usd_total,
        maxCitations: args.max_citations,
        perSourceTimeoutMs: args.per_source_timeout_ms,
        perSourceMaxBytes: args.per_source_max_bytes,
      });

      assertJudgeRan(result);

      const evalId = generateEvalId();
      const score = result.overallScore ?? 0;

      // Persist so dashboard can surface. eval_type='custom' — same
      // rationale as evaluate_with_llm_judge (spans all 4 heuristic
      // categories). rule_results[0] carries per-citation summary.
      await insertLinkedEvalResult(storage, LOCAL_TENANT, {
        id: evalId,
        trace_id: args.trace_id,
        eval_type: 'custom',
        output_text: args.output,
        score,
        passed: result.passed === true,
        rule_results: [
          {
            ruleName: `semantic_citation_verify:${provider}/${args.model}`,
            /*
             * Null means nothing was judged, which is not a pass and not a
             * failure — it is a check that did not run. Stored as a SKIP so
             * the composer treats it as coverage rather than silently
             * reading a paid-for "nothing verified" as clean.
             */
            passed: result.passed === null ? false : result.passed,
            ...(result.passed === null
              ? { skipped: true, skipReason: `no citation was judged (found ${result.totalCitationsFound}, resolved ${result.totalResolved})` }
              : {}),
            kind: 'judgment',
            score,
            message:
              result.overallScore === null
                ? `No citations judged (found ${result.totalCitationsFound}, resolved ${result.totalResolved}, judged 0)`
                : `${result.totalSupported}/${result.totalJudged} judged sources supported the output`,
          },
        ],
        suggestions:
          result.passed === null
            ? ['No citation was judged, so nothing about the sources was verified. This is not a pass.']
            : result.passed
              ? []
              : [`${result.totalUnsupported} of ${result.totalJudged} judged sources did not support the claim.`],
        rules_evaluated: 1,
        rules_skipped: 0,
        insufficient_data: result.overallScore === null,
        eval_cost_usd: result.totalCostUsd,
      });

      return respond(
        verifyCitationsOutputSchema,
        {
          id: evalId,
          ...(args.trace_id ? { trace_id: args.trace_id } : {}),
          overall_score: result.overallScore,
          passed: result.passed,
          // Derived rather than read: the verifier reports it, but the tool
          // must not break if a caller hands it an older shape.
          total_unsupported: result.totalUnsupported ?? Math.max(0, result.totalJudged - result.totalSupported),
          total_citations_found: result.totalCitationsFound,
          total_resolved: result.totalResolved,
          total_judged: result.totalJudged,
          total_supported: result.totalSupported,
          total_cost_usd: result.totalCostUsd,
          citations: result.citations.map((c) => ({
            citation: {
              raw: c.citation.raw,
              kind: c.citation.kind,
              identifier: c.citation.identifier,
              offset_start: c.citation.offsetStart,
              offset_end: c.citation.offsetEnd,
            },
            resolve_status: c.resolveStatus,
            resolve_error: c.resolveError,
            // Mapped to the documented snake_case keys. The verifier's
            // internal shape is camelCase (contentType, bytesFetched) and
            // used to be passed through verbatim, so a client parsing
            // `source.content_type` per the description read undefined.
            source: c.source
              ? {
                  url: c.source.url,
                  status: c.source.status,
                  content_type: c.source.contentType,
                  bytes_fetched: c.source.bytesFetched,
                  truncated: c.source.truncated,
                }
              : undefined,
            judge: c.judge
              ? {
                  supported: c.judge.supported,
                  confidence: c.judge.confidence,
                  rationale: c.judge.rationale,
                  cost_usd: c.judge.costUsd,
                  latency_ms: c.judge.latencyMs,
                  input_tokens: c.judge.inputTokens,
                  output_tokens: c.judge.outputTokens,
                }
              : undefined,
          })),
        },
        evaluationLinks(evalId, args.trace_id),
      );
    }),
  );
}
