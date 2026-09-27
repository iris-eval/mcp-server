/*
 * IrisCallbackHandler — every LangChain.js and LangGraph.js run, recorded and scored.
 *
 *   import { IrisCallbackHandler } from '@iris-eval/langchain';
 *   const iris = new IrisCallbackHandler({ agentName: 'support-bot' });
 *   await graph.invoke({ messages: [new HumanMessage('Weather in Paris?')] }, { callbacks: [iris] });
 *
 * One top-level run (a graph, a chain, an agent, or a model called on its
 * own) becomes one trace: the run is the root span and every step inside it
 * — each model call, tool call, chain or graph node and retriever — is a
 * child span, in the OpenTelemetry GenAI conventions (`invoke_agent`, `chat`,
 * `execute_tool`). The trace goes to the recorder when the top-level run
 * ends, so Iris stores it with the run's input, output, tool calls, token
 * usage and latency, and returns a verdict. The recorder is the one
 * `@iris-eval/sdk` uses for the provider wrappers; the Python client's
 * `iris_eval.langchain.IrisCallbackHandler` builds the same trace.
 */
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import type { ChainValues } from '@langchain/core/utils/types';
import type { DocumentInterface } from '@langchain/core/documents';
import { MAX_PART_CHARS, defaultRecorder, newSpanId, newTraceId, nowNanos, programName, resourceFor } from '@iris-eval/sdk';
import type { Attributes, EvalType, IrisRecorder, SpanRecord } from '@iris-eval/sdk';

export interface IrisCallbackHandlerOptions {
  /** Where the trace goes. Default: the process-wide recorder of `@iris-eval/sdk`, configured from `IRIS_URL` / `IRIS_API_KEY`. */
  recorder?: IrisRecorder;
  /** The agent (`service.name`). Default: the running program's name. */
  agentName?: string;
  /** The conversation (`gen_ai.conversation.id`). Default: a LangGraph `thread_id`, when the run has one. */
  sessionId?: string;
  /** The batch this run belongs to (`iris.run`). */
  run?: string;
  /** Ask Iris for a verdict on each run. Default: the recorder's setting (true). */
  evaluate?: boolean;
  /** The bundle to run. Default: every bundle. */
  evalType?: EvalType;
}

type Part = Record<string, unknown> & { type: string };
type Msg = { role: string; parts: Part[]; finish_reason?: string };

const ROLES: Record<string, string> = { human: 'user', user: 'user', ai: 'assistant', assistant: 'assistant', system: 'system', developer: 'system', tool: 'tool', function: 'tool' };
const FINISH: Record<string, string> = { tool_calls: 'tool_call', tool_use: 'tool_call', end_turn: 'stop', max_tokens: 'length' };

const clip = (text: string): string => (text.length <= MAX_PART_CHARS ? text : `${text.slice(0, MAX_PART_CHARS)}… [${text.length - MAX_PART_CHARS} more characters not recorded]`);
const json = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

function partsOf(content: unknown): Part[] {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', content: clip(content) }] : [];
  if (!Array.isArray(content)) return [];
  const parts: Part[] = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push({ type: 'text', content: clip(block) });
    else if (block?.type === 'text' && typeof block.text === 'string') parts.push({ type: 'text', content: clip(block.text) });
    else if ((block?.type === 'thinking' || block?.type === 'reasoning') && typeof (block.thinking ?? block.reasoning ?? block.text) === 'string') parts.push({ type: 'reasoning', content: clip(block.thinking ?? block.reasoning ?? block.text) });
    else if (block?.type === 'tool_use' || block?.type === 'tool_call') continue; // carried by the message's tool_calls
    else parts.push({ type: typeof block?.type === 'string' && block.type ? block.type : 'unknown' });
  }
  return parts;
}

function typeOf(m: any): string | undefined {
  if (typeof m?.getType === 'function') return m.getType();
  if (typeof m?._getType === 'function') return m._getType();
  return typeof m?.role === 'string' ? m.role : typeof m?.type === 'string' ? m.type : undefined;
}

