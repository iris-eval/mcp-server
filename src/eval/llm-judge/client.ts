// LLM client abstraction for the judge eval path. Two providers are
// implemented (Anthropic + OpenAI); both are thin wrappers around the
// respective completion endpoints. Iris never imports the vendor SDKs at
// runtime — the wire format is simple enough that a fetch() call + a
// small amount of response parsing keeps the dependency surface minimal
// and the supply-chain footprint smaller.
//
// Guarantees:
//   - One deadline for a call: every request, its whole reply, and the wait
//     after a rate limit end before it (DEFAULT_JUDGE_DEADLINE_MS)
//   - Retry on 429 (single retry w/ RateLimit-* header or Retry-After),
//     only where its wait ends before the deadline
//   - Structured error types (LLMJudgeError) — callers distinguish a
//     transient rate-limit from a permanent auth failure, and a provider
//     that could not be reached from one that answered
//   - Usage fields (input_tokens / output_tokens) surfaced so the
//     evaluator can compute cost without a second API call
//   - The answer asked for as structured output where the model offers it
//     (answer.ts): Anthropic's output_config.format, OpenAI's strict
//     json_schema response format; the reply is then the object alone
//   - Each model asked in the form it takes (ANTHROPIC_MODELS,
//     OPENAI_MODELS): a temperature only where it is taken, and a low effort
//     where the model reasons or thinks inside the cap of its answer

import type { JudgeAnswer } from './answer.js';
import { DEFAULT_JUDGE_DEADLINE_MS } from './deadline.js';

export type LLMProvider = 'anthropic' | 'openai';

export interface LLMJudgeRequest {
  provider: LLMProvider;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  temperature: number;
  apiKey: string;
  // The call's whole time in ms: every request, its reply, and the wait after a rate limit (DEFAULT_JUDGE_DEADLINE_MS).
  timeoutMs?: number;
  // The moment (ms since the epoch) by which the call answers, where a caller makes more than one call within one
  // deadline (the evaluator's second request); otherwise now plus timeoutMs.
  deadline?: number;
  // Hard cap — if the request would require more than this many tokens
  // based on the prompt length, reject upfront rather than burning money.
  maxInputTokensEstimate?: number;
  // The object the judge answers with (answer.ts), asked for as structured output where the model offers it.
  answer?: JudgeAnswer;
}

export interface LLMJudgeResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  latencyMs: number;
  rawProviderResponseId?: string;
  /** True when the answer was asked for as structured output, so the reply's text is the answer object alone. */
  structured?: boolean;
}

/**
 * How each OpenAI model Iris prices (pricing.ts) is asked. Every one is sent
 * `max_completion_tokens`: OpenAI's reference calls `max_tokens` deprecated
 * and not compatible with the o-series. A reasoning model takes no
 * `temperature`, and is asked for a low reasoning effort, since its reasoning
 * counts against the same cap as its answer: `low`, which every reasoning
 * model priced takes (GPT-6 Astra, GPT-6.1 Sol, GPT-6.2 Astra and GPT-6.2
 * Sol refuse `none`, and GPT-6.1 Sol `minimal`). Structured output (a strict
 * `json_schema` response format) is asked of every model that offers it,
 * GPT-4o and later. A model not listed is asked as `gpt-4o` is.
 */
