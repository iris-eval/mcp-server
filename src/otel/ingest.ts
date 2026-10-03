/*
 * OTLP in — an ExportTraceServiceRequest becomes Iris traces.
 *
 * Iris has exported OTLP/HTTP JSON since 0.4; this is the other direction:
 * a collector, an SDK or an agent framework posts the spans it already
 * emits to `POST /v1/traces`, and each OTLP trace id becomes one Iris
 * trace with its spans — so the trajectory rules (`toSteps`
 * reads `gen_ai.tool.*` off tool spans) run on what the instrumentation
 * already carries, with nothing re-instrumented.
 *
 * What a trace is read from, in order:
 *   agent_name   resource `service.name` (not the SDKs' `unknown_service`
 *                default), else `iris.agent_name` (resource or root span),
 *                else `gen_ai.agent.name` / OpenInference's `agent.name`,
 *                else "otel" — and the answer says it lacked service.name
 *   input        on the root span `iris.input`, then OpenInference's
 *                `llm.input_messages.*`, then `gen_ai.input.messages`,
 *                `gen_ai.prompt` and the other conventions' keys; then the
 *                first model call's `llm.input_messages.*`, then any span in
 *                start order, then a `gen_ai.content.prompt` event. A Python
 *                object's repr is never read as the words
 *   output       the same for `iris.output`, `gen_ai.output.messages`,
 *                `gen_ai.completion`, `llm.output_messages.*`,
 *                `gen_ai.content.completion` — past the root, the span that
 *                ended last first: a run's output is what it ended with
 *   tokens       `gen_ai.usage.input_tokens` / `output_tokens` (and the
 *                older `prompt_tokens` / `completion_tokens`, and Iris's
 *                own `iris.*_tokens`), summed over spans; the cached part
 *                of the input from `gen_ai.usage.cache_read.input_tokens`
 *                and `cache_creation.input_tokens` (and OpenInference's
 *                `llm.token_count.prompt_details.cache_read` / `cache_write`)
 *   cost         `iris.cost_usd`, `gen_ai.usage.cost`, `llm.usage.total_cost`,
 *                summed (cost_source "reported"); when no span carries one,
 *                estimated from each model call's tokens and list price
 *                (cost_source "estimated", src/cost/trace-cost.ts)
 *   run / case   `iris.run`, `iris.case_key` on the resource or the root
 *   evaluate     `iris.evaluate` (true) and `iris.eval_type` on the resource
 *                or the root: the sender asks for this trace to be scored,
 *                as `evaluate: true` does on POST /api/v1/traces
 *   capture      `iris.capture.name`, `iris.capture.version` and
 *                `iris.capture.complete` (a list, or one comma-separated
 *                string, of input, tool_calls, tool_outputs) on the resource
 *                or the root: the instrumentation declares itself and what
 *                it records in full (src/eval/evidence.ts). With
 *                tool_calls declared, a trace with no TOOL span says no tool
 *                was called
 *   spans        every span: kind from `iris.span_kind`, else TOOL when it
 *                carries a tool attribute or `gen_ai.operation.name` is
 *                execute_tool, else INTERNAL for an agent operation
 *                (invoke_agent, create_agent), else LLM when it carries a
 *                GenAI request attribute, else the OTel kind; status from
 *                status.code
 *
 * A trace with no GenAI attributes at all is still stored — with what it
 * carries — and the answer lists what it lacked, so the reader knows why
 * the rules that need an output did not run. The OTLP trace id is kept in
 * metadata; Iris mints its own id, as every other door does.
 */
import { z } from 'zod';
import { CAPTURE_FIELDS, type CaptureField, type Span, type SpanKind, type SpanStatus, type Trace, type ToolDescriptor, type TraceCapture } from '../types/trace.js';
import { generateTraceId, generateSpanId } from '../utils/ids.js';
import { canonicalCapture } from '../eval/evidence.js';
import { AGGREGATED_INPUT_KEYS, AGGREGATED_OUTPUT_KEYS, CACHE_READ_KEYS, CACHE_WRITE_1H_KEYS, CACHE_WRITE_KEYS, INPUT_TOKEN_KEYS, OUTPUT_TOKEN_KEYS } from './usage-keys.js';
import { resolveTraceCost } from '../cost/trace-cost.js';

/* ---- OTLP JSON, loosely typed (unknown fields pass; what we read is checked) ---- */

const anyValue: z.ZodType<unknown> = z.lazy(() =>
  z.looseObject({
      stringValue: z.string().optional(),
      boolValue: z.boolean().optional(),
      intValue: z.union([z.string(), z.number()]).optional(),
      doubleValue: z.number().optional(),
      bytesValue: z.string().optional(),
      arrayValue: z.looseObject({ values: z.array(anyValue).optional() }).optional(),
      kvlistValue: z.looseObject({ values: z.array(keyValue).optional() }).optional(),
  }),
);
const keyValue: z.ZodType<{ key: string; value?: unknown }> = z.looseObject({ key: z.string(), value: anyValue.optional() });