/** A LangChain message (instance, `{ role, content }`, or `[role, content]`) in the conventions' schema. */
function messageOf(m: any): Msg | undefined {
  if (Array.isArray(m) && m.length === 2) return { role: ROLES[String(m[0])] ?? String(m[0]), parts: partsOf(m[1]) };
  if (typeof m === 'string') return { role: 'user', parts: partsOf(m) };
  const kind = typeOf(m);
  if (kind === undefined && m?.content === undefined) return undefined;
  const role = ROLES[String(kind)] ?? String(kind);
  if (role === 'tool') {
    const content = m.content;
    const response = typeof content === 'string' ? clip(content) : partsOf(content).map((p) => p.content).filter(Boolean).join('\n') || content;
    return { role: 'tool', parts: [{ type: 'tool_call_response', ...(m.tool_call_id ? { id: m.tool_call_id } : {}), response }] };
  }
  const parts = partsOf(m.content);
  for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
    parts.push({ type: 'tool_call', ...(call.id ? { id: call.id } : {}), name: String(call.name ?? ''), arguments: call.args ?? {} });
  }
  return { role, parts };
}

const messagesOf = (list: unknown): Msg[] => (Array.isArray(list) ? list.map(messageOf).filter((m): m is Msg => m !== undefined) : []);
const words = (m: Msg): string => m.parts.filter((p) => p.type === 'text').map((p) => p.content as string).join('\n');
function lastWords(messages: Msg[], role: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === role && words(messages[i])) return words(messages[i]);
  }
  return undefined;
}

/** What a run was asked, in words: the last user message, an `input` / `question` / `query` field, or the value itself. */
function runInput(inputs: unknown): string | undefined {
  if (typeof inputs === 'string') return clip(inputs);
  if (Array.isArray(inputs)) return lastWords(messagesOf(inputs), 'user');
  if (inputs && typeof inputs === 'object') {
    const o = inputs as Record<string, unknown>;
    if ('messages' in o) return lastWords(messagesOf(o.messages), 'user');
    for (const key of ['input', 'question', 'query', 'prompt']) if (typeof o[key] === 'string') return clip(o[key] as string);
    return Object.keys(o).length > 0 ? clip(json(o)) : undefined;
  }
  return inputs === undefined || inputs === null ? undefined : clip(json(inputs));
}

/** What a run answered, in words: the last assistant message, an `output` / `answer` field, or the value itself. */
function runOutput(outputs: unknown): string | undefined {
  if (typeof outputs === 'string') return clip(outputs);
  if (outputs && typeof outputs === 'object') {
    const o = outputs as Record<string, unknown>;
    if (typeOf(o) !== undefined && 'content' in o) {
      const m = messageOf(o);
      return m ? words(m) || undefined : undefined;
    }
    if ('messages' in o) return lastWords(messagesOf(o.messages), 'assistant');
    for (const key of ['output', 'answer', 'result', 'text']) if (typeof o[key] === 'string') return clip(o[key] as string);
    return Object.keys(o).length > 0 ? clip(json(o)) : undefined;
  }
  return outputs === undefined || outputs === null ? undefined : clip(json(outputs));
}

interface Run {
  spanId: string;
  root: string;
  parent?: string;
  name: string;
  kind: 'chain' | 'llm' | 'tool' | 'retriever';
  start: bigint;
  end?: bigint;
  attributes: Attributes;
  error?: string;
  input?: string;
  output?: string;
}

const intAttr = (a: Attributes, key: string, v: unknown) => {
  if (typeof v === 'number' && Number.isInteger(v)) a[key] = v;
};

/** Sends each top-level LangChain / LangGraph run to Iris as one trace, and asks for its verdict. */
export class IrisCallbackHandler extends BaseCallbackHandler {
  name = 'iris-eval';
  readonly options: IrisCallbackHandlerOptions;
  private readonly runs = new Map<string, Run>();
  private readonly traces = new Map<string, string>();
  private readonly threads = new Map<string, string>();

  constructor(options: IrisCallbackHandlerOptions = {}) {
    super();
    // Every method returns at once (the recorder sends in the background), so awaiting them costs nothing and
    // keeps the run's events in order; and nothing the handler does can fail the run.
    this.awaitHandlers = true;
    this.raiseError = false;
    this.options = options;
  }

  private get recorder(): IrisRecorder {
    return this.options.recorder ?? defaultRecorder();
  }

  /* ---------- bookkeeping ---------- */

