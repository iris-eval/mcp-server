import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { verifyCitations } from '../eval/citation-verify/verifier.js';
import { findPricing } from '../eval/llm-judge/pricing.js';
import type { LLMProvider } from '../eval/llm-judge/client.js';
import { generateEvalId } from '../utils/ids.js';

const inputSchema = {
  output: z.string().min(1).describe('The agent output containing citations to verify'),
  model: z
    .string()
    .describe(
      'Judge model for per-citation verification. Supported: anthropic = claude-opus-4-7 | claude-sonnet-4-6 | claude-haiku-4-5-20251001; openai = gpt-4o | gpt-4o-mini | o1-mini.',
    ),
  provider: z.enum(['anthropic', 'openai']).optional().describe('Auto-detected from model when omitted'),
  allow_fetch: z.boolean().optional().describe('Permit outbound HTTP to resolve URLs/DOIs. Defaults to IRIS_CITATION_ALLOW_FETCH=1; false otherwise. SSRF-guarded regardless.'),
  domain_allowlist: z
    .array(z.string())
    .optional()
    .describe('Restrict fetches to hostnames in this list (suffix match allowed). Merged with IRIS_CITATION_DOMAINS env.'),
  max_cost_usd_total: z.number().positive().optional().describe('Cap TOTAL judge cost across all citations in this call; default $1.00'),
  max_citations: z.number().int().positive().max(50).optional().describe('Max citations to verify (extras skipped); default 20'),
  per_source_timeout_ms: z.number().int().positive().optional().describe('Per-URL fetch timeout; default 10_000'),
  per_source_max_bytes: z.number().int().positive().optional().describe('Per-URL body cap; default 5MB'),
  trace_id: z.string().optional().describe('Link verification result to a trace'),
};

function inferProvider(model: string): LLMProvider {
  const pricing = findPricing(model);
  if (!pricing) {
    throw new Error(
      `Unknown model "${model}". Provider cannot be inferred. Supported models: src/eval/llm-judge/pricing.ts.`,
    );
  }
  return pricing.provider;
}

function resolveApiKey(provider: LLMProvider): string {
  const key = provider === 'anthropic' ? process.env.IRIS_ANTHROPIC_API_KEY : process.env.IRIS_OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      `${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} judge requires IRIS_${provider === 'anthropic' ? 'ANTHROPIC' : 'OPENAI'}_API_KEY for verify_citations.`,
    );
  }
  return key;
}

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