const otlpSpan = z.looseObject({
    traceId: z.string().min(1),
    spanId: z.string().min(1),
    parentSpanId: z.string().optional(),
    name: z.string().optional(),
    kind: z.union([z.number(), z.string()]).optional(),
    startTimeUnixNano: z.union([z.string(), z.number()]).optional(),
    endTimeUnixNano: z.union([z.string(), z.number()]).optional(),
    attributes: z.array(keyValue).optional(),
    events: z
      .array(z.looseObject({ timeUnixNano: z.union([z.string(), z.number()]).optional(), name: z.string().optional(), attributes: z.array(keyValue).optional() }))
      .optional(),
    status: z.looseObject({ code: z.union([z.number(), z.string()]).optional(), message: z.string().optional() }).optional(),
  });

export const otlpTraceRequestSchema = z.looseObject({
    resourceSpans: z
      .array(
        z.looseObject({
            resource: z.looseObject({ attributes: z.array(keyValue).optional() }).optional(),
            scopeSpans: z
              .array(z.looseObject({ scope: z.looseObject({ name: z.string().optional() }).optional(), spans: z.array(z.unknown()).optional() }))
              .optional(),
          }),
      )
      .min(1, 'resourceSpans must carry at least one entry'),
  });
export type OtlpTraceRequest = z.infer<typeof otlpTraceRequestSchema>;

/** An OTLP AnyValue to the plain value it encodes. */
export function fromAnyValue(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if ('stringValue' in o) return o.stringValue;
  if ('boolValue' in o) return o.boolValue;
  if ('intValue' in o) {
    const n = Number(o.intValue);
    return Number.isSafeInteger(n) ? n : String(o.intValue);
  }
  if ('doubleValue' in o) return o.doubleValue;
  if ('bytesValue' in o) return bytesText(o.bytesValue);
  if ('arrayValue' in o) return (((o.arrayValue as { values?: unknown[] } | undefined)?.values) ?? []).map(fromAnyValue);
  if ('kvlistValue' in o) return attributesToRecord((o.kvlistValue as { values?: Array<{ key: string; value?: unknown }> } | undefined)?.values);
  return undefined;
}

/** Base64 without its `=` padding; a loop, so a long run of `=` costs linear time. */
function unpadded(b64: string): string {
  let end = b64.length;
  while (end > 0 && b64.charCodeAt(end - 1) === 61) end -= 1;
  return b64.slice(0, end);
}

/**
 * An OTLP `bytesValue` as the text it carries. OTLP/JSON writes bytes as
 * base64 (the protobuf decoder here does the same), and LangSmith's export
 * sends `gen_ai.prompt` / `gen_ai.completion` as bytes holding UTF-8 JSON, so
 * read as-is the trace's input was base64. Bytes that are valid UTF-8 text
 * are that text; anything else (binary, or not base64 at all) stays as sent.
 */
export function bytesText(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return value;
  const bytes = Buffer.from(value, 'base64');
  // Buffer.from skips what is not base64; a round trip that does not match means it was not base64.
  if (unpadded(bytes.toString('base64')) !== unpadded(value)) return value;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
  // Control characters other than tab, newline and carriage return mean binary, not text.
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) return value;
  }
  return text;
}

type Side = 'input' | 'output';

const USER_ROLES = new Set(['user', 'human', 'HumanMessage', 'HumanMessageChunk']);
const ASSISTANT_ROLES = new Set(['assistant', 'ai', 'model', 'AIMessage', 'AIMessageChunk']);

/** The words of one message's content: a string, or the text parts of a list. */
function contentWords(content: unknown): string | undefined {
  if (typeof content === 'string') return content.length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' && typeof (p as Record<string, unknown>).text === 'string' ? ((p as Record<string, unknown>).text as string) : undefined))
    .filter((t): t is string => t !== undefined && t.length > 0);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

/**
 * One message in any of the shapes an export writes: `{ role, content }`
 * (OpenAI, the GenAI conventions' `parts` too), `{ type: 'human', content }`
 * (LangChain's dict), or LangChain's serialized constructor
 * `{ lc: 1, type: 'constructor', id: [..., 'HumanMessage'], kwargs: { content } }`.
 */
function roleAndWords(m: unknown): { role: string; words?: string } | undefined {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return undefined;
  const o = m as Record<string, unknown>;
  if (o.lc === 1 && o.type === 'constructor' && Array.isArray(o.id) && o.kwargs && typeof o.kwargs === 'object') {
    const kwargs = o.kwargs as Record<string, unknown>;
    return { role: String(o.id[o.id.length - 1]), words: contentWords(kwargs.content) };
  }
  const role = typeof o.role === 'string' ? o.role : typeof o.type === 'string' ? o.type : undefined;
  if (role === undefined) return undefined;
  const words = contentWords(o.content) ?? (Array.isArray(o.parts) ? contentWords((o.parts as unknown[]).map((p) => (p && typeof p === 'object' && (p as Record<string, unknown>).type === 'text' ? { text: (p as Record<string, unknown>).content } : p))) : undefined);
  return { role, words };
}

/**
 * The message list a value carries: a bare array of messages (the GenAI
 * conventions' `gen_ai.input.messages` / `gen_ai.output.messages`, OpenAI's
 * `[{ role, content }]`, Semantic Kernel's content events), a LangChain run's
 * `{ messages: [...] }` (a model's `[[...]]` flattened one level), or a model
 * result's first generation. An array counts only when every element is a
 * message with a role, so a list of anything else is left as it came.
 */
function messagesIn(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    const flat = value.flatMap((m) => (Array.isArray(m) ? m : [m]));
    return flat.length > 0 && flat.every((m) => roleAndWords(m) !== undefined) ? flat : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  if (Array.isArray(o.messages)) {
    const flat = (o.messages as unknown[]).flatMap((m) => (Array.isArray(m) ? m : [m]));
    return flat.some((m) => roleAndWords(m) !== undefined) ? flat : undefined;
  }
  if (Array.isArray(o.generations)) {
    const first = (o.generations as unknown[]).flat()[0] as Record<string, unknown> | undefined;
    if (first && typeof first === 'object') {
      if (first.message !== undefined && roleAndWords(first.message) !== undefined) return [first.message];
      if (typeof first.text === 'string' && first.text.length > 0) return [{ role: 'assistant', content: first.text }];
    }
  }
  return undefined;
}

/**
 * Messages read down to their words: for the input, the last user message;
 * for the output, the last assistant message with text. The GenAI
 * conventions carry a call's messages as a JSON array (`gen_ai.input.messages`,
 * `gen_ai.output.messages`), and LangSmith's export writes a run's whole
 * state as JSON (`{"messages": [...]}` for a graph, `{"generations": ...}` for
 * a model); read as they came, the rules got a JSON document where they
 * expect what was asked and what was answered, and so did search. The span
 * keeps the attribute as sent. Anything that is not messages, or has no
 * words for that side (an answer that is only tool calls), is returned as it
 * came.
 */
export function wordsOf(text: string, side: Side): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const messages = messagesIn(parsed);
  if (!messages) return text;
  const wanted = side === 'input' ? USER_ROLES : ASSISTANT_ROLES;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = roleAndWords(messages[i]);
    if (m && wanted.has(m.role) && m.words !== undefined) return m.words;
  }
  return text;
}

