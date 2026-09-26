/*
 * irisMiddleware — the Vercel AI SDK's language-model middleware, recording
 * every `generateText` / `streamText` call the wrapped model makes.
 *
 *   import { wrapLanguageModel, generateText } from 'ai';
 *   const model = wrapLanguageModel({ model: openai('gpt-5.2'), middleware: irisMiddleware({ agentName: 'support-bot' }) });
 *
 * The span is the same GenAI `chat` span the provider wrappers emit, read
 * from the AI SDK's own call options and result — the prompt, the content,
 * the tool calls, the usage and the finish reason — whatever provider sits
 * under the model. The model's result reaches the caller unchanged; a
 * stream is passed on part by part and recorded when it ends.
 */
import type { Attributes, Message, Part } from './genai.js';
import { MAX_PART_CHARS, inputText, outputText } from './genai.js';
import { defaultRecorder, newSpanId, newTraceId, nowNanos } from './recorder.js';
import type { WrapOptions } from './wrap.js';
import { resourceFor } from './wrap.js';

export type IrisMiddlewareOptions = Omit<WrapOptions, 'streamUsage'>;

type CallOptions = { prompt?: any[]; tools?: any[]; maxOutputTokens?: number; temperature?: number; topP?: number; topK?: number; stopSequences?: string[]; seed?: number; frequencyPenalty?: number; presencePenalty?: number };
type Model = { provider?: string; modelId?: string };

/**
 * The middleware object `wrapLanguageModel` takes. Written against the
 * current specification (`v4`, the `ai` 7 line); `wrapLanguageModel` reads
 * only the wrap functions, so the object is the same for any version.
 */
export interface IrisLanguageModelMiddleware {
  readonly specificationVersion: 'v4';
  wrapGenerate: (options: { doGenerate: () => PromiseLike<any>; params: any; model: any }) => Promise<any>;
  wrapStream: (options: { doStream: () => PromiseLike<any>; params: any; model: any }) => Promise<any>;
}

const clip = (text: string): string => (text.length <= MAX_PART_CHARS ? text : `${text.slice(0, MAX_PART_CHARS)}… [${text.length - MAX_PART_CHARS} more characters not recorded]`);
const parseJson = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

function promptParts(content: unknown): Part[] {
  if (typeof content === 'string') return [{ type: 'text', content: clip(content) }];
  if (!Array.isArray(content)) return [];
  return content.map((p: any): Part => {
    if (p?.type === 'text' && typeof p.text === 'string') return { type: 'text', content: clip(p.text) };
    if (p?.type === 'reasoning' && typeof p.text === 'string') return { type: 'reasoning', content: clip(p.text) };
    if (p?.type === 'tool-call') return { type: 'tool_call', id: p.toolCallId, name: String(p.toolName ?? ''), arguments: parseJson(p.input ?? p.args) };
    if (p?.type === 'tool-result') {
      const out = p.output;
      const response = out && typeof out === 'object' && 'value' in out ? out.value : (out ?? p.result);
      return { type: 'tool_call_response', id: p.toolCallId, response: typeof response === 'string' ? clip(response) : response };
    }
    return { type: typeof p?.type === 'string' ? p.type : 'unknown' };
  });
}

function fromPrompt(prompt: any[] | undefined): { system: Part[]; messages: Message[] } {
  const system: Part[] = [];
  const messages: Message[] = [];
  for (const m of Array.isArray(prompt) ? prompt : []) {
    if (m?.role === 'system') system.push(...promptParts(m.content));
    else messages.push({ role: String(m?.role ?? 'user'), parts: promptParts(m?.content) });
  }
  return { system, messages };
}

const FINISH: Record<string, string> = { stop: 'stop', length: 'length', 'content-filter': 'content_filter', 'tool-calls': 'tool_call', error: 'error' };

/** `{ unified, raw }` in v3 and later, a bare string before. */
function finishOf(reason: any): { unified?: string; raw?: string } {
  if (typeof reason === 'string') return { unified: reason, raw: reason };
  if (reason && typeof reason === 'object') return { unified: reason.unified, raw: reason.raw ?? reason.unified };
  return {};
}

