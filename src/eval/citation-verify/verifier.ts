import { callLLMJudge, LLMJudgeError, type LLMProvider } from '../llm-judge/client.js';
import { estimateCostUsd, findPricing } from '../llm-judge/pricing.js';
import { extractCitations, type ExtractedCitation } from './extract.js';
import { resolveSource, CitationResolveError, type ResolvedSource } from './resolve.js';

export interface VerifyCitationsParams {
  output: string;
  provider: LLMProvider;
  model: string;
  apiKey: string;
  allowFetch: boolean;
  domainAllowlist?: readonly string[];
  maxCostUsdTotal?: number;
  perSourceTimeoutMs?: number;
  perSourceMaxBytes?: number;
  // Cap number of citations we attempt — protects against DoS-by-spam.
  maxCitations?: number;
}

export interface VerifiedCitation {
  citation: ExtractedCitation;
  resolveStatus: 'ok' | 'skipped' | 'error';
  resolveError?: { kind: string; message: string };
  source?: Pick<ResolvedSource, 'url' | 'status' | 'contentType' | 'bytesFetched' | 'truncated'>;
  // LLM judge verdict — only set when resolve succeeded.
  judge?: {
    supported: boolean;
    confidence: number;
    rationale: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    latencyMs: number;
  };
}

export interface VerifyCitationsResult {
  // Aggregate — fraction of resolvable citations judged supported.
  // Null when there were zero citations or zero resolvable ones.
  overallScore: number | null;
  passed: boolean;
  // Per-citation detail for the dashboard.
  citations: VerifiedCitation[];
  // Accumulated cost across all LLM calls we made.
  totalCostUsd: number;
  totalCitationsFound: number;
  totalResolved: number;
  totalSupported: number;
}

const SYSTEM = `You are a citation verification evaluator. Given a claim extracted from AI-generated output and the text of a cited source, decide whether the source supports the claim.

Score 0.00 means the source contradicts the claim or does not mention it.
Score 1.00 means the source clearly supports the claim.
Be strict: do not rate as supported unless the source actually contains the assertion. Do NOT penalize paraphrasing; DO penalize invented specifics not in the source.

Respond with a single JSON object — no markdown, no prose:
{
  "supported": <boolean>,
  "confidence": <number 0.00..1.00>,
  "rationale": "<1-2 sentences — quote 5-15 words from the source if you found support>"
}`;

function buildUser(claim: string, sourceText: string): string {
  // Truncate huge sources so we stay within reasonable tokens.
  const maxSourceChars = 12_000; // ~3k tokens
  const trimmed =
    sourceText.length > maxSourceChars
      ? sourceText.slice(0, maxSourceChars) + '\n\n[…source truncated…]'
      : sourceText;
  return `CLAIM:\n${claim}\n\nSOURCE TEXT:\n${trimmed}`;
}

function parseJudgeResult(raw: string): {
  supported: boolean;
  confidence: number;
  rationale: string;
} {
  const trimmed = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first < 0 || last <= first) {
    throw new LLMJudgeError(
      `Citation judge did not emit JSON: ${raw.slice(0, 200)}`,
      'malformed_response',
    );
  }
  const obj = JSON.parse(trimmed.slice(first, last + 1)) as Record<string, unknown>;
  const supported = obj.supported === true;
  const confRaw = obj.confidence;
  const confidence = typeof confRaw === 'number' ? confRaw : Number(confRaw);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new LLMJudgeError(
      `Citation judge confidence out of [0..1]: ${String(confRaw)}`,
      'malformed_response',
    );
  }
  const rationale = typeof obj.rationale === 'string' ? obj.rationale : '';
  return { supported, confidence: Math.round(confidence * 100) / 100, rationale };
}