  private start(runId: string, parentRunId: string | undefined, name: string, kind: Run['kind'], attributes: Attributes, metadata?: Record<string, unknown>): Run {
    const parent = parentRunId !== undefined ? this.runs.get(parentRunId) : undefined;
    const root = parent ? parent.root : runId;
    if (!parent) {
      this.traces.set(runId, newTraceId());
      const thread = metadata?.thread_id;
      if ((typeof thread === 'string' || typeof thread === 'number') && String(thread)) this.threads.set(runId, String(thread));
    }
    const run: Run = { spanId: newSpanId(), root, ...(parent ? { parent: parentRunId } : {}), name, kind, start: nowNanos(), attributes };
    this.runs.set(runId, run);
    return run;
  }

  private end(runId: string, error?: unknown): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.end = nowNanos();
    if (error !== undefined) {
      const e = error instanceof Error ? error : new Error(String(error));
      run.error = `${e.name}: ${e.message}`;
      run.attributes['error.type'] = e.name;
    }
    if (run.root !== runId) return;
    const members = [...this.runs.entries()].filter(([, r]) => r.root === runId);
    for (const [id] of members) this.runs.delete(id);
    const traceId = this.traces.get(runId) as string;
    this.traces.delete(runId);
    const thread = this.threads.get(runId);
    this.threads.delete(runId);
    try {
      this.emit(runId, traceId, new Map(members), thread);
    } catch {
      // Recording never fails the run it records.
    }
  }

  private emit(rootId: string, traceId: string, members: Map<string, Run>, thread?: string): void {
    const root = members.get(rootId) as Run;
    const agent = this.options.agentName ?? programName();
    const end = root.end ?? nowNanos();
    const spans: SpanRecord[] = [];
    for (const [id, run] of members) {
      const attributes: Attributes = { ...run.attributes };
      if (id === rootId) {
        if (run.kind === 'chain') {
          attributes['gen_ai.operation.name'] = 'invoke_agent';
          attributes['gen_ai.agent.name'] = agent;
        }
        if (run.input !== undefined) attributes['iris.input'] = run.input;
        if (run.output !== undefined) attributes['iris.output'] = run.output;
        const session = this.options.sessionId ?? thread;
        if (session) attributes['gen_ai.conversation.id'] = session;
      }
      const parent = run.parent !== undefined ? members.get(run.parent) : undefined;
      spans.push({
        traceId,
        spanId: run.spanId,
        ...(parent ? { parentSpanId: parent.spanId } : {}),
        name: id === rootId && run.kind === 'chain' ? `invoke_agent ${agent}` : run.name,
        kind: run.kind === 'llm' ? 3 : 1,
        startTimeUnixNano: run.start,
        endTimeUnixNano: run.end ?? end,
        attributes,
        ...(run.error ? { status: { code: 'error' as const, message: run.error } } : run.end ? { status: { code: 'ok' as const } } : {}),
      });
    }
    const recorder = this.recorder;
    const graph = [...members.values()].some((r) => r.attributes['langgraph.node'] !== undefined);
    // A run that raised has no answer to judge: it is stored with its error and not scored.
    const resource = resourceFor(recorder, { agentName: agent, run: this.options.run, evaluate: root.error ? false : this.options.evaluate, evalType: this.options.evalType });
    resource['iris.framework'] = graph ? 'langgraph' : 'langchain';
    recorder.record({ resource, spans });
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch {
      // Recording never fails the run it records.
    }
  }

  /* ---------- chains and graphs ---------- */

  override async handleChainStart(chain: Serialized, inputs: ChainValues, runId: string, parentRunId?: string, _tags?: string[], metadata?: Record<string, unknown>, _runType?: string, runName?: string): Promise<void> {
    this.guard(() => {
      const name = runName ?? (chain as any)?.name ?? (Array.isArray((chain as any)?.id) ? (chain as any).id.at(-1) : undefined) ?? 'chain';
      const attributes: Attributes = { 'langchain.run_type': 'chain' };
      if (typeof metadata?.langgraph_node === 'string') attributes['langgraph.node'] = metadata.langgraph_node;
      const run = this.start(runId, parentRunId, String(name), 'chain', attributes, metadata);
      if (run.root === runId) run.input = runInput(inputs);
    });
  }

  override async handleChainEnd(outputs: ChainValues, runId: string): Promise<void> {
    this.guard(() => {
      const run = this.runs.get(runId);
      if (run && run.root === runId) run.output = runOutput(outputs);
      this.end(runId);
    });
  }

  override async handleChainError(err: Error, runId: string): Promise<void> {
    this.guard(() => this.end(runId, err));
  }

  /* ---------- models ---------- */

  private modelAttributes(extraParams?: Record<string, unknown>, metadata?: Record<string, unknown>): { name: string; attributes: Attributes } {
    const params = (extraParams?.invocation_params ?? {}) as Record<string, any>;
    const model = metadata?.ls_model_name ?? params.model ?? params.model_name ?? params.modelName;
    const attributes: Attributes = { 'gen_ai.operation.name': 'chat', 'langchain.run_type': 'llm' };
    if (typeof metadata?.ls_provider === 'string') attributes['gen_ai.provider.name'] = metadata.ls_provider;
    if (typeof model === 'string' && model) attributes['gen_ai.request.model'] = model;
    if (typeof metadata?.ls_temperature === 'number') attributes['gen_ai.request.temperature'] = metadata.ls_temperature;
    if (typeof metadata?.ls_max_tokens === 'number') attributes['gen_ai.request.max_tokens'] = metadata.ls_max_tokens;
    const tools = Array.isArray(params.tools) ? params.tools : [];
    const defs = tools
      .map((t: any) => (t?.function && typeof t.function === 'object' ? t.function : t))
      .filter((f: any) => f && typeof f.name === 'string')
      .map((f: any) => ({ type: 'function', name: f.name, ...(f.description ? { description: f.description } : {}), ...(f.parameters ?? f.input_schema ? { parameters: f.parameters ?? f.input_schema } : {}) }));
    if (defs.length > 0) attributes['gen_ai.tool.definitions'] = json(defs);
    return { name: typeof model === 'string' && model ? `chat ${model}` : 'chat', attributes };
  }

  override async handleChatModelStart(_llm: Serialized, messages: BaseMessage[][], runId: string, parentRunId?: string, extraParams?: Record<string, unknown>, _tags?: string[], metadata?: Record<string, unknown>): Promise<void> {
    this.guard(() => {
      const { name, attributes } = this.modelAttributes(extraParams, metadata);
      const conversation = messagesOf(messages?.[0]);
      const system = conversation.filter((m) => m.role === 'system').flatMap((m) => m.parts);
      const rest = conversation.filter((m) => m.role !== 'system');
      if (rest.length > 0) attributes['gen_ai.input.messages'] = json(rest);
      if (system.length > 0) attributes['gen_ai.system_instructions'] = json(system);
      const run = this.start(runId, parentRunId, name, 'llm', attributes, metadata);
      if (run.root === runId) run.input = lastWords(conversation, 'user');
    });
  }

  override async handleLLMStart(_llm: Serialized, prompts: string[], runId: string, parentRunId?: string, extraParams?: Record<string, unknown>, _tags?: string[], metadata?: Record<string, unknown>): Promise<void> {
    this.guard(() => {
      const { name, attributes } = this.modelAttributes(extraParams, metadata);
      if (prompts.length > 0) attributes['gen_ai.input.messages'] = json(prompts.map((p) => ({ role: 'user', parts: [{ type: 'text', content: clip(p) }] })));
      const run = this.start(runId, parentRunId, name, 'llm', attributes, metadata);
      if (run.root === runId && prompts.length > 0) run.input = clip(prompts[prompts.length - 1]);
    });
  }

  override async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    this.guard(() => {
      const run = this.runs.get(runId);
      if (run) this.readResult(run, output);
      this.end(runId);
    });
  }

  private readResult(run: Run, output: LLMResult): void {
    const first = output?.generations?.[0]?.[0] as any;
    const message = first?.message;
    const meta = (message?.response_metadata ?? {}) as Record<string, any>;
    const info = (first?.generationInfo ?? {}) as Record<string, any>;
    const finish = meta.finish_reason ?? meta.stop_reason ?? info.finish_reason;
    const out = message ? messageOf(message) : first ? { role: 'assistant', parts: partsOf(first.text ?? '') } : undefined;
    if (out) {
      if (typeof finish === 'string') out.finish_reason = FINISH[finish] ?? finish;
      run.attributes['gen_ai.output.messages'] = json([out]);
      const text = words(out);
      const calls = out.parts.filter((p) => p.type === 'tool_call');
      run.output = text || (calls.length > 0 ? json(calls.map((c) => ({ tool: c.name, arguments: c.arguments ?? {} }))) : undefined);
    }
    if (typeof finish === 'string') run.attributes['gen_ai.response.finish_reasons'] = [finish];
    const model = meta.model_name ?? meta.model;
    if (typeof model === 'string' && model) run.attributes['gen_ai.response.model'] = model;
    const usage = message?.usage_metadata;
    if (usage && typeof usage === 'object') {
      intAttr(run.attributes, 'gen_ai.usage.input_tokens', usage.input_tokens);
      intAttr(run.attributes, 'gen_ai.usage.output_tokens', usage.output_tokens);
      intAttr(run.attributes, 'gen_ai.usage.cache_read.input_tokens', usage.input_token_details?.cache_read);
      intAttr(run.attributes, 'gen_ai.usage.cache_creation.input_tokens', usage.input_token_details?.cache_creation);
      intAttr(run.attributes, 'gen_ai.usage.reasoning.output_tokens', usage.output_token_details?.reasoning);
    } else {
      const tokens = (output?.llmOutput?.tokenUsage ?? output?.llmOutput?.token_usage ?? {}) as Record<string, unknown>;
      intAttr(run.attributes, 'gen_ai.usage.input_tokens', tokens.promptTokens ?? tokens.prompt_tokens);
      intAttr(run.attributes, 'gen_ai.usage.output_tokens', tokens.completionTokens ?? tokens.completion_tokens);
    }
  }

  override async handleLLMError(err: Error, runId: string): Promise<void> {
    this.guard(() => this.end(runId, err));
  }

  /* ---------- tools ---------- */

  override async handleToolStart(tool: Serialized, input: string, runId: string, parentRunId?: string, _tags?: string[], metadata?: Record<string, unknown>, runName?: string, toolCallId?: string): Promise<void> {
    this.guard(() => {
      const name = runName ?? (tool as any)?.name ?? (Array.isArray((tool as any)?.id) ? (tool as any).id.at(-1) : undefined) ?? 'tool';
      const attributes: Attributes = { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': String(name), 'langchain.run_type': 'tool' };
      if (toolCallId) attributes['gen_ai.tool.call.id'] = toolCallId;
      attributes['gen_ai.tool.call.arguments'] = typeof input === 'string' ? input : json(input);
      this.start(runId, parentRunId, `execute_tool ${name}`, 'tool', attributes, metadata);
    });
  }

  override async handleToolEnd(output: unknown, runId: string): Promise<void> {
    this.guard(() => {
      const run = this.runs.get(runId);
      if (run) {
        const content = output && typeof output === 'object' && 'content' in output ? (output as { content: unknown }).content : output;
        const result = typeof content === 'string' ? content : partsOf(content).map((p) => p.content).filter(Boolean).join('\n') || json(content);
        run.attributes['gen_ai.tool.call.result'] = clip(result);
        if (run.root === runId) run.output = clip(result);
      }
      this.end(runId);
    });
  }

  override async handleToolError(err: Error, runId: string): Promise<void> {
    this.guard(() => {
      const run = this.runs.get(runId);
      if (run) run.attributes['gen_ai.tool.call.result'] = clip(`${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`);
      this.end(runId, err);
    });
  }

  /* ---------- retrievers ---------- */

  override async handleRetrieverStart(retriever: Serialized, query: string, runId: string, parentRunId?: string, _tags?: string[], metadata?: Record<string, unknown>, name?: string): Promise<void> {
    this.guard(() => {
      const label = name ?? (retriever as any)?.name ?? 'retriever';
      const run = this.start(runId, parentRunId, `retrieve ${label}`, 'retriever', { 'langchain.run_type': 'retriever', 'retriever.query': clip(query) }, metadata);
      if (run.root === runId) run.input = clip(query);
    });
  }

  override async handleRetrieverEnd(documents: DocumentInterface[], runId: string): Promise<void> {
    this.guard(() => {
      const run = this.runs.get(runId);
      if (run) run.attributes['retriever.documents'] = documents.length;
      this.end(runId);
    });
  }

  override async handleRetrieverError(err: Error, runId: string): Promise<void> {
    this.guard(() => this.end(runId, err));
  }
}