/** `{ inputTokens: { total, cacheRead, … } }` in v3 and later, bare numbers before. */
function usageOf(usage: any): { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number } {
  if (!usage || typeof usage !== 'object') return {};
  const pick = (v: any, key: string) => (typeof v === 'number' ? (key === 'total' ? v : undefined) : typeof v?.[key] === 'number' ? v[key] : undefined);
  return {
    input: pick(usage.inputTokens, 'total'),
    output: pick(usage.outputTokens, 'total'),
    cacheRead: pick(usage.inputTokens, 'cacheRead') ?? (typeof usage.cachedInputTokens === 'number' ? usage.cachedInputTokens : undefined),
    cacheWrite: pick(usage.inputTokens, 'cacheWrite'),
    reasoning: pick(usage.outputTokens, 'reasoning') ?? (typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens : undefined),
  };
}

interface Outcome {
  content: Part[];
  finish: { unified?: string; raw?: string };
  usage: ReturnType<typeof usageOf>;
  responseId?: string;
  responseModel?: string;
  error?: { type: string; message: string };
}

function attributesOf(params: CallOptions, model: Model, outcome: Outcome | undefined): Attributes {
  const provider = typeof model.provider === 'string' ? model.provider.split('.')[0] : 'unknown';
  const a: Attributes = { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': provider };
  if (model.modelId) a['gen_ai.request.model'] = model.modelId;
  const num = (key: string, v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) a[key] = v;
  };
  num('gen_ai.request.max_tokens', params.maxOutputTokens);
  num('gen_ai.request.temperature', params.temperature);
  num('gen_ai.request.top_p', params.topP);
  num('gen_ai.request.top_k', params.topK);
  num('gen_ai.request.seed', params.seed);
  num('gen_ai.request.frequency_penalty', params.frequencyPenalty);
  num('gen_ai.request.presence_penalty', params.presencePenalty);
  if (Array.isArray(params.stopSequences) && params.stopSequences.length > 0) a['gen_ai.request.stop_sequences'] = params.stopSequences;

  const { system, messages } = fromPrompt(params.prompt);
  if (messages.length > 0) a['gen_ai.input.messages'] = JSON.stringify(messages);
  if (system.length > 0) a['gen_ai.system_instructions'] = JSON.stringify(system);
  const tools = (Array.isArray(params.tools) ? params.tools : []).map((t: any) => ({
    type: t?.type === 'function' ? 'function' : String(t?.type ?? 'function'),
    name: String(t?.name ?? t?.id ?? ''),
    ...(t?.description ? { description: t.description } : {}),
    ...(t?.inputSchema ? { parameters: t.inputSchema } : {}),
  }));
  if (tools.length > 0) a['gen_ai.tool.definitions'] = JSON.stringify(tools);
  const asked = inputText(messages);
  if (asked !== undefined) a['iris.input'] = asked;

  if (outcome) {
    if (outcome.responseId) a['gen_ai.response.id'] = outcome.responseId;
    if (outcome.responseModel) a['gen_ai.response.model'] = outcome.responseModel;
    if (outcome.finish.raw) a['gen_ai.response.finish_reasons'] = [outcome.finish.raw];
    const u = outcome.usage;
    if (u.input !== undefined) a['gen_ai.usage.input_tokens'] = u.input;
    if (u.output !== undefined) a['gen_ai.usage.output_tokens'] = u.output;
    if (u.cacheRead !== undefined) a['gen_ai.usage.cache_read.input_tokens'] = u.cacheRead;
    if (u.cacheWrite !== undefined) a['gen_ai.usage.cache_creation.input_tokens'] = u.cacheWrite;
    if (u.reasoning !== undefined) a['gen_ai.usage.reasoning.output_tokens'] = u.reasoning;
    if (outcome.content.length > 0 || outcome.finish.unified) {
      const output: Message[] = [{ role: 'assistant', parts: outcome.content, ...(outcome.finish.unified ? { finish_reason: FINISH[outcome.finish.unified] ?? outcome.finish.unified } : {}) }];
      a['gen_ai.output.messages'] = JSON.stringify(output);
      const answered = outputText(output);
      if (answered !== undefined) a['iris.output'] = answered;
    }
    if (outcome.error) a['error.type'] = outcome.error.type;
  }
  return a;
}