export function registerVerifyCitationsTool(server: McpServer, storage: IStorageAdapter): void {
  server.registerTool(
    'verify_citations',
    {
      title: 'Verify Citations',
      description: [
        'Extract citations from agent output, fetch the cited sources, and use an LLM judge to check whether each source supports the claim in context. Returns per-citation verdicts + an overall support ratio.',
        '',
        'Sibling tools — evaluate_with_llm_judge runs general semantic scoring (accuracy, helpfulness, correctness, faithfulness); this tool is specifically for citation grounding (does the cited source actually support the claim). evaluate_output\'s no_hallucination_markers heuristic detects FABRICATED-looking citations cheaply (free, no fetch); this tool resolves and verifies them (paid, opt-in fetch, SSRF-guarded). log_trace / get_traces handle trace I/O. verify_citations is the GROUNDING-CHECK path — narrowest in scope, deepest in rigor.',
        '',
        'Behavior. Three-phase pipeline: (1) regex extraction of [N] numbered refs, (Author, Year) parentheticals, bare URLs, and DOIs (in-process, no network); (2) SSRF-guarded fetch of URL + DOI citations, with scheme allowlist, private/link-local/cloud-metadata IP blocking, optional domain allowlist (IRIS_CITATION_DOMAINS), 10s timeout, 5MB body cap, manual redirect chase (max 3, re-checked), in-process LRU cache; (3) per-citation LLM judge call asking "does this source support this claim?" with a 256-token verdict. Opt-in via allow_fetch=true or IRIS_CITATION_ALLOW_FETCH=1 — Iris refuses outbound HTTP by default. Cost-capped across the entire call by max_cost_usd_total (default $1.00) — the pipeline stops when the cap would be exceeded. Rate-limited to 20 req/min on HTTP MCP. Writes one eval_result row tagged with per-citation provenance.',
        '',
        'Output shape. Returns JSON: `{ "id": "<uuid>", "overall_score": 0..1|null, "passed": boolean, "total_citations_found": number, "total_resolved": number, "total_supported": number, "total_cost_usd": number, "citations": [{ "citation": { "raw", "kind", "identifier", "offset_start", "offset_end" }, "resolve_status": "ok"|"skipped"|"error", "resolve_error"?, "source"?: { "url", "status", "content_type", "bytes_fetched", "truncated" }, "judge"?: { "supported", "confidence", "rationale", "cost_usd", "latency_ms", "input_tokens", "output_tokens" } }] }`. `overall_score = supported / resolved`; `null` when nothing resolvable was found.',
        '',
        'Use when the output makes factual claims backed by [1]-style references, DOIs, or URLs and you want to separate "cited correctly" from "cited and wrong" from "cited but unresolvable". Particularly useful for research/legal/medical agents where fabricated citations are the dominant failure mode.',
        "",
        "Don't use when the agent output has no citations at all (overall_score will be null; the tool degrades gracefully but a heuristic rule is cheaper). Don't use without allow_fetch=true or IRIS_CITATION_ALLOW_FETCH=1 — the tool refuses outbound HTTP unless explicitly enabled. Don't use with an open allowlist + untrusted output on the public internet; you are effectively running a user-directed fetcher. For stricter safety set IRIS_CITATION_DOMAINS to a curated list.",
        '',
        'Parameters. model is required; provider auto-detected from model name (override only for ambiguous IDs). allow_fetch=false by default — outbound HTTP is REFUSED unless explicitly true OR IRIS_CITATION_ALLOW_FETCH=1 env. domain_allowlist suffix-matches hostnames (e.g., "wikipedia.org" allows en.wikipedia.org); merged with IRIS_CITATION_DOMAINS env (UNION — either source permits). max_citations defaults 20, hard cap 50 (extras are skipped silently, NOT errored — check total_citations_found in the response if precise). max_cost_usd_total defaults $1.00 — the pipeline stops mid-citation when the next judge call would exceed the cap (returns partial verdicts). per_source_timeout_ms defaults 10000 (10s); per_source_max_bytes defaults 5MB (truncates at boundary, judges still run on truncated content). trace_id optional but recommended. Defaults: max_citations=20, max_cost_usd_total=$1.00, per_source_timeout_ms=10000, per_source_max_bytes=5242880, allow_fetch=false.',
        '',
        'Error modes. Throws when the API key env var is missing. Throws "Unknown model" on unsupported model IDs. Per-citation errors are collected (resolve_error.kind = bad_scheme / ssrf / not_allowed_domain / timeout / too_large / bad_status / redirect_loop / not_text / fetch_disabled / malformed_judge_response / cost_cap_reached / unresolvable_kind) and returned in the response rather than thrown. An empty output or output with zero extractable citations returns overall_score=null + passed=true (nothing to fail).',
      ].join('\n'),
      inputSchema,
      annotations: {
        readOnlyHint: false,      // Writes eval_result + spends money
        destructiveHint: false,   // Creates data; doesn't overwrite/delete
        idempotentHint: false,    // External fetches + provider non-determinism
        openWorldHint: true,      // Outbound HTTP to citation URLs + LLM provider API
      },
    },
    async (args) => {
      const provider = (args.provider as LLMProvider | undefined) ?? inferProvider(args.model);
      const apiKey = resolveApiKey(provider);
      const allowFetch = resolveAllowFetch(args.allow_fetch);
      const domainAllowlist = resolveDomainAllowlist(args.domain_allowlist);

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

      const evalId = generateEvalId();
      const score = result.overallScore ?? 0;

      // Persist so dashboard can surface. eval_type='custom' — same
      // rationale as evaluate_with_llm_judge (spans all 4 heuristic
      // categories). rule_results[0] carries per-citation summary.
      await storage.insertEvalResult(LOCAL_TENANT, {
        id: evalId,
        trace_id: args.trace_id,
        eval_type: 'custom',
        output_text: args.output,
        score,
        passed: result.passed,
        rule_results: [
          {
            ruleName: `semantic_citation_verify:${provider}/${args.model}`,
            passed: result.passed,
            score,
            message:
              result.overallScore === null
                ? `No resolvable citations (found ${result.totalCitationsFound}, resolved ${result.totalResolved})`
                : `${result.totalSupported}/${result.totalResolved} cited sources supported the output`,
          },
        ],
        suggestions: result.passed ? [] : [`Only ${result.totalSupported}/${result.totalResolved} cited sources actually supported the claim.`],
        rules_evaluated: 1,
        rules_skipped: 0,
        insufficient_data: result.overallScore === null,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              id: evalId,
              overall_score: result.overallScore,
              passed: result.passed,
              total_citations_found: result.totalCitationsFound,
              total_resolved: result.totalResolved,
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
                source: c.source,
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
            }),
          },
        ],
      };
    },
  );
}
