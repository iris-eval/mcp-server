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
 *   agent_name   resource `service.name`, else `iris.agent_name` (resource
 *                or root span), else "otel" — and the answer says it lacked
 *                service.name
 *   input        the first of `iris.input`, `gen_ai.input.messages`,
 *                `gen_ai.prompt` on the root span, then any span in start
 *                order, then a `gen_ai.content.prompt` event
 *   output       the same for `iris.output`, `gen_ai.output.messages`,
 *                `gen_ai.completion`, `gen_ai.content.completion`
 *   tokens       `gen_ai.usage.input_tokens` / `output_tokens` (and the
 *                older `prompt_tokens` / `completion_tokens`, and Iris's
 *                own `iris.*_tokens`), summed over spans
 *   cost         `iris.cost_usd`, `gen_ai.usage.cost`, `llm.usage.total_cost`,
 *                summed
 *   run / case   `iris.run`, `iris.case_key` on the resource or the root
 *   spans        every span: kind from `iris.span_kind`, else TOOL when it
 *                carries a tool attribute or `gen_ai.operation.name` is
 *                execute_tool, else LLM when it carries a GenAI request
 *                attribute, else the OTel kind; status from status.code
 *
 * A trace with no GenAI attributes at all is still stored — with what it
 * carries — and the answer lists what it lacked, so the reader knows why
 * the rules that need an output did not run. The OTLP trace id is kept in
 * metadata; Iris mints its own id, as every other door does.
 */
import { z } from 'zod';
import type { Span, SpanKind, SpanStatus, Trace, ToolDescriptor } from '../types/trace.js';
import { generateTraceId, generateSpanId } from '../utils/ids.js';

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
  if ('bytesValue' in o) return o.bytesValue;
  if ('arrayValue' in o) return (((o.arrayValue as { values?: unknown[] } | undefined)?.values) ?? []).map(fromAnyValue);
  if ('kvlistValue' in o) return attributesToRecord((o.kvlistValue as { values?: Array<{ key: string; value?: unknown }> } | undefined)?.values);
  return undefined;
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
const INPUT_TOKEN_KEYS = ['gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'iris.prompt_tokens', 'llm.token_count.prompt', 'gen_ai.response.prompt_tokens', 'ai.usage.promptTokens'];
const OUTPUT_TOKEN_KEYS = ['gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'iris.completion_tokens', 'llm.token_count.completion', 'gen_ai.response.completion_tokens', 'ai.usage.completionTokens'];
const TOTAL_TOKEN_KEYS = ['gen_ai.usage.total_tokens', 'iris.total_tokens', 'llm.token_count.total'];
/** A framework's own whole-run total (Pydantic AI) — when present it is the answer, not one more addend. */
const AGGREGATED_INPUT_KEYS = ['gen_ai.aggregated_usage.input_tokens'];
const AGGREGATED_OUTPUT_KEYS = ['gen_ai.aggregated_usage.output_tokens'];
const COST_KEYS = ['iris.cost_usd', 'gen_ai.usage.cost', 'llm.usage.total_cost'];
const AGENT_NAME_KEYS = ['gen_ai.agent.name'];
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

function firstText(spans: readonly MappedSpan[], keys: readonly string[], eventName: string, eventKey: string, indexedPrefix?: string): string | undefined {
  for (const s of spans) for (const k of keys) if (s.attrs[k] !== undefined) return asText(s.attrs[k]);
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

function toolDefinitionsOf(spans: readonly MappedSpan[]): ToolDescriptor[] | undefined {
  const raw = firstString(spans, TOOL_DEFINITION_KEYS);
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
    // gen_ai.agent.name (ADK, Agent Framework, AutoGen, Pydantic AI set it on invoke_agent) before the "otel" default.
    const conventionAgent = firstString(rootFirst, AGENT_NAME_KEYS);
    const agentName =
      typeof serviceName === 'string' && serviceName.length > 0 ? serviceName
      : typeof declaredAgent === 'string' && declaredAgent.length > 0 ? declaredAgent
      : conventionAgent ?? 'otel';
    if (agentName === 'otel') lacked.push('service.name (agent_name defaulted to "otel"; set service.name on the resource, iris.agent_name, or gen_ai.agent.name)');

    const input = firstText(rootFirst, INPUT_KEYS, 'gen_ai.content.prompt', 'gen_ai.prompt', 'gen_ai.prompt');
    const output = firstText(rootFirst, OUTPUT_KEYS, 'gen_ai.content.completion', 'gen_ai.completion', 'gen_ai.completion');
    if (input === undefined) lacked.push('input (no iris.input, gen_ai.input.messages, gen_ai.prompt, input.value, traceloop.entity.input or ai.prompt on any span or event)');
    if (output === undefined) lacked.push('output (no iris.output, gen_ai.output.messages, gen_ai.completion, output.value, traceloop.entity.output or ai.response.text on any span or event — the rules that read the output will not run)');

    const inputTokens = usageOf(ordered, INPUT_TOKEN_KEYS, AGGREGATED_INPUT_KEYS);
    const outputTokens = usageOf(ordered, OUTPUT_TOKEN_KEYS, AGGREGATED_OUTPUT_KEYS);
    const declaredTotal = usageOf(ordered, TOTAL_TOKEN_KEYS, []);
    const model = firstString(rootFirst, MODEL_KEYS);
    const conversationId = (typeof group.resource['gen_ai.conversation.id'] === 'string' ? (group.resource['gen_ai.conversation.id'] as string) : undefined) ?? firstString(rootFirst, CONVERSATION_KEYS);
    const tools = toolDefinitionsOf(rootFirst);
    const tokenUsage =
      inputTokens !== undefined || outputTokens !== undefined || declaredTotal !== undefined
        ? {
            prompt_tokens: inputTokens ?? 0,
            completion_tokens: outputTokens ?? 0,
            total_tokens: declaredTotal ?? (inputTokens ?? 0) + (outputTokens ?? 0),
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
    };
    traces.push({ trace, otelTraceId, lacked });
  }

  return { traces, rejectedSpans, rejections };
}