function contentParts(content: unknown): Part[] {
  const parts: Part[] = [];
  for (const c of Array.isArray(content) ? content : []) {
    if (c?.type === 'text' && typeof c.text === 'string') parts.push({ type: 'text', content: clip(c.text) });
    else if (c?.type === 'reasoning' && typeof c.text === 'string') parts.push({ type: 'reasoning', content: clip(c.text) });
    else if (c?.type === 'tool-call') parts.push({ type: 'tool_call', id: c.toolCallId, name: String(c.toolName ?? ''), arguments: parseJson(c.input ?? c.args) });
  }
  return parts;
}

const errorOf = (err: unknown) => ({ type: err instanceof Error ? err.name : 'Error', message: err instanceof Error ? err.message : String(err) });

/** Middleware for `wrapLanguageModel` that records every call the model makes. */
export function irisMiddleware(options: IrisMiddlewareOptions = {}): IrisLanguageModelMiddleware {
  const record = (params: CallOptions, model: Model, start: bigint, outcome: Outcome | undefined) => {
    try {
      const recorder = options.recorder ?? defaultRecorder();
      const attributes = attributesOf(params, model, outcome);
      if (options.sessionId) attributes['gen_ai.conversation.id'] = options.sessionId;
      const modelId = model.modelId;
      recorder.record({
        resource: resourceFor(recorder, options),
        spans: [
          {
            traceId: newTraceId(),
            spanId: newSpanId(),
            name: modelId ? `chat ${modelId}` : 'chat',
            kind: 3,
            startTimeUnixNano: start,
            endTimeUnixNano: nowNanos(),
            attributes,
            status: outcome?.error ? { code: 'error', message: outcome.error.message } : { code: 'ok' },
          },
        ],
      });
    } catch {
      // Recording never fails the call it records.
    }
  };

  return {
    specificationVersion: 'v4',
    async wrapGenerate({ doGenerate, params, model }) {
      const start = nowNanos();
      let result: any;
      try {
        result = await doGenerate();
      } catch (err) {
        record(params, model, start, { content: [], finish: {}, usage: {}, error: errorOf(err) });
        throw err;
      }
      record(params, model, start, {
        content: contentParts(result?.content),
        finish: finishOf(result?.finishReason),
        usage: usageOf(result?.usage),
        responseId: result?.response?.id,
        responseModel: result?.response?.modelId,
      });
      return result;
    },
    async wrapStream({ doStream, params, model }) {
      const start = nowNanos();
      let result: any;
      try {
        result = await doStream();
      } catch (err) {
        record(params, model, start, { content: [], finish: {}, usage: {}, error: errorOf(err) });
        throw err;
      }
      const text = new Map<string, string>();
      const reasoning = new Map<string, string>();
      const calls: Part[] = [];
      const outcome: Outcome = { content: [], finish: {}, usage: {} };
      let recorded = false;
      const done = (error?: { type: string; message: string }) => {
        if (recorded) return;
        recorded = true;
        outcome.content = [
          ...[...reasoning.values()].map((t): Part => ({ type: 'reasoning', content: clip(t) })),
          ...[...text.values()].map((t): Part => ({ type: 'text', content: clip(t) })),
          ...calls,
        ];
        if (error) outcome.error = error;
        record(params, model, start, outcome);
      };
      const watch = new TransformStream<any, any>({
        transform(part, controller) {
          try {
            switch (part?.type) {
              case 'text-delta':
                text.set(part.id ?? '0', (text.get(part.id ?? '0') ?? '') + (part.delta ?? part.textDelta ?? ''));
                break;
              case 'reasoning-delta':
                reasoning.set(part.id ?? '0', (reasoning.get(part.id ?? '0') ?? '') + (part.delta ?? ''));
                break;
              case 'tool-call':
                calls.push({ type: 'tool_call', id: part.toolCallId, name: String(part.toolName ?? ''), arguments: parseJson(part.input ?? part.args) });
                break;
              case 'response-metadata':
                if (part.id) outcome.responseId = part.id;
                if (part.modelId) outcome.responseModel = part.modelId;
                break;
              case 'finish':
                outcome.finish = finishOf(part.finishReason);
                outcome.usage = usageOf(part.usage);
                break;
              case 'error':
                outcome.error = errorOf(part.error);
                break;
              default:
                break;
            }
          } catch {
            // A part the recorder cannot read is still passed on.
          }
          controller.enqueue(part);
        },
        flush() {
          done(outcome.error);
        },
      });
      return { ...result, stream: (result.stream as ReadableStream<any>).pipeThrough(watch) };
    },
  };
}