/** An OTLP attribute list to a record; a later duplicate key wins. */
export function attributesToRecord(list: Array<{ key: string; value?: unknown }> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of list ?? []) out[kv.key] = fromAnyValue(kv.value);
  return out;
}

function nanosToIso(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const digits = String(value).trim();
  if (!/^\d+$/.test(digits)) return undefined;
  const ms = Number(BigInt(digits) / 1_000_000n);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

const OTEL_KIND: Record<string, SpanKind> = {
  '0': 'INTERNAL',
  '1': 'INTERNAL',
  '2': 'SERVER',
  '3': 'CLIENT',
  '4': 'PRODUCER',
  '5': 'CONSUMER',
  SPAN_KIND_UNSPECIFIED: 'INTERNAL',
  SPAN_KIND_INTERNAL: 'INTERNAL',
  SPAN_KIND_SERVER: 'SERVER',
  SPAN_KIND_CLIENT: 'CLIENT',
  SPAN_KIND_PRODUCER: 'PRODUCER',
  SPAN_KIND_CONSUMER: 'CONSUMER',
};

/** The GenAI conventions' agent operations: the agent's own span, which wraps its model and tool calls. */
const AGENT_OPERATIONS = new Set(['invoke_agent', 'create_agent']);
const TOOL_MARKERS = ['gen_ai.tool.name', 'gen_ai.tool.call.id', 'tool.name', 'tool_name', 'tool_call.function.name', 'ai.toolCall.name'];
const LLM_MARKERS = ['gen_ai.request.model', 'gen_ai.response.model', 'gen_ai.system', 'gen_ai.provider.name', 'llm.request.model', 'llm.model_name', 'ai.model.id', 'llm.request.type'];

function spanKindOf(attrs: Record<string, unknown>, otelKind: string | number | undefined): SpanKind {
  const declared = attrs['iris.span_kind'];
  if (declared === 'LLM' || declared === 'TOOL') return declared;
  // OpenInference (Phoenix, and the CrewAI / OpenAI-Agents / ADK instrumentors most teams install) names the kind outright.
  const openInference = attrs['openinference.span.kind'];
  if (openInference === 'TOOL') return 'TOOL';
  if (openInference === 'LLM') return 'LLM';
  // LangSmith's export names the run type; OpenLLMetry names its own kinds (workflow, task, agent, tool).
  const langsmith = attrs['langsmith.span.kind'];
  if (langsmith === 'tool') return 'TOOL';
  if (langsmith === 'llm') return 'LLM';
  if (attrs['traceloop.span.kind'] === 'tool') return 'TOOL';
  const op = attrs['gen_ai.operation.name'];
  if (op === 'execute_tool' || TOOL_MARKERS.some((k) => attrs[k] !== undefined)) return 'TOOL';
  /*
   * An agent operation is the run around the model calls, not a model call,
   * even when it carries the model's name or the run's usage (the Agent
   * Framework puts both on invoke_agent). Filed under LLM it doubled the
   * model calls a reader counted in the drawer. Usage is summed over the
   * leaf carriers whatever their kind, so the totals do not move.
   */
  if (typeof op === 'string' && AGENT_OPERATIONS.has(op)) return 'INTERNAL';
  if (LLM_MARKERS.some((k) => attrs[k] !== undefined) || (typeof op === 'string' && op.length > 0)) return 'LLM';
  return OTEL_KIND[String(otelKind ?? 0)] ?? 'INTERNAL';
}

function statusOf(code: string | number | undefined): SpanStatus {
  const c = String(code ?? 0).toUpperCase();
  if (c === '1' || c === 'STATUS_CODE_OK' || c === 'OK') return 'OK';
  if (c === '2' || c === 'STATUS_CODE_ERROR' || c === 'ERROR') return 'ERROR';
  return 'UNSET';
}

/*
 * The conventions a buyer will test against this door, in
 * the order they are read: Iris's own keys, the OTel GenAI conventions
 * (current, then the names deprecated in v1.37 that LangSmith's export and
 * Semantic Kernel still emit), OpenInference (`input.value`,
 * `llm.token_count.*`), Traceloop (`traceloop.entity.*`, indexed
 * `gen_ai.prompt.N.content`), Semantic Kernel's `gen_ai.response.*_tokens`,
 * and the Vercel AI SDK's legacy `ai.*`. Langfuse, LangSmith, Braintrust and
 * Weave each map four to eight of these vocabularies; a trace arriving with
 * no input and a doubled cost is a lost buyer.
 */
const INPUT_KEYS = ['iris.input', 'gen_ai.input.messages', 'gen_ai.prompt', 'input.value', 'traceloop.entity.input', 'ai.prompt'];
const OUTPUT_KEYS = ['iris.output', 'gen_ai.output.messages', 'gen_ai.completion', 'output.value', 'traceloop.entity.output', 'ai.response.text'];
const TOTAL_TOKEN_KEYS = ['gen_ai.usage.total_tokens', 'iris.total_tokens', 'llm.token_count.total'];
const COST_KEYS = ['iris.cost_usd', 'gen_ai.usage.cost', 'llm.usage.total_cost'];
/** The GenAI conventions' agent, then OpenInference's (the OpenAI Agents SDK instrumentor sets it on the agent's span). */
const AGENT_NAME_KEYS = ['gen_ai.agent.name', 'agent.name'];
/**
 * What every OTel SDK names a service nobody named: `unknown_service`, or
 * `unknown_service:<process>` (`unknown_service:python.exe`,
 * `unknown_service:node`). It names the runtime, not the agent; read as the
 * agent it filed every unnamed Python app under one name and hid the agent
 * the spans themselves named.
 */
function isDefaultServiceName(name: string): boolean {
  return name === 'unknown_service' || name.startsWith('unknown_service:');
}
const MODEL_KEYS = ['gen_ai.request.model', 'gen_ai.response.model', 'llm.model_name', 'llm.request.model', 'ai.model.id'];
const CONVERSATION_KEYS = ['gen_ai.conversation.id', 'session.id'];
const TOOL_DEFINITION_KEYS = ['gen_ai.tool.definitions'];

function asText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Traceloop writes a prompt as one attribute per message —
 * `gen_ai.prompt.0.role`, `gen_ai.prompt.0.content`, `gen_ai.prompt.1.…` —
 * and a completion likewise under `gen_ai.completion.N`. Read in index
 * order, joined by newlines, until an index is missing.
 */
function indexedText(attrs: Record<string, unknown>, prefix: string): string | undefined {
  const parts: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    const content = attrs[`${prefix}.${i}.content`];
    if (content === undefined) break;
    const text = asText(content);
    if (text !== undefined) parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * A Python object's repr — `StopEvent(result=AgentOutput(...))`,
 * `AgentWorkflowStartEvent()` — is what OpenInference records as
 * `input.value` / `output.value` on a LlamaIndex workflow's own steps. It
 * holds the words somewhere inside, but it is not them: read as the trace's
 * output, the rules judged a class name. A value of that shape is passed over
 * for the next carrier; natural-language text does not open with
 * `Name(field=` and close on `)` — or on the `...` OpenInference cuts a long
 * repr off with at 200 characters.
 */
const OBJECT_REPR = /^[A-Z][A-Za-z0-9_]*\((?:\)|[A-Za-z_][A-Za-z0-9_]*=)/;
export function isObjectRepr(text: string): boolean {
  const t = text.trim();
  return (t.endsWith(')') || t.endsWith('...')) && OBJECT_REPR.test(t);
}

const OI_MESSAGE = /^llm\.(input|output)_messages\.(\d+)\.message\.(role|content|contents\.(\d+)\.message_content\.text)$/;

/**
 * OpenInference writes a model call's messages as one attribute per field —
 * `llm.input_messages.1.message.role`, `….message.content`, or the parts
 * under `….message.contents.0.message_content.text` — and the OpenAI Agents
 * SDK's Python instrumentor starts the input at index 1 (the instructions are
 * not a message there). Read in index order to the last user message for the input
 * and the last assistant message with words for the output.
 */
export function openInferenceWords(attrs: Record<string, unknown>, side: Side): string | undefined {
  const messages = new Map<number, { role?: string; content?: string; parts: Map<number, string> }>();
  for (const [key, value] of Object.entries(attrs)) {
    const m = OI_MESSAGE.exec(key);
    if (!m || m[1] !== side || typeof value !== 'string') continue;
    const index = Number(m[2]);
    const message = messages.get(index) ?? { parts: new Map<number, string>() };
    if (m[3] === 'role') message.role = value;
    else if (m[3] === 'content') message.content = value;
    else message.parts.set(Number(m[4]), value);
    messages.set(index, message);
  }
  const wanted = side === 'input' ? USER_ROLES : ASSISTANT_ROLES;
  const ordered = [...messages.entries()].sort((a, b) => a[0] - b[0]).map(([, message]) => message);
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const { role, content, parts } = ordered[i];
    if (role === undefined || !wanted.has(role)) continue;
    const words = content !== undefined && content.length > 0 ? content : [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).filter((t) => t.length > 0).join('\n');
    if (words.length > 0) return words;
  }
  return undefined;
}

/**
 * The spans in the order a side is read: the root first, then — for the
 * input — the rest in start order, and — for the output — the rest latest
 * end first. A run's output is what it ended with; the OpenAI Agents SDK puts
 * nothing on its root, and reading its spans in start order took the first
 * model call's answer, which was a tool call.
 */
function readingOrder(rootFirst: readonly MappedSpan[], side: Side): MappedSpan[] {
  if (side === 'input' || rootFirst.length < 2) return [...rootFirst];
  const [root, ...rest] = rootFirst;
  const endOf = (m: MappedSpan) => (m.span.end_time !== undefined ? Date.parse(m.span.end_time) : m.startMs);
  return [root, ...rest.map((m, i) => ({ m, i })).sort((a, b) => endOf(b.m) - endOf(a.m) || a.i - b.i).map(({ m }) => m)];
}

function firstText(rootFirst: readonly MappedSpan[], side: Side, eventName: string, eventKey: string, indexedPrefix?: string): string | undefined {
  const found = rawFirstText(readingOrder(rootFirst, side), side, eventName, eventKey, indexedPrefix);
  return found === undefined ? undefined : wordsOf(found, side);
}

function keyText(s: MappedSpan, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    if (s.attrs[k] === undefined) continue;
    const text = asText(s.attrs[k]);
    if (text !== undefined && !isObjectRepr(text)) return text;
  }
  return undefined;
}