export async function verifyCitations(
  params: VerifyCitationsParams,
): Promise<VerifyCitationsResult> {
  const citations = extractCitations(params.output);
  const maxCitations = params.maxCitations ?? 20;
  const selected = citations.slice(0, maxCitations);
  const totalFound = citations.length;

  if (!findPricing(params.model)) {
    throw new Error(
      `Unknown model "${params.model}". Add pricing to src/eval/llm-judge/pricing.ts first.`,
    );
  }

  const maxCostTotal = params.maxCostUsdTotal ?? 1.0;

  const out: VerifiedCitation[] = [];
  let totalCost = 0;
  let totalResolved = 0;
  let totalSupported = 0;

  for (const citation of selected) {
    // Only URL/DOI can be resolved. Numbered citations without
    // footnote definitions + author-year refs without a bibliography
    // are flagged as unresolvable — the output claims them but we have
    // nothing to compare against.
    if (citation.kind !== 'url' && citation.kind !== 'doi') {
      out.push({ citation, resolveStatus: 'skipped', resolveError: { kind: 'unresolvable_kind', message: `No source to fetch for ${citation.kind} citation` } });
      continue;
    }

    let source: ResolvedSource;
    try {
      source = await resolveSource(citation.identifier, {
        allowFetch: params.allowFetch,
        timeoutMs: params.perSourceTimeoutMs,
        maxBytes: params.perSourceMaxBytes,
        domainAllowlist: params.domainAllowlist,
      });
      totalResolved++;
    } catch (err) {
      const e = err as CitationResolveError;
      out.push({
        citation,
        resolveStatus: 'error',
        resolveError: { kind: e.kind ?? 'unknown', message: e.message },
      });
      continue;
    }

    // Before calling the judge: would this blow our total cost?
    // Use the same pessimistic estimate as the main LLM judge evaluator.
    const contextLen = citation.contextWindow.length + source.text.length;
    const pessimistic = estimateCostUsd(params.model, Math.ceil(contextLen / 4), 512) ?? 0;
    if (totalCost + pessimistic > maxCostTotal) {
      out.push({
        citation,
        resolveStatus: 'ok',
        source: {
          url: source.url,
          status: source.status,
          contentType: source.contentType,
          bytesFetched: source.bytesFetched,
          truncated: source.truncated,
        },
        resolveError: {
          kind: 'cost_cap_reached',
          message: `Total cost cap $${maxCostTotal.toFixed(2)} would be exceeded by next judge call`,
        },
      });
      break; // No point continuing — subsequent calls will also exceed.
    }

    let judgeResponse;
    try {
      judgeResponse = await callLLMJudge({
        provider: params.provider,
        model: params.model,
        systemPrompt: SYSTEM,
        userPrompt: buildUser(citation.contextWindow, source.text),
        maxOutputTokens: 256,
        temperature: 0,
        apiKey: params.apiKey,
      });
    } catch (err) {
      const e = err as Error;
      out.push({
        citation,
        resolveStatus: 'ok',
        source: {
          url: source.url,
          status: source.status,
          contentType: source.contentType,
          bytesFetched: source.bytesFetched,
          truncated: source.truncated,
        },
        resolveError: {
          kind: err instanceof LLMJudgeError ? err.kind : 'llm_judge_error',
          message: e.message,
        },
      });
      continue;
    }

    const cost = estimateCostUsd(params.model, judgeResponse.inputTokens, judgeResponse.outputTokens);
    totalCost += cost ?? 0;

    let parsed;
    try {
      parsed = parseJudgeResult(judgeResponse.content);
    } catch (err) {
      const e = err as Error;
      out.push({
        citation,
        resolveStatus: 'ok',
        source: {
          url: source.url,
          status: source.status,
          contentType: source.contentType,
          bytesFetched: source.bytesFetched,
          truncated: source.truncated,
        },
        resolveError: {
          kind: 'malformed_judge_response',
          message: e.message,
        },
      });
      continue;
    }

    if (parsed.supported) totalSupported++;

    out.push({
      citation,
      resolveStatus: 'ok',
      source: {
        url: source.url,
        status: source.status,
        contentType: source.contentType,
        bytesFetched: source.bytesFetched,
        truncated: source.truncated,
      },
      judge: {
        supported: parsed.supported,
        confidence: parsed.confidence,
        rationale: parsed.rationale,
        inputTokens: judgeResponse.inputTokens,
        outputTokens: judgeResponse.outputTokens,
        costUsd: cost,
        latencyMs: judgeResponse.latencyMs,
      },
    });
  }

  const overallScore = totalResolved > 0 ? Math.round((totalSupported / totalResolved) * 100) / 100 : null;
  // Fail if >= 50% of resolved sources don't support the claim. When
  // no citations or none resolved, we don't fail — there's nothing to
  // score, we just report that.
  const passed = overallScore === null ? true : overallScore >= 0.5;

  return {
    overallScore,
    passed,
    citations: out,
    totalCostUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
    totalCitationsFound: totalFound,
    totalResolved,
    totalSupported,
  };
}