export const OPENAI_MODELS: Readonly<Record<string, { reasoning: boolean; effort?: 'low'; structured: boolean }>> = {
  'gpt-6.2-astra': { reasoning: true, effort: 'low', structured: true },
  'gpt-6.2-sol': { reasoning: true, effort: 'low', structured: true },
  'gpt-6.1-terra': { reasoning: true, effort: 'low', structured: true },
  'gpt-6-luna': { reasoning: true, effort: 'low', structured: true },
  'gpt-6.1-sol': { reasoning: true, effort: 'low', structured: true },
  'gpt-6-astra': { reasoning: true, effort: 'low', structured: true },
  'gpt-6-sol': { reasoning: true, effort: 'low', structured: true },
  'gpt-5.6-terra': { reasoning: true, effort: 'low', structured: true },
  'gpt-5.6-luna': { reasoning: true, effort: 'low', structured: true },
  'gpt-5.5': { reasoning: true, effort: 'low', structured: true },
  'gpt-5.4': { reasoning: true, effort: 'low', structured: true },
  'gpt-5.4-mini': { reasoning: true, effort: 'low', structured: true },
  'gpt-5.4-nano': { reasoning: true, effort: 'low', structured: true },
  'gpt-5.2': { reasoning: true, effort: 'low', structured: true },
  'gpt-5.1': { reasoning: true, effort: 'low', structured: true },
  'gpt-5': { reasoning: true, effort: 'low', structured: true },
  'gpt-5-mini': { reasoning: true, effort: 'low', structured: true },
  'gpt-5-nano': { reasoning: true, effort: 'low', structured: true },
  'gpt-4.1': { reasoning: false, structured: true },
  'gpt-4.1-mini': { reasoning: false, structured: true },
  'gpt-4o': { reasoning: false, structured: true },
  'gpt-4o-mini': { reasoning: false, structured: true },
  'o3': { reasoning: true, effort: 'low', structured: true },
  // Shut down by OpenAI; asked as their pages gave it, so a configuration naming one still sends what it sent.
  'o4-mini': { reasoning: true, effort: 'low', structured: true },
  'o3-mini': { reasoning: true, effort: 'low', structured: true },
  // Retired by OpenAI; it offers neither structured output nor a reasoning effort, and is asked in text.
  'o1-mini': { reasoning: true, structured: false },
};
const AS_GPT_4O = { reasoning: false, structured: true } as const;

/**
 * How each Claude model Iris prices (pricing.ts) is asked, from Anthropic's
 * own pages.
 *
 * `temperature`: whether it takes one other than the default (1). The model
 * deprecations page: a non-default `temperature` returns a 400 on Claude 4.7
 * and later models, under API version 2023-06-01 as well, so those are sent
 * none and sample at their default.
 *
 * `thinks`: whether it thinks when the request sets no `thinking`, as every
 * Claude 5 model does (the thinking page). Its thinking counts against
 * `max_tokens`, the same cap as its answer, so such a model is asked for a
 * low effort (`output_config.effort`), at which it keeps its thinking short
 * and skips it on a simple request. A model that does not think is sent no
 * effort: Claude Sonnet 4.5 and Haiku 4.5 do not take one.
 *
 * A Claude model not listed is asked as the current ones are: no
 * temperature, a low effort.
 */
export const ANTHROPIC_MODELS: Readonly<Record<string, { temperature: boolean; thinks: boolean }>> = {
  'claude-fable-5-1': { temperature: false, thinks: true },
  'claude-opus-5-5': { temperature: false, thinks: true },
  'claude-sonnet-5': { temperature: false, thinks: true },
  'claude-opus-5': { temperature: false, thinks: true },
  'claude-opus-4-8': { temperature: false, thinks: false },
  'claude-opus-4-7': { temperature: false, thinks: false },
  'claude-opus-4-6': { temperature: true, thinks: false },
  'claude-sonnet-4-6': { temperature: true, thinks: false },
  'claude-opus-4-5': { temperature: true, thinks: false },
  'claude-sonnet-4-5': { temperature: true, thinks: false },
  'claude-haiku-4-5': { temperature: true, thinks: false },
  'claude-haiku-4-5-20251001': { temperature: true, thinks: false },
};
const AS_CURRENT_CLAUDE = { temperature: false, thinks: true } as const;

/** Whether a model is sent the call's `temperature`: a Claude model before 4.7, or an OpenAI model that does not reason. */
export function takesTemperature(provider: LLMProvider, model: string): boolean {
  return provider === 'anthropic' ? (ANTHROPIC_MODELS[model] ?? AS_CURRENT_CLAUDE).temperature : !(OPENAI_MODELS[model] ?? AS_GPT_4O).reasoning;
}