function rawFirstText(spans: readonly MappedSpan[], side: Side, eventName: string, eventKey: string, indexedPrefix?: string): string | undefined {
  const keys = side === 'input' ? INPUT_KEYS : OUTPUT_KEYS;
  const [root, ...rest] = spans;
  // On the root: Iris's own key, then the model call's messages when the root is one, then the rest of the keys.
  const onRoot = root === undefined ? undefined : keyText(root, keys.slice(0, 1)) ?? openInferenceWords(root.attrs, side) ?? keyText(root, keys);
  if (onRoot !== undefined) return onRoot;
  // The model calls' own messages before a framework step's arguments: in a LlamaIndex workflow those are object reprs.
  for (const s of rest) { const t = openInferenceWords(s.attrs, side); if (t !== undefined) return t; }
  for (const s of rest) { const t = keyText(s, keys); if (t !== undefined) return t; }
  if (indexedPrefix !== undefined) for (const s of spans) { const t = indexedText(s.attrs, indexedPrefix); if (t !== undefined) return t; }
  for (const s of spans) for (const e of s.events) if (e.name === eventName && e.attrs[eventKey] !== undefined) return asText(e.attrs[eventKey]);
  return undefined;
}

function firstString(spans: readonly MappedSpan[], keys: readonly string[]): string | undefined {
  for (const s of spans) for (const k of keys) { const v = s.attrs[k]; if (typeof v === 'string' && v.length > 0) return v; }
  return undefined;
}

