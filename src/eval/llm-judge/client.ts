// LLM client abstraction for the judge eval path. Two providers are
// implemented (Anthropic + OpenAI); both are thin wrappers around the
// respective completion endpoints. Iris never imports the vendor SDKs at
// runtime — the wire format is simple enough that a fetch() call + a
// small amount of response parsing keeps the dependency surface minimal
// and the supply-chain footprint smaller.
//
// Guarantees:
//   - AbortSignal-respecting timeouts
//   - Retry on 429 (single retry w/ RateLimit-* header or Retry-After)
//   - Structured error types (LLMJudgeError) — callers distinguish a
//     transient rate-limit from a permanent auth failure
//   - Usage fields (input_tokens / output_tokens) surfaced so the
//     evaluator can compute cost without a second API call

export type LLMProvider = 'anthropic' | 'openai';

export interface LLMJudgeRequest {
  provider: LLMProvider;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  temperature: number;
  apiKey: string;
  // Timeout per attempt in ms. Includes retries only if you wrap outside.
  timeoutMs?: number;
  // Hard cap — if the request would require more than this many tokens
  // based on the prompt length, reject upfront rather than burning money.
  maxInputTokensEstimate?: number;
}

export interface LLMJudgeResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  latencyMs: number;
  rawProviderResponseId?: string;
}

export class LLMJudgeError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | 'auth'
      | 'rate_limit'
      | 'bad_request'
      | 'server_error'
      | 'timeout'
      | 'malformed_response'
      | 'unknown',
    public readonly statusCode?: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'LLMJudgeError';
  }
}

// Very rough token estimate — good enough to reject obviously-too-big
// prompts before round-tripping. Real tokenization differs per model;
// both Anthropic and OpenAI hover near 4 chars/token for English text.
export function estimateInputTokens(systemPrompt: string, userPrompt: string): number {
  const chars = systemPrompt.length + userPrompt.length;
  return Math.ceil(chars / 4);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new LLMJudgeError(`Request timed out after ${timeoutMs}ms`, 'timeout');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after') ?? headers.get('anthropic-ratelimit-requests-reset');
  if (!raw) return undefined;
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds) && asSeconds > 0) return asSeconds;
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) {
    return Math.max(1, Math.ceil((asDate - Date.now()) / 1000));
  }
  return undefined;
}

async function callAnthropic(req: LLMJudgeRequest): Promise<LLMJudgeResponse> {
  const timeoutMs = req.timeoutMs ?? 60_000;
  const started = Date.now();

  const res = await fetchWithTimeout(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': req.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxOutputTokens,
        temperature: req.temperature,
        system: req.systemPrompt,
        messages: [{ role: 'user', content: req.userPrompt }],
      }),
    },
    timeoutMs,
  );

  const latencyMs = Date.now() - started;

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const retryAfterSeconds = parseRetryAfter(res.headers);
    if (res.status === 401 || res.status === 403) {
      throw new LLMJudgeError(`Anthropic auth failed (${res.status}): ${body}`, 'auth', res.status);
    }
    if (res.status === 429) {
      throw new LLMJudgeError(
        `Anthropic rate-limited (${res.status})`,
        'rate_limit',
        res.status,
        retryAfterSeconds,
      );
    }
    if (res.status >= 500) {
      throw new LLMJudgeError(`Anthropic server error (${res.status}): ${body}`, 'server_error', res.status);
    }
    throw new LLMJudgeError(`Anthropic bad request (${res.status}): ${body}`, 'bad_request', res.status);
  }

  const json = (await res.json().catch(() => {
    throw new LLMJudgeError('Anthropic response was not valid JSON', 'malformed_response');
  })) as {
    id?: string;
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const firstText = (json.content ?? []).find((c) => c.type === 'text')?.text;
  if (!firstText) {
    throw new LLMJudgeError('Anthropic response had no text content block', 'malformed_response');
  }

  return {
    content: firstText,
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
    stopReason: json.stop_reason ?? 'unknown',
    latencyMs,
    rawProviderResponseId: json.id,
  };
}

async function callOpenAI(req: LLMJudgeRequest): Promise<LLMJudgeResponse> {
  const timeoutMs = req.timeoutMs ?? 60_000;
  const started = Date.now();

  const res = await fetchWithTimeout(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxOutputTokens,
        temperature: req.temperature,
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt },
        ],
      }),
    },
    timeoutMs,
  );

  const latencyMs = Date.now() - started;

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const retryAfterSeconds = parseRetryAfter(res.headers);
    if (res.status === 401 || res.status === 403) {
      throw new LLMJudgeError(`OpenAI auth failed (${res.status}): ${body}`, 'auth', res.status);
    }
    if (res.status === 429) {
      throw new LLMJudgeError(
        `OpenAI rate-limited (${res.status})`,
        'rate_limit',
        res.status,
        retryAfterSeconds,
      );
    }
    if (res.status >= 500) {
      throw new LLMJudgeError(`OpenAI server error (${res.status}): ${body}`, 'server_error', res.status);
    }
    throw new LLMJudgeError(`OpenAI bad request (${res.status}): ${body}`, 'bad_request', res.status);
  }

  const json = (await res.json().catch(() => {
    throw new LLMJudgeError('OpenAI response was not valid JSON', 'malformed_response');
  })) as {
    id?: string;
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const firstText = json.choices?.[0]?.message?.content;
  if (!firstText) {
    throw new LLMJudgeError('OpenAI response had no message content', 'malformed_response');
  }

  return {
    content: firstText,
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
    stopReason: json.choices?.[0]?.finish_reason ?? 'unknown',
    latencyMs,
    rawProviderResponseId: json.id,
  };
}

// Single-retry-on-429 wrapper. Reads Retry-After/RateLimit-Reset header
// when present; otherwise sleeps 2s. Deliberately one retry — repeated
// retries burn cost on what is usually a provisioning problem, not a
// transient spike. Callers that want more aggressive retry can compose.
export async function callLLMJudge(req: LLMJudgeRequest): Promise<LLMJudgeResponse> {
  const estimatedInput = estimateInputTokens(req.systemPrompt, req.userPrompt);
  if (req.maxInputTokensEstimate && estimatedInput > req.maxInputTokensEstimate) {
    throw new LLMJudgeError(
      `Estimated input tokens (${estimatedInput}) exceed cap (${req.maxInputTokensEstimate}) — refusing to call`,
      'bad_request',
    );
  }

  const call = req.provider === 'anthropic' ? callAnthropic : callOpenAI;

  try {
    return await call(req);
  } catch (err) {
    if (err instanceof LLMJudgeError && err.kind === 'rate_limit') {
      const waitSeconds = err.retryAfterSeconds ?? 2;
      await new Promise((r) => setTimeout(r, waitSeconds * 1000));
      return await call(req);
    }
    throw err;
  }
}