/**
 * An allowance, in tokens, for the instructions a provider adds to a request
 * that asks for structured output. Neither provider publishes their size; it
 * is above the largest tool-use system prompt Anthropic publishes (804
 * tokens), so a worst case that counts it stays a ceiling.
 */
export const STRUCTURED_ANSWER_ALLOWANCE_TOKENS = 1_000;

export class LLMJudgeError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | 'auth'
      | 'rate_limit'
      | 'bad_request'
      | 'server_error'
      | 'timeout'
      | 'unreachable'
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
// A request that asks for an answer as structured output also carries its
// schema and the provider's instructions for it.
export function estimateInputTokens(systemPrompt: string, userPrompt: string, answer?: JudgeAnswer): number {
  const chars = systemPrompt.length + userPrompt.length;
  if (answer === undefined) return Math.ceil(chars / 4);
  return Math.ceil((chars + answer.name.length + JSON.stringify(answer.schema).length) / 4) + STRUCTURED_ANSWER_ALLOWANCE_TOKENS;
}

/** Why a request could not be made, in words, without throwing: a failed fetch carries its reason as its cause. */
function reasonOf(err: unknown): string {
  try {
    if (err instanceof Error) {
      const cause = (err as { cause?: unknown }).cause;
      const code = cause !== null && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
      return typeof code === 'string' ? `${err.message} (${code})` : err.message;
    }
    return err === null || err === undefined ? 'no reason given' : String(err);
  } catch {
    return 'no reason given';
  }
}

/**
 * One request to the provider and its whole reply, before the deadline: the
 * timer covers the body as well as the wait for it to begin, and the time
 * taken (`latencyMs`) runs to the body's end. A deadline that passes is a
 * timeout. A request that could not be made, and a reply with a success
 * status whose body was cut off before its end, are the provider's failure
 * to be reached (`unreachable`); one whose body arrived and could not be
 * decoded is a malformed reply. An error status is the provider's answer: a
 * body of one that cannot be read reads as empty, and the status decides.
 */
async function postBeforeDeadline(
  provider: string,
  url: string,
  init: RequestInit,
  deadline: number,
  budgetMs: number,
): Promise<{ res: Response; body: string; latencyMs: number }> {
  if (!headersCanBeSent(init.headers)) {
    throw new LLMJudgeError(
      `${provider} API key cannot be sent in a request header: it holds an ASCII control character other than a tab, such as a line break, or a character above U+00FF, such as a curly quote or a zero-width space copied with it. No request was made.`,
      'auth',
    );
  }
  const started = Date.now();
  const timedOut = (): LLMJudgeError => new LLMJudgeError(`${provider} did not answer within ${budgetMs} ms`, 'timeout');
  if (deadline - started <= 0) throw timedOut();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline - started);
  // The request is aborted by its timer alone; an abort, by that or by its name, is the deadline passing.
  const aborted = (err: unknown): boolean => controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
  try {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (aborted(err)) throw timedOut();
      throw new LLMJudgeError(`${provider} could not be reached: ${reasonOf(err)}`, 'unreachable');
    }
    let body: string;
    try {
      body = await res.text();
    } catch (err) {
      if (aborted(err)) throw timedOut();
      if (res.ok && undecodable(err)) throw new LLMJudgeError(`${provider} reply could not be decoded: ${reasonOf(err)}`, 'malformed_response');
      if (res.ok) throw new LLMJudgeError(`${provider} reply was cut off before its end: ${reasonOf(err)}`, 'unreachable');
      body = '';
    }
    return { res, body, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether fetch can send these headers. The runtime's `Headers` drops a tab,
 * a line break, a carriage return or a space at either end of a value, and
 * refuses one holding a NUL, a line break or a carriage return, or a
 * character above U+00FF; fetch's dispatcher also refuses one holding any
 * other ASCII control character but a tab (its own test of a header value,
 * run here on the value `Headers` keeps). The key is the one header that is
 * not a constant, so a refusal is the operator's key, to be fixed where it is
 * set; it is never shown, and no request is made.
 */
function headersCanBeSent(headers: RequestInit['headers']): boolean {
  try {
    for (const [, value] of new Headers(headers)) if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) return false;
    return true;
  } catch {
    return false;
  }
}