function firstNumber(attrs: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const k of keys) { const v = attrs[k]; if (typeof v === 'number' && Number.isFinite(v)) return v; }
  return undefined;
}

/**
 * The capture source's declaration from `iris.capture.*` (src/eval/evidence.ts).
 * `complete` is a list, or one comma-separated string for an exporter that
 * writes only strings. A value Iris does not know is left out and named in
 * `lacked`; so is a declaration without a name, since a reader must be able
 * to say who made the promise.
 */
function captureOf(read: (key: string) => unknown, lacked: string[]): TraceCapture | undefined {
  const name = read('iris.capture.name');
  const version = read('iris.capture.version');
  const listed = read('iris.capture.complete');
  const named = (Array.isArray(listed) ? listed : typeof listed === 'string' ? listed.split(',') : [])
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0);
  if (typeof name !== 'string' || name.trim().length === 0) {
    if (named.length > 0 || version !== undefined) lacked.push('iris.capture.name (a declaration says who makes it, so iris.capture.complete and iris.capture.version were ignored)');
    return undefined;
  }
  const isField = (v: string): v is CaptureField => (CAPTURE_FIELDS as readonly string[]).includes(v);
  const unknown = named.filter((v) => !isField(v));
  if (unknown.length > 0) lacked.push(`iris.capture.complete values from ${CAPTURE_FIELDS.join(', ')} (${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not one, and was ignored)`);
  return canonicalCapture({
    name: name.trim().slice(0, 200),
    ...(typeof version === 'string' && version.trim().length > 0 ? { version: version.trim().slice(0, 100) } : {}),
    complete: named.filter(isField),
  });
}

