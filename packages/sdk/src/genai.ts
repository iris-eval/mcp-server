/*
 * One model call → the attributes of an OpenTelemetry GenAI `chat` span.
 *
 * Three provider APIs, read from their own wire shapes: OpenAI Chat
 * Completions, OpenAI Responses and Anthropic Messages. The request is the
 * JSON body the SDK sent; the response is the JSON body it received, or,
 * for a stream, the same body assembled from its events — so a streamed
 * call and a plain one become the same span.
 *
 * The attributes are the GenAI semantic conventions
 * (https://opentelemetry.io/docs/specs/semconv/gen-ai/): the provider, the
 * request parameters, the response id, model and finish reasons, the usage,
 * the tool catalogue, and the messages as `gen_ai.input.messages` /
 * `gen_ai.output.messages` / `gen_ai.system_instructions` in the
 * conventions' JSON schema. Beside them, `iris.input` and `iris.output`
 * carry the plain text Iris scores — the last thing the user asked and what
 * the model answered — so the rules read words, not a JSON envelope.
 */

export type Json = Record<string, any>;
export type Api = 'chat' | 'responses' | 'messages';
export type AttributeValue = string | number | boolean | string[] | number[];
export type Attributes = Record<string, AttributeValue>;

/** A message part in the conventions' schema. */
export type Part =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; id?: string; name: string; arguments?: unknown }
  | { type: 'tool_call_response'; id?: string; response: unknown }
  | { type: string; [key: string]: unknown };

export interface Message {
  role: string;
  parts: Part[];
  finish_reason?: string;
}

export interface CallRecord {
  api: Api;
  request: Json;
  /** The response body, or the one assembled from a stream; absent when the call failed before one arrived. */
  response?: Json;
  /** The provider's error, when the call failed. */
  error?: { type: string; message: string };
  serverAddress?: string;
  serverPort?: number;
}

/** Longest a single text part may be before it is cut, so one call cannot outgrow the ingest body limit. */
export const MAX_PART_CHARS = 16_384;

export const PROVIDER: Record<Api, string> = { chat: 'openai', responses: 'openai', messages: 'anthropic' };