/** A body that arrived and could not be decoded: zlib's, brotli's or zstd's own code on the cause fetch gives, where a body cut off carries its socket's. */
function undecodable(err: unknown): boolean {
  try {
    const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
    return typeof code === 'string' && /^(Z_|ERR__ERROR_|ZSTD_error_)/.test(code);
  } catch {
    return false;
  }
}

/** A reply body read as the JSON object the provider sends; anything else is a malformed reply. */
function replyObject(provider: string, body: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new LLMJudgeError(`${provider} response was not valid JSON`, 'malformed_response');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LLMJudgeError(`${provider} response was not a JSON object`, 'malformed_response');
  }
  return value as Record<string, unknown>;
}

/** HTTP's own date form for Retry-After (IMF-fixdate), and Anthropic's reset time (an ISO 8601 date and time). */
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * How long the provider asks to be left, in seconds: `Retry-After` as a
 * number of seconds (0 and more) or an HTTP date, else Anthropic's reset
 * time. A date already past is no wait. Anything else names no wait.
 */
function parseRetryAfter(headers: Headers): number | undefined {
  const untilDate = (at: number): number => Math.max(0, Math.ceil((at - Date.now()) / 1000));
  const retryAfter = headers.get('retry-after')?.trim();
  if (retryAfter !== undefined && retryAfter !== '') {
    if (/^\d+(\.\d+)?$/.test(retryAfter)) return Number(retryAfter);
    if (HTTP_DATE.test(retryAfter) && Number.isFinite(Date.parse(retryAfter))) return untilDate(Date.parse(retryAfter));
    return undefined;
  }
  const reset = headers.get('anthropic-ratelimit-requests-reset')?.trim();
  if (reset !== undefined && ISO_DATE_TIME.test(reset) && Number.isFinite(Date.parse(reset))) return untilDate(Date.parse(reset));
  return undefined;
}