/**
 * Token usage over the LEAF carriers only. Microsoft's Agent
 * Framework puts the run's totals on `invoke_agent` beside `chat` children
 * that carry their own; summing every span counted each call twice. A
 * carrier whose descendant also carries is a total, not a call, and is
 * left out; a framework that reports usage only on the root makes the root
 * the leaf. An explicit whole-run aggregate (Pydantic AI's
 * `gen_ai.aggregated_usage.*`) is the answer when it is present.
 */
function usageOf(spans: readonly MappedSpan[], keys: readonly string[], aggregatedKeys: readonly string[]): number | undefined {
  for (const s of spans) { const v = firstNumber(s.attrs, aggregatedKeys); if (v !== undefined) return v; }
  const carriers = spans.filter((s) => firstNumber(s.attrs, keys) !== undefined);
  if (carriers.length === 0) return undefined;
  const parentOf = new Map(spans.map((s) => [s.span.span_id, s.parent] as const));
  const isAncestor = (ancestor: string, of: MappedSpan): boolean => {
    let p = of.parent;
    for (let hops = 0; p !== undefined && hops < 10_000; hops += 1) {
      if (p === ancestor) return true;
      p = parentOf.get(p);
    }
    return false;
  };
  const leaves = carriers.filter((c) => !carriers.some((other) => other !== c && isAncestor(c.span.span_id, other)));
  return leaves.reduce((total, s) => total + (firstNumber(s.attrs, keys) ?? 0), 0);
}

const OI_TOOL_SCHEMA = /^llm\.tools\.(\d+)\.tool\.json_schema$/;

/**
 * OpenInference's tool catalogue: one `llm.tools.N.tool.json_schema` per tool
 * offered to a model call (the LlamaIndex and OpenAI Agents SDK instrumentors
 * write it), each the
 * provider's own tool object — OpenAI's `{ type: 'function', function: {...} }`
 * or a flat `{ name, description, parameters }`. Returned as one JSON array
 * of flat tools, the shape `gen_ai.tool.definitions` carries.
 */
function openInferenceTools(spans: readonly MappedSpan[]): string | undefined {
  for (const s of spans) {
    const entries = Object.entries(s.attrs)
      .map(([key, value]) => [OI_TOOL_SCHEMA.exec(key), value] as const)
      .filter((e): e is readonly [RegExpExecArray, string] => e[0] !== null && typeof e[1] === 'string')
      .sort((a, b) => Number(a[0][1]) - Number(b[0][1]));
    if (entries.length === 0) continue;
    const tools: unknown[] = [];
    for (const [, value] of entries) {
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        const fn = parsed && typeof parsed === 'object' && parsed.function && typeof parsed.function === 'object' ? parsed.function : parsed;
        tools.push(fn);
      } catch {
        // one unreadable schema does not lose the others
      }
    }
    if (tools.length > 0) return JSON.stringify(tools);
  }
  return undefined;
}

function toolDefinitionsOf(spans: readonly MappedSpan[]): ToolDescriptor[] | undefined {
  const raw = firstString(spans, TOOL_DEFINITION_KEYS) ?? openInferenceTools(spans);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const tools = parsed.filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null && typeof (t as Record<string, unknown>).name === 'string');
    return tools.length > 0
      ? tools.map((t) => ({
          name: t.name as string,
          ...(typeof t.description === 'string' ? { description: t.description } : {}),
          ...(typeof t.inputSchema === 'object' && t.inputSchema !== null ? { inputSchema: t.inputSchema as Record<string, unknown> } : typeof t.parameters === 'object' && t.parameters !== null ? { inputSchema: t.parameters as Record<string, unknown> } : {}),
        }))
      : undefined;
  } catch {
    return undefined;
  }
}

function sumOf(spans: readonly MappedSpan[], keys: readonly string[]): number | undefined {
  let total = 0;
  let seen = false;
  for (const s of spans) {
    for (const k of keys) {
      const v = s.attrs[k];
      if (typeof v === 'number' && Number.isFinite(v)) {
        total += v;
        seen = true;
        break;
      }
    }
  }
  return seen ? total : undefined;
}

interface MappedSpan {
  span: Span;
  attrs: Record<string, unknown>;
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  startMs: number;
  parent: string | undefined;
}

export interface MappedTrace {
  trace: Trace;
  /** The OTLP trace id as it arrived (hex). */
  otelTraceId: string;
  /** What the payload did not carry, in the reader's words. */
  lacked: string[];
  /**
   * The sender asked for this trace to be scored: `iris.evaluate` true on the
   * resource or the root span. The per-trace twin of `evaluate: true` on
   * POST /api/v1/traces, for a sender that wants a verdict without the
   * server scoring its whole OTLP feed (`otel.evaluateOnIngest`).
   */
  evaluate: boolean;
  /** `iris.eval_type` as sent, unvalidated: the route checks it against the bundles. */
  evalType?: string;
}

export interface MappedPayload {
  traces: MappedTrace[];
  /** Spans without a trace id or a span id, dropped and counted — OTLP's partialSuccess. */
  rejectedSpans: number;
  rejections: string[];
}

export interface FromOtlpOptions {
  /** Injectable for tests; the server mints one id per trace, as every other door does. */
  mintTraceId?: () => string;
  /**
   * Likewise per span: OTLP span ids are unique within a trace, not across
   * them, and Iris keys spans by id — so each span gets an Iris id, the
   * parent links are rewritten to match, and the OTLP id is kept as the
   * `otel.span_id` attribute.
   */
  mintSpanId?: () => string;
  now?: () => string;
}