function clip(text: string, max = MAX_PART_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters not recorded]`;
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A content part that is not text is named by its type and never carried: an image's bytes do not belong in a trace. */
function otherPart(type: unknown): Part {
  return { type: typeof type === 'string' && type.length > 0 ? type : 'unknown' };
}

/* ---------- input ---------- */

function chatContentParts(content: unknown): Part[] {
  if (typeof content === 'string') return [{ type: 'text', content: clip(content) }];
  if (!Array.isArray(content)) return [];
  return content.map((p): Part => {
    if (typeof p === 'string') return { type: 'text', content: clip(p) };
    if (isObject(p) && (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') && typeof p.text === 'string') return { type: 'text', content: clip(p.text) };
    if (isObject(p) && p.type === 'refusal' && typeof p.refusal === 'string') return { type: 'text', content: clip(p.refusal) };
    return otherPart(isObject(p) ? p.type : undefined);
  });
}

function chatInput(body: Json): Message[] {
  const out: Message[] = [];
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!isObject(m)) continue;
    const role = str(m.role) ?? 'user';
    if (role === 'tool') {
      out.push({ role: 'tool', parts: [{ type: 'tool_call_response', id: str(m.tool_call_id), response: clipDeep(m.content) }] });
      continue;
    }
    const parts = chatContentParts(m.content);
    for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      if (isObject(call) && isObject(call.function)) parts.push({ type: 'tool_call', id: str(call.id), name: String(call.function.name ?? ''), arguments: parseArguments(call.function.arguments) });
    }
    out.push({ role, parts });
  }
  return out;
}

function responsesInput(body: Json): Message[] {
  if (typeof body.input === 'string') return [{ role: 'user', parts: [{ type: 'text', content: clip(body.input) }] }];
  const out: Message[] = [];
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (!isObject(item)) continue;
    if (item.type === 'function_call') {
      out.push({ role: 'assistant', parts: [{ type: 'tool_call', id: str(item.call_id), name: String(item.name ?? ''), arguments: parseArguments(item.arguments) }] });
    } else if (item.type === 'function_call_output') {
      out.push({ role: 'tool', parts: [{ type: 'tool_call_response', id: str(item.call_id), response: clipDeep(item.output) }] });
    } else if (item.type === undefined || item.type === 'message') {
      out.push({ role: str(item.role) ?? 'user', parts: chatContentParts(item.content) });
    } else {
      out.push({ role: 'user', parts: [otherPart(item.type)] });
    }
  }
  return out;
}

function anthropicBlocks(content: unknown): Part[] {
  if (typeof content === 'string') return [{ type: 'text', content: clip(content) }];
  if (!Array.isArray(content)) return [];
  return content.map((b): Part => {
    if (!isObject(b)) return otherPart(undefined);
    if (b.type === 'text' && typeof b.text === 'string') return { type: 'text', content: clip(b.text) };
    if (b.type === 'thinking' && typeof b.thinking === 'string') return { type: 'reasoning', content: clip(b.thinking) };
    if (b.type === 'tool_use' || b.type === 'server_tool_use') return { type: 'tool_call', id: str(b.id), name: String(b.name ?? ''), arguments: b.input };
    if (b.type === 'tool_result') {
      const response = typeof b.content === 'string' ? clip(b.content) : Array.isArray(b.content) ? anthropicBlocks(b.content) : b.content;
      return { type: 'tool_call_response', id: str(b.tool_use_id), response };
    }
    return otherPart(b.type);
  });
}

function anthropicInput(body: Json): Message[] {
  const out: Message[] = [];
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!isObject(m)) continue;
    const parts = anthropicBlocks(m.content);
    // A user turn made only of tool results is the tool speaking, as the other two APIs say it.
    const role = str(m.role) === 'user' && parts.length > 0 && parts.every((p) => p.type === 'tool_call_response') ? 'tool' : (str(m.role) ?? 'user');
    out.push({ role, parts });
  }
  return out;
}

function clipDeep(v: unknown): unknown {
  return typeof v === 'string' ? clip(v) : v;
}

export function inputMessages(api: Api, body: Json): Message[] {
  return api === 'chat' ? chatInput(body) : api === 'responses' ? responsesInput(body) : anthropicInput(body);
}

export function systemInstructions(api: Api, body: Json): Part[] | undefined {
  if (api === 'messages' && body.system !== undefined) {
    const parts = anthropicBlocks(body.system);
    return parts.length > 0 ? parts : undefined;
  }
  if (api === 'responses' && typeof body.instructions === 'string') return [{ type: 'text', content: clip(body.instructions) }];
  return undefined;
}

/* ---------- output ---------- */

const CHAT_FINISH: Record<string, string> = { stop: 'stop', length: 'length', content_filter: 'content_filter', tool_calls: 'tool_call', function_call: 'tool_call' };
const ANTHROPIC_FINISH: Record<string, string> = { end_turn: 'stop', stop_sequence: 'stop', pause_turn: 'stop', max_tokens: 'length', model_context_window_exceeded: 'length', tool_use: 'tool_call', refusal: 'content_filter' };

export function outputMessages(api: Api, response: Json): Message[] {
  if (api === 'chat') {
    return (Array.isArray(response.choices) ? response.choices : []).filter(isObject).map((choice) => {
      const message = isObject(choice.message) ? choice.message : {};
      const parts = chatContentParts(message.content);
      if (parts.length === 0 && typeof message.refusal === 'string') parts.push({ type: 'text', content: clip(message.refusal) });
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (isObject(call) && isObject(call.function)) parts.push({ type: 'tool_call', id: str(call.id), name: String(call.function.name ?? ''), arguments: parseArguments(call.function.arguments) });
      }
      const reason = str(choice.finish_reason);
      return { role: 'assistant', parts, ...(reason ? { finish_reason: CHAT_FINISH[reason] ?? reason } : {}) };
    });
  }
  if (api === 'responses') {
    const parts: Part[] = [];
    for (const item of Array.isArray(response.output) ? response.output : []) {
      if (!isObject(item)) continue;
      if (item.type === 'message') parts.push(...chatContentParts(item.content));
      else if (item.type === 'function_call') parts.push({ type: 'tool_call', id: str(item.call_id), name: String(item.name ?? ''), arguments: parseArguments(item.arguments) });
      else if (item.type === 'reasoning') {
        const summary = (Array.isArray(item.summary) ? item.summary : []).map((s: unknown) => (isObject(s) ? str(s.text) : undefined)).filter(Boolean).join('\n');
        if (summary) parts.push({ type: 'reasoning', content: clip(summary) });
      } else parts.push(otherPart(item.type));
    }
    const finish = responsesFinish(response, parts);
    return parts.length > 0 || finish ? [{ role: 'assistant', parts, ...(finish ? { finish_reason: finish } : {}) }] : [];
  }
  const parts = anthropicBlocks(response.content);
  const reason = str(response.stop_reason);
  return parts.length > 0 || reason ? [{ role: 'assistant', parts, ...(reason ? { finish_reason: ANTHROPIC_FINISH[reason] ?? reason } : {}) }] : [];
}

function responsesFinish(response: Json, parts: Part[]): string | undefined {
  const incomplete = isObject(response.incomplete_details) ? str(response.incomplete_details.reason) : undefined;
  if (incomplete === 'max_output_tokens') return 'length';
  if (incomplete === 'content_filter') return 'content_filter';
  if (response.status === 'failed') return 'error';
  if (response.status !== 'completed') return undefined;
  return parts.some((p) => p.type === 'tool_call') ? 'tool_call' : 'stop';
}

/** The provider's own finish reasons, as `gen_ai.response.finish_reasons` carries them. */
function rawFinishReasons(api: Api, response: Json): string[] {
  if (api === 'chat') return (Array.isArray(response.choices) ? response.choices : []).map((c: Json) => str(c?.finish_reason)).filter((r: string | undefined): r is string => r !== undefined);
  if (api === 'messages') return str(response.stop_reason) ? [response.stop_reason] : [];
  const incomplete = isObject(response.incomplete_details) ? str(response.incomplete_details.reason) : undefined;
  return incomplete ? [incomplete] : str(response.status) ? [response.status] : [];
}

/* ---------- the plain text Iris scores ---------- */

const textOfParts = (parts: readonly Part[]): string =>
  parts
    .filter((p): p is { type: 'text'; content: string } => p.type === 'text' && typeof (p as { content?: unknown }).content === 'string')
    .map((p) => p.content)
    .join('\n');

/** The last thing the user asked, in words: the last user message that carries text, else the last message that does. */
export function inputText(messages: readonly Message[]): string | undefined {
  const withText = messages.filter((m) => textOfParts(m.parts).length > 0);
  const user = [...withText].reverse().find((m) => m.role === 'user');
  const chosen = user ?? withText[withText.length - 1];
  return chosen ? textOfParts(chosen.parts) : undefined;
}

/**
 * What the model answered, in words. A turn that only asks for tools is
 * those requests, written out, so a call whose answer was "run get_weather
 * with Paris" is still judged on what it asked for.
 */
export function outputText(messages: readonly Message[]): string | undefined {
  const first = messages[0];
  if (!first) return undefined;
  const text = textOfParts(first.parts);
  if (text.length > 0) return text;
  const calls = first.parts.filter((p) => p.type === 'tool_call') as Array<{ name: string; arguments?: unknown }>;
  if (calls.length > 0) return JSON.stringify(calls.map((c) => ({ tool: c.name, arguments: c.arguments ?? {} })));
  return undefined;
}

/* ---------- tools and usage ---------- */

function toolDefinitions(api: Api, body: Json): Json[] | undefined {
  const tools = Array.isArray(body.tools) ? body.tools.filter(isObject) : [];
  if (tools.length === 0) return undefined;
  return tools.map((t) => {
    if (api === 'chat' && isObject(t.function)) return { type: 'function', name: t.function.name, ...(t.function.description ? { description: t.function.description } : {}), ...(t.function.parameters ? { parameters: t.function.parameters } : {}) };
    if (api === 'messages') return { type: 'function', name: t.name ?? t.type, ...(t.description ? { description: t.description } : {}), ...(t.input_schema ? { parameters: t.input_schema } : {}) };
    return { type: t.type ?? 'function', ...(t.name ? { name: t.name } : { name: t.type }), ...(t.description ? { description: t.description } : {}), ...(t.parameters ? { parameters: t.parameters } : {}) };
  });
}

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  reasoning?: number;
}

function usageOf(api: Api, response: Json): Usage {
  const u = isObject(response.usage) ? response.usage : undefined;
  if (!u) return {};
  if (api === 'chat') {
    return {
      input: num(u.prompt_tokens),
      output: num(u.completion_tokens),
      cacheRead: isObject(u.prompt_tokens_details) ? num(u.prompt_tokens_details.cached_tokens) : undefined,
      reasoning: isObject(u.completion_tokens_details) ? num(u.completion_tokens_details.reasoning_tokens) : undefined,
    };
  }
  if (api === 'responses') {
    return {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: isObject(u.input_tokens_details) ? num(u.input_tokens_details.cached_tokens) : undefined,
      reasoning: isObject(u.output_tokens_details) ? num(u.output_tokens_details.reasoning_tokens) : undefined,
    };
  }
  // Anthropic counts cached tokens beside input_tokens; the conventions count them inside it.
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheCreation = num(u.cache_creation_input_tokens);
  const input = num(u.input_tokens);
  return {
    input: input === undefined ? undefined : input + (cacheRead ?? 0) + (cacheCreation ?? 0),
    output: num(u.output_tokens),
    cacheRead,
    cacheCreation,
  };
}

/* ---------- the span ---------- */

function requestAttributes(api: Api, body: Json): Attributes {
  const a: Attributes = {};
  const set = (key: string, v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) a[key] = v;
    else if (typeof v === 'string' && v.length > 0) a[key] = v;
  };
  set('gen_ai.request.model', body.model);
  set('gen_ai.request.max_tokens', api === 'chat' ? (body.max_completion_tokens ?? body.max_tokens) : api === 'responses' ? body.max_output_tokens : body.max_tokens);
  set('gen_ai.request.temperature', body.temperature);
  set('gen_ai.request.top_p', body.top_p);
  set('gen_ai.request.top_k', body.top_k);
  set('gen_ai.request.frequency_penalty', body.frequency_penalty);
  set('gen_ai.request.presence_penalty', body.presence_penalty);
  set('gen_ai.request.seed', body.seed);
  if (typeof body.n === 'number' && body.n !== 1) a['gen_ai.request.choice.count'] = body.n;
  const stops = api === 'messages' ? body.stop_sequences : body.stop;
  if (typeof stops === 'string') a['gen_ai.request.stop_sequences'] = [stops];
  else if (Array.isArray(stops) && stops.every((s) => typeof s === 'string') && stops.length > 0) a['gen_ai.request.stop_sequences'] = stops;
  return a;
}

export interface GenAiSpan {
  name: string;
  attributes: Attributes;
  error?: { type: string; message: string };
}

/** The span for one call: its name, its attributes, and the error when it failed. */
export function genAiSpan(call: CallRecord, extra: Attributes = {}): GenAiSpan {
  const { api, request } = call;
  const model = typeof request.model === 'string' ? request.model : undefined;
  const attributes: Attributes = {
    'gen_ai.operation.name': 'chat',
    'gen_ai.provider.name': PROVIDER[api],
    ...requestAttributes(api, request),
  };
  if (call.serverAddress) attributes['server.address'] = call.serverAddress;
  if (call.serverPort !== undefined) attributes['server.port'] = call.serverPort;

  const input = inputMessages(api, request);
  if (input.length > 0) attributes['gen_ai.input.messages'] = JSON.stringify(input);
  const system = systemInstructions(api, request);
  if (system) attributes['gen_ai.system_instructions'] = JSON.stringify(system);
  const tools = toolDefinitions(api, request);
  if (tools) attributes['gen_ai.tool.definitions'] = JSON.stringify(tools);
  const asked = inputText(input);
  if (asked !== undefined) attributes['iris.input'] = asked;

  if (call.response) {
    const r = call.response;
    if (typeof r.id === 'string') attributes['gen_ai.response.id'] = r.id;
    if (typeof r.model === 'string') attributes['gen_ai.response.model'] = r.model;
    const reasons = rawFinishReasons(api, r);
    if (reasons.length > 0) attributes['gen_ai.response.finish_reasons'] = reasons;
    const usage = usageOf(api, r);
    if (usage.input !== undefined) attributes['gen_ai.usage.input_tokens'] = usage.input;
    if (usage.output !== undefined) attributes['gen_ai.usage.output_tokens'] = usage.output;
    if (usage.cacheRead !== undefined) attributes['gen_ai.usage.cache_read.input_tokens'] = usage.cacheRead;
    if (usage.cacheCreation !== undefined) attributes['gen_ai.usage.cache_creation.input_tokens'] = usage.cacheCreation;
    if (usage.reasoning !== undefined) attributes['gen_ai.usage.reasoning.output_tokens'] = usage.reasoning;
    const output = outputMessages(api, r);
    if (output.length > 0) attributes['gen_ai.output.messages'] = JSON.stringify(output);
    const answered = outputText(output);
    if (answered !== undefined) attributes['iris.output'] = answered;
  }
  if (call.error) attributes['error.type'] = call.error.type;
  Object.assign(attributes, extra);
  return { name: model ? `chat ${model}` : 'chat', attributes, ...(call.error ? { error: call.error } : {}) };
}

/* ---------- streams, assembled into the body a plain call returns ---------- */

export interface StreamAssembler {
  /** One parsed event (the JSON of an SSE `data:` line). */
  add(event: Json): void;
  /** The response body as a non-streamed call would have returned it, as far as the stream got. */
  result(): Json | undefined;
}

export function chatAssembler(): StreamAssembler {
  let head: Json | undefined;
  let usage: Json | undefined;
  type Slot = { content: string; refusal: string; finish?: string; role: string; calls: Map<number, { id?: string; name: string; args: string }> };
  const choices = new Map<number, Slot>();
  return {
    add(chunk) {
      head ??= { id: chunk.id, model: chunk.model, object: 'chat.completion', created: chunk.created, system_fingerprint: chunk.system_fingerprint };
      if (isObject(chunk.usage)) usage = chunk.usage;
      for (const c of Array.isArray(chunk.choices) ? chunk.choices : []) {
        if (!isObject(c)) continue;
        const index = num(c.index) ?? 0;
        const slot: Slot = choices.get(index) ?? { content: '', refusal: '', role: 'assistant', calls: new Map() };
        const delta = isObject(c.delta) ? c.delta : {};
        if (typeof delta.role === 'string') slot.role = delta.role;
        if (typeof delta.content === 'string') slot.content += delta.content;
        if (typeof delta.refusal === 'string') slot.refusal += delta.refusal;
        for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          if (!isObject(tc)) continue;
          const ti = num(tc.index) ?? 0;
          const call = slot.calls.get(ti) ?? { name: '', args: '' };
          if (typeof tc.id === 'string') call.id = tc.id;
          if (isObject(tc.function)) {
            if (typeof tc.function.name === 'string') call.name += tc.function.name;
            if (typeof tc.function.arguments === 'string') call.args += tc.function.arguments;
          }
          slot.calls.set(ti, call);
        }
        if (typeof c.finish_reason === 'string') slot.finish = c.finish_reason;
        choices.set(index, slot);
      }
    },
    result() {
      if (!head) return undefined;
      return {
        ...head,
        choices: [...choices.entries()]
          .sort(([a], [b]) => a - b)
          .map(([index, s]) => ({
            index,
            message: {
              role: s.role,
              content: s.content.length > 0 ? s.content : null,
              ...(s.refusal.length > 0 ? { refusal: s.refusal } : {}),
              ...(s.calls.size > 0 ? { tool_calls: [...s.calls.values()].map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) } : {}),
            },
            finish_reason: s.finish ?? null,
          })),
        ...(usage ? { usage } : {}),
      };
    },
  };
}

export function responsesAssembler(): StreamAssembler {
  let latest: Json | undefined;
  let text = '';
  return {
    add(event) {
      if (isObject(event.response)) latest = event.response;
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') text += event.delta;
    },
    result() {
      if (!latest) return undefined;
      // A stream cut short has no final response: keep the words that did arrive.
      const hasOutput = Array.isArray(latest.output) && latest.output.length > 0;
      if (hasOutput || text.length === 0) return latest;
      return { ...latest, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] };
    },
  };
}

export function anthropicAssembler(): StreamAssembler {
  let message: Json | undefined;
  const blocks: Json[] = [];
  const partialJson = new Map<number, string>();
  const stopped = new Set<number>();
  return {
    add(event) {
      switch (event.type) {
        case 'message_start':
          if (isObject(event.message)) message = { ...event.message, content: [], usage: { ...(event.message.usage ?? {}) } };
          break;
        case 'content_block_start':
          if (isObject(event.content_block)) blocks[num(event.index) ?? blocks.length] = { ...event.content_block };
          break;
        case 'content_block_delta': {
          const i = num(event.index) ?? 0;
          const block = blocks[i];
          const d = isObject(event.delta) ? event.delta : {};
          if (!block) break;
          if (d.type === 'text_delta' && typeof d.text === 'string') block.text = `${block.text ?? ''}${d.text}`;
          else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') block.thinking = `${block.thinking ?? ''}${d.thinking}`;
          else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') partialJson.set(i, `${partialJson.get(i) ?? ''}${d.partial_json}`);
          break;
        }
        case 'content_block_stop': {
          const i = num(event.index) ?? 0;
          stopped.add(i);
          const json = partialJson.get(i);
          if (json !== undefined && blocks[i]) {
            try {
              blocks[i].input = JSON.parse(json);
            } catch {
              blocks[i].input = json;
            }
          }
          break;
        }
        case 'message_delta':
          if (message) {
            if (isObject(event.delta)) {
              if (event.delta.stop_reason !== undefined) message.stop_reason = event.delta.stop_reason;
              if (event.delta.stop_sequence !== undefined) message.stop_sequence = event.delta.stop_sequence;
            }
            if (isObject(event.usage)) {
              for (const [k, v] of Object.entries(event.usage)) if (v !== null && v !== undefined) message.usage[k] = v;
            }
          }
          break;
        default:
          break;
      }
    },
    result() {
      if (!message) return undefined;
      // A tool_use block still waiting for its stop keeps whatever JSON arrived.
      for (const [i, json] of partialJson) if (blocks[i] && !stopped.has(i)) blocks[i].input = json;
      return { ...message, content: blocks.filter(Boolean) };
    },
  };
}

export function assemblerFor(api: Api): StreamAssembler {
  return api === 'chat' ? chatAssembler() : api === 'responses' ? responsesAssembler() : anthropicAssembler();
}