async function callAnthropic(req: LLMJudgeRequest, deadline: number, budgetMs: number): Promise<LLMJudgeResponse> {
  // Every Claude model Iris prices offers structured outputs; the answer comes back as the JSON object alone in a text block.
  const structured = req.answer !== undefined;
  const how = ANTHROPIC_MODELS[req.model] ?? AS_CURRENT_CLAUDE;
  const outputConfig = {
    ...(req.answer !== undefined ? { format: { type: 'json_schema', schema: req.answer.schema } } : {}),
    // A model that thinks unasked shares its output cap with its thinking: a low effort keeps the answer inside it.
    ...(how.thinks ? { effort: 'low' } : {}),
  };
  const { res, body, latencyMs } = await postBeforeDeadline(
    'Anthropic',
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
        ...(how.temperature ? { temperature: req.temperature } : {}),
        system: req.systemPrompt,
        messages: [{ role: 'user', content: req.userPrompt }],
        ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
      }),
    },
    deadline,
    budgetMs,
  );

  if (!res.ok) {
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

  const json = replyObject('Anthropic', body) as {
    id?: string;
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  // The documented shape: `content` is a list of blocks, each an object. Anything else is a malformed reply, and no
  // verdict is read from it.
  if (!Array.isArray(json.content) || !json.content.every((c: unknown) => c !== null && typeof c === 'object' && !Array.isArray(c))) {
    throw new LLMJudgeError('Anthropic response content was not a list of content blocks', 'malformed_response');
  }
  const firstText = json.content.find((c) => c.type === 'text')?.text;
  if (typeof firstText !== 'string' || firstText === '') {
    throw new LLMJudgeError('Anthropic response had no text content block', 'malformed_response');
  }

  return {
    content: firstText,
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
    stopReason: json.stop_reason ?? 'unknown',
    latencyMs,
    rawProviderResponseId: json.id,
    structured,
  };
}

async function callOpenAI(req: LLMJudgeRequest, deadline: number, budgetMs: number): Promise<LLMJudgeResponse> {
  const how = OPENAI_MODELS[req.model] ?? AS_GPT_4O;
  const structured = req.answer !== undefined && how.structured;
  const { res, body, latencyMs } = await postBeforeDeadline(
    'OpenAI',
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        max_completion_tokens: req.maxOutputTokens,
        ...(how.reasoning ? (how.effort !== undefined ? { reasoning_effort: how.effort } : {}) : { temperature: req.temperature }),
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt },
        ],
        ...(structured && req.answer !== undefined
          ? { response_format: { type: 'json_schema', json_schema: { name: req.answer.name, schema: req.answer.schema, strict: true } } }
          : {}),
      }),
    },
    deadline,
    budgetMs,
  );

  if (!res.ok) {
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

  const json = replyObject('OpenAI', body) as {
    id?: string;
    choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  // The documented shape: `choices` is a list. An object keyed "0" in its place is a malformed reply, and no verdict
  // is read from it.
  const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
  const firstText = choice?.message?.content;
  if (typeof firstText !== 'string' || firstText === '') {
    // A model that declines says so in `refusal`, and a reply that reached its cap before any answer ends at `length`.
    const refusal = choice?.message?.refusal;
    if (typeof refusal === 'string' && refusal !== '') {
      throw new LLMJudgeError(`OpenAI's model declined to answer: ${refusal.slice(0, 200)}`, 'malformed_response');
    }
    if (choice?.finish_reason === 'length') {
      throw new LLMJudgeError(
        `OpenAI response had no message content: it ended at its output limit (max_completion_tokens ${req.maxOutputTokens}${how.reasoning ? ", which this model's reasoning counts against" : ''})`,
        'malformed_response',
      );
    }
    throw new LLMJudgeError('OpenAI response had no message content', 'malformed_response');
  }

  return {
    content: firstText,
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
    stopReason: choice?.finish_reason ?? 'unknown',
    latencyMs,
    rawProviderResponseId: json.id,
    structured,
  };
}

// Single-retry-on-429 wrapper. Reads Retry-After/RateLimit-Reset header
// when present; otherwise sleeps 2s. Deliberately one retry — repeated
// retries burn cost on what is usually a provisioning problem, not a
// transient spike. The wait is made only where it ends before the
// deadline, and the second request has what is left of it; otherwise the
// rate limit is answered at once, with the wait the provider named (none
// where it named none). Callers that want more aggressive retry can
// compose.
export async function callLLMJudge(req: LLMJudgeRequest): Promise<LLMJudgeResponse> {
  const estimatedInput = estimateInputTokens(req.systemPrompt, req.userPrompt, req.answer);
  if (req.maxInputTokensEstimate && estimatedInput > req.maxInputTokensEstimate) {
    throw new LLMJudgeError(
      `Estimated input tokens (${estimatedInput}) exceed cap (${req.maxInputTokensEstimate}) — refusing to call`,
      'bad_request',
    );
  }

  const call = req.provider === 'anthropic' ? callAnthropic : callOpenAI;
  const budgetMs = req.timeoutMs ?? DEFAULT_JUDGE_DEADLINE_MS;
  const deadline = req.deadline ?? Date.now() + budgetMs;

  try {
    return await call(req, deadline, budgetMs);
  } catch (err) {
    if (err instanceof LLMJudgeError && err.kind === 'rate_limit') {
      const waitMs = (err.retryAfterSeconds ?? 2) * 1000;
      if (!(Date.now() + waitMs < deadline)) throw err;
      await new Promise((r) => setTimeout(r, waitMs));
      return await call(req, deadline, budgetMs);
    }
    throw err;
  }
}