/** Every trace in one ExportTraceServiceRequest, grouped by OTLP trace id. */
export function fromOtlp(request: OtlpTraceRequest, options: FromOtlpOptions = {}): MappedPayload {
  const mint = options.mintTraceId ?? generateTraceId;
  const mintSpan = options.mintSpanId ?? generateSpanId;
  const now = options.now ?? (() => new Date().toISOString());
  const groups = new Map<string, { resource: Record<string, unknown>; scope: string | undefined; spans: MappedSpan[] }>();
  let rejectedSpans = 0;
  const rejections: string[] = [];

  for (const rs of request.resourceSpans) {
    const resource = attributesToRecord(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      for (const raw of ss.spans ?? []) {
        const parsed = otlpSpan.safeParse(raw);
        if (!parsed.success) {
          rejectedSpans += 1;
          if (rejections.length < 5) rejections.push(parsed.error.issues.map((i) => `${i.path.join('.') || 'span'}: ${i.message}`).join('; '));
          continue;
        }
        const s = parsed.data;
        const attrs = attributesToRecord(s.attributes);
        const start = nanosToIso(s.startTimeUnixNano);
        const end = nanosToIso(s.endTimeUnixNano);
        const group = groups.get(s.traceId) ?? { resource, scope: ss.scope?.name, spans: [] };
        const span: Span = {
          span_id: s.spanId,
          trace_id: s.traceId,
          ...(s.parentSpanId ? { parent_span_id: s.parentSpanId } : {}),
          name: s.name && s.name.length > 0 ? s.name : 'span',
          kind: spanKindOf(attrs, s.kind),
          status_code: statusOf(s.status?.code),
          ...(s.status?.message ? { status_message: s.status.message } : {}),
          start_time: start ?? now(),
          ...(end ? { end_time: end } : {}),
          ...(Object.keys(attrs).length > 0 ? { attributes: attrs } : {}),
          ...(s.events && s.events.length > 0
            ? {
                events: s.events.map((e) => ({
                  name: e.name ?? 'event',
                  timestamp: nanosToIso(e.timeUnixNano) ?? start ?? now(),
                  ...(e.attributes && e.attributes.length > 0 ? { attributes: attributesToRecord(e.attributes) } : {}),
                })),
              }
            : {}),
        };
        group.spans.push({
          span,
          attrs,
          events: (s.events ?? []).map((e) => ({ name: e.name ?? 'event', attrs: attributesToRecord(e.attributes) })),
          startMs: start ? Date.parse(start) : Number.POSITIVE_INFINITY,
          parent: s.parentSpanId,
        });
        groups.set(s.traceId, group);
      }
    }
  }

  const traces: MappedTrace[] = [];
  for (const [otelTraceId, group] of groups) {
    const ordered = [...group.spans].sort((a, b) => a.startMs - b.startMs || a.span.span_id.localeCompare(b.span.span_id));
    const ids = new Set(ordered.map((m) => m.span.span_id));
    const root = ordered.find((m) => m.parent === undefined || !ids.has(m.parent)) ?? ordered[0];
    const rootFirst = [root, ...ordered.filter((m) => m !== root)];
    const lacked: string[] = [];

    const serviceName = group.resource['service.name'];
    const declaredAgent = group.resource['iris.agent_name'] ?? root.attrs['iris.agent_name'];
    // gen_ai.agent.name (ADK, Agent Framework, AutoGen, Pydantic AI set it on invoke_agent), or OpenInference's agent.name, before the "otel" default.
    const conventionAgent = firstString(rootFirst, AGENT_NAME_KEYS);
    const agentName =
      typeof serviceName === 'string' && serviceName.length > 0 && !isDefaultServiceName(serviceName) ? serviceName
      : typeof declaredAgent === 'string' && declaredAgent.length > 0 ? declaredAgent
      : conventionAgent ?? 'otel';
    if (agentName === 'otel') lacked.push('service.name (agent_name defaulted to "otel"; set service.name on the resource, iris.agent_name, or gen_ai.agent.name)');

    const input = firstText(rootFirst, 'input', 'gen_ai.content.prompt', 'gen_ai.prompt', 'gen_ai.prompt');
    const output = firstText(rootFirst, 'output', 'gen_ai.content.completion', 'gen_ai.completion', 'gen_ai.completion');
    if (input === undefined) lacked.push('input (no iris.input, gen_ai.input.messages, gen_ai.prompt, input.value, llm.input_messages, traceloop.entity.input or ai.prompt on any span or event; a Python repr is not read as one)');
    if (output === undefined) lacked.push('output (no iris.output, gen_ai.output.messages, gen_ai.completion, output.value, llm.output_messages, traceloop.entity.output or ai.response.text on any span or event; a Python repr is not read as one — the rules that read the output will not run)');

    const inputTokens = usageOf(ordered, INPUT_TOKEN_KEYS, AGGREGATED_INPUT_KEYS);
    const outputTokens = usageOf(ordered, OUTPUT_TOKEN_KEYS, AGGREGATED_OUTPUT_KEYS);
    const declaredTotal = usageOf(ordered, TOTAL_TOKEN_KEYS, []);
    // The cached part of the input, counted at the leaves like the rest: priced at the cache price (src/cost/trace-cost.ts).
    const cacheRead = usageOf(ordered, CACHE_READ_KEYS, []);
    const cacheWrite = usageOf(ordered, CACHE_WRITE_KEYS, []);
    const cacheWrite1h = usageOf(ordered, CACHE_WRITE_1H_KEYS, []);
    const model = firstString(rootFirst, MODEL_KEYS);
    const conversationId = (typeof group.resource['gen_ai.conversation.id'] === 'string' ? (group.resource['gen_ai.conversation.id'] as string) : undefined) ?? firstString(rootFirst, CONVERSATION_KEYS);
    const tools = toolDefinitionsOf(rootFirst);
    const tokenUsage =
      inputTokens !== undefined || outputTokens !== undefined || declaredTotal !== undefined
        ? {
            prompt_tokens: inputTokens ?? 0,
            completion_tokens: outputTokens ?? 0,
            total_tokens: declaredTotal ?? (inputTokens ?? 0) + (outputTokens ?? 0),
            // Only a count that changes the price: a wrapper reports cached_tokens: 0 on every uncached call.
            ...(cacheRead !== undefined && cacheRead > 0 ? { cache_read_tokens: cacheRead } : {}),
            ...(cacheWrite !== undefined && cacheWrite > 0 ? { cache_creation_tokens: cacheWrite } : {}),
            // The split is kept whenever there are writes, zero included: a 0 says every write was a 5-minute one.
            ...(cacheWrite1h !== undefined && cacheWrite !== undefined && cacheWrite > 0 ? { cache_creation_1h_tokens: cacheWrite1h } : {}),
          }
        : undefined;
    const cost = sumOf(ordered, COST_KEYS);

    const timestamp = Number.isFinite(root.startMs) ? new Date(root.startMs).toISOString() : now();
    if (!Number.isFinite(root.startMs)) lacked.push('startTimeUnixNano on the root span (timestamp is the arrival time)');
    const endIso = root.span.end_time;
    const latency = endIso && Number.isFinite(root.startMs) ? Date.parse(endIso) - root.startMs : undefined;

    const runId = group.resource['iris.run'] ?? root.attrs['iris.run'];
    const caseKey = group.resource['iris.case_key'] ?? root.attrs['iris.case_key'];
    const framework = group.resource['iris.framework'] ?? root.attrs['iris.framework'];
    const evaluateFlag = group.resource['iris.evaluate'] ?? root.attrs['iris.evaluate'];
    const evalType = group.resource['iris.eval_type'] ?? root.attrs['iris.eval_type'];
    const capture = captureOf((key) => group.resource[key] ?? root.attrs[key], lacked);

    const irisTraceId = mint();
    const spanIds = new Map<string, string>();
    for (const m of ordered) spanIds.set(m.span.span_id, mintSpan());
    const spans: Span[] = ordered.map((m) => {
      const parent = m.parent !== undefined ? spanIds.get(m.parent) : undefined;
      const rest: Span = { ...m.span };
      delete rest.parent_span_id;
      return {
        ...rest,
        span_id: spanIds.get(m.span.span_id) as string,
        trace_id: irisTraceId,
        ...(parent !== undefined ? { parent_span_id: parent } : {}),
        attributes: { ...(m.span.attributes ?? {}), 'otel.span_id': m.span.span_id, ...(m.parent !== undefined && parent === undefined ? { 'otel.parent_span_id': m.parent } : {}) },
      };
    });
    const trace: Trace = {
      trace_id: irisTraceId,
      agent_name: agentName,
      ...(typeof framework === 'string' && framework.length > 0 ? { framework } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(latency !== undefined && latency >= 0 ? { latency_ms: latency } : {}),
      ...(tokenUsage ? { token_usage: tokenUsage } : {}),
      ...(cost !== undefined ? { cost_usd: cost } : {}),
      ...(tools ? { tools } : {}),
      // gen_ai.conversation.id is the session: the column the drawer and the filters read.
      ...(conversationId !== undefined ? { session_id: conversationId } : {}),
      metadata: {
        // What the judge's same-family check reads — beside the OTel block, never inside it.
        ...(model !== undefined ? { model } : {}),
        otel: { trace_id: otelTraceId, ...(group.scope ? { scope: group.scope } : {}), resource: group.resource },
      },
      timestamp,
      spans,
      ...(typeof runId === 'string' && runId.length > 0 ? { run_id: runId } : {}),
      ...(typeof caseKey === 'string' && caseKey.length > 0 ? { case_key: caseKey } : {}),
      source: 'otel',
      ...(capture !== undefined ? { capture } : {}),
    };
    traces.push({
      // Priced here, so the route stores and scores the trace with its cost settled (src/cost/trace-cost.ts).
      trace: resolveTraceCost(trace),
      otelTraceId,
      lacked,
      // A boolean true, or the string "true" from an exporter that only writes strings.
      evaluate: evaluateFlag === true || evaluateFlag === 'true',
      ...(typeof evalType === 'string' && evalType.length > 0 ? { evalType } : {}),
    });
  }

  return { traces, rejectedSpans, rejections };
}
