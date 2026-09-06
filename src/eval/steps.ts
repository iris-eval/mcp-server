/*
 * The step layer — one reading of "what the agent did", whatever shape it
 * arrived in.
 *
 * The same execution reaches Iris three ways: as `tool_calls[]` on the
 * capture path, as OpenTelemetry spans with `kind: 'TOOL'`, and (arc 7) as
 * an OTLP receiver's translation of the same. Until now only the first was
 * evaluated. Spans are stored, indexed, timed, status-coded and exported,
 * and no rule has ever read one — so a trace captured by an OTel
 * instrumentation got every trajectory rule SKIPPED. That reads as "not
 * judged", which is honest, but the data was there the whole time.
 *
 * `Step` is that one reading. Nothing here changes a verdict: the module
 * lands before any rule uses it, and the two shipped trajectory rules keep
 * reading `context.toolCalls` until the migration that follows proves
 * itself by regenerating the proof numbers byte for byte.
 *
 * WHY THIS IS NOT IN trajectory.ts. That module is pinned byte for byte
 * into the website's vendored rule library (tests/playground-parity.test.ts)
 * and span derivation is server-only — the playground has no spans and
 * never will. Pinning it would vendor this code into a browser bundle for a
 * path that cannot be taken.
 *
 * WHY RULES CALL stepsOf() AND NEVER context.steps. The engine populates
 * `steps` once per evaluation, but the engine is not the only caller:
 * proof/run.ts measures a corpus case by calling `rule.evaluate(...)`
 * directly. A rule that read the field would see undefined on every corpus
 * case, skip, and be unmeasurable — and a rule with no published
 * measurement cannot enter the risk layer at all (src/eval/risk.ts drops
 * it). stepsOf() reads the field when the engine filled it and derives
 * otherwise, so one rule sees one trajectory on every path.
 */
import type { EvalContext } from '../types/eval.js';
import type { Span, Step, StepSource, ToolCallRecord } from '../types/trace.js';

/**
 * The ceiling on a derived trajectory.
 *
 * This is a fix as much as a guard. `no_tool_loop`'s cycle detector is
 * quadratic in the number of calls with no cap at all, so a trace carrying
 * twenty thousand TOOL spans would be four hundred million comparisons on a
 * single-threaded server. Five hundred steps bounds that at well under a
 * million, and nothing is dropped silently: `stepScopeNote` says what was
 * examined and out of how many.
 */
export const MAX_STEPS_DERIVED = 500;

/**
 * Where a span's fields are read from, in order, first hit wins.
 *
 * Exported because it is a guess about other people's emitters, and a guess
 * should be greppable. There is no settled convention to defer to: the OTel
 * GenAI semantic conventions are still moving, and the two span shapes in
 * this repository disagree with each other. A wrong guess makes a tool call
 * INVISIBLE rather than wrong, which is the safe direction, and
 * `stepScopeNote` is what keeps the silence audible.
 */
export const SPAN_ATTRIBUTE_PRECEDENCE = {
  name: ['tool.name', 'tool_name', 'gen_ai.tool.name'],
  input: ['tool.input', 'tool_input', 'gen_ai.tool.call.arguments', 'input'],
  output: ['tool.output', 'tool_output', 'gen_ai.tool.call.result', 'output'],
  callId: ['gen_ai.tool.call.id', 'tool.call_id', 'tool_call_id'],
  truncated: ['iris.output.truncated'],
} as const;

function attr(span: Span, keys: readonly string[]): unknown {
  const bag = span.attributes;
  if (!bag) return undefined;
  for (const key of keys) {
    if (bag[key] !== undefined) return bag[key];
  }
  return undefined;
}

function stepFromCall(call: ToolCallRecord, index: number): Step {
  const step: Step = {
    index,
    kind: 'tool',
    name: call.tool_name,
    source: 'tool_calls',
    status: typeof call.error === 'string' && call.error.trim().length > 0 ? 'error' : 'unset',
  };
  if (call.input !== undefined) step.input = call.input;
  if (call.output !== undefined) step.output = call.output;
  if (call.error !== undefined) step.error = call.error;
  if (call.latency_ms !== undefined) step.latencyMs = call.latency_ms;
  if (call.call_id !== undefined) step.callId = call.call_id;
  if (call.truncated !== undefined) step.truncated = call.truncated;
  if (call.token_usage !== undefined) step.tokens = call.token_usage;
  if (call.cost_usd !== undefined) step.costUsd = call.cost_usd;
  return step;
}

function stepFromSpan(span: Span, index: number): Step {
  const named = attr(span, SPAN_ATTRIBUTE_PRECEDENCE.name);
  const name = typeof named === 'string' && named.length > 0 ? named : span.name.replace(/^tool\./, '');
  const step: Step = {
    index,
    kind: 'tool',
    name,
    source: 'span',
    status: span.status_code === 'ERROR' ? 'error' : span.status_code === 'OK' ? 'ok' : 'unset',
  };
  const input = attr(span, SPAN_ATTRIBUTE_PRECEDENCE.input);
  const output = attr(span, SPAN_ATTRIBUTE_PRECEDENCE.output);
  const callId = attr(span, SPAN_ATTRIBUTE_PRECEDENCE.callId);
  if (input !== undefined) step.input = input;
  if (output !== undefined) step.output = output;
  /*
   * An ERROR span becomes a Step carrying a non-empty `error` STRING, which
   * is what routes it through the shipped definition of a failed call
   * (trajectory.ts, isFailedCall's first clause) when the rules migrate.
   * One definition of "failed", not two: the two trajectory corpora were
   * labelled against that one, and a second clause here would re-mean them
   * without a single case changing.
   */
  if (span.status_code === 'ERROR') step.error = span.status_message ?? 'span status ERROR';
  step.startedAt = span.start_time;
  if (span.end_time !== undefined) {
    step.endedAt = span.end_time;
    const ms = Date.parse(span.end_time) - Date.parse(span.start_time);
    if (Number.isFinite(ms) && ms >= 0) step.latencyMs = ms;
  }
  if (typeof callId === 'string') step.callId = callId;
  if (span.parent_span_id !== undefined) step.parentId = span.parent_span_id;
  if (attr(span, SPAN_ATTRIBUTE_PRECEDENCE.truncated) === true) step.truncated = true;
  return step;
}

/** TOOL spans in a TOTAL order: by start time, ties broken by span id. */
function toolSpansInOrder(spans: readonly Span[]): Span[] {
  return spans
    .filter((span) => span.kind === 'TOOL')
    .slice()
    .sort((a, b) => {
      const ta = Date.parse(a.start_time);
      const tb = Date.parse(b.start_time);
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
      if (a.start_time !== b.start_time) return a.start_time < b.start_time ? -1 : 1;
      return a.span_id < b.span_id ? -1 : a.span_id > b.span_id ? 1 : 0;
    });
}

/**
 * Derive the trajectory. Precedence is WHOLE-SOURCE, never per item.
 *
 * Most emitters produce BOTH a `tool_calls[]` and a set of TOOL spans for
 * the same calls, and no identity pairs one shape's entry to the other's.
 * Merging them would double every repeat count — `no_tool_loop` would read
 * a clean two-call trace as four — with nothing in the response saying why.
 * So one source wins entirely.
 *
 * The honest failure of that choice is under-reporting: a trace carrying
 * three tool calls and ten TOOL spans reports three steps, and the other
 * seven are invisible. That is the trajectory the caller declared, and it
 * is visible rather than silent — `stepStatsOf` reports the source and both
 * counts, and `stepScopeNote` puts it in a rule's own message.
 */
export function toSteps(context: Pick<EvalContext, 'toolCalls' | 'spans'>): Step[] {
  const calls = context.toolCalls;
  if (Array.isArray(calls) && calls.length > 0) {
    return calls.slice(0, MAX_STEPS_DERIVED).map((call, i) => stepFromCall(call, i));
  }
  const spans = context.spans;
  if (Array.isArray(spans) && spans.length > 0) {
    return toolSpansInOrder(spans)
      .slice(0, MAX_STEPS_DERIVED)
      .map((span, i) => stepFromSpan(span, i));
  }
  return [];
}

/**
 * The trajectory as a rule sees it.
 *
 * Reads what the engine already derived, derives it otherwise. Every rule
 * uses this and none reads `context.steps`, so a rule behaves identically
 * whether the engine ran it, the proof runner ran it, or a test built the
 * context by hand.
 */
export function stepsOf(context: EvalContext): readonly Step[] {
  return context.steps ?? toSteps(context);
}

/** What was derived and from where — the numbers that make under-reporting audible. */
export function stepStatsOf(context: EvalContext): { source: StepSource | 'none'; available: number; kept: number } {
  const calls = context.toolCalls;
  if (Array.isArray(calls) && calls.length > 0) {
    return { source: 'tool_calls', available: calls.length, kept: Math.min(calls.length, MAX_STEPS_DERIVED) };
  }
  const spans = context.spans;
  if (Array.isArray(spans) && spans.length > 0) {
    const tool = spans.filter((span) => span.kind === 'TOOL').length;
    if (tool > 0) return { source: 'span', available: tool, kept: Math.min(tool, MAX_STEPS_DERIVED) };
  }
  return { source: 'none', available: 0, kept: 0 };
}

/**
 * The sentence a rule appends when it judged less than it was handed.
 *
 * Empty when nothing was dropped, so a message that says nothing about
 * scope means the whole trajectory was examined. It also names the
 * diagnosis when spans were supplied and none produced a step: the usual
 * cause is an emitter whose attribute names this module does not recognise,
 * and telling that operator "no trajectory" would send them looking in the
 * wrong place.
 */
export function stepScopeNote(context: EvalContext): string {
  const stats = stepStatsOf(context);
  const spans = context.spans;
  const noCalls = !Array.isArray(context.toolCalls) || context.toolCalls.length === 0;
  if (stats.source === 'none' && noCalls && Array.isArray(spans) && spans.length > 0) {
    return ` (${spans.length} span(s) supplied, none of kind TOOL — a tool call reaches the trajectory rules as a TOOL span or as a tool_calls entry)`;
  }
  if (stats.kept < stats.available) {
    return ` (first ${stats.kept} of ${stats.available} steps examined; the trajectory rules cap at ${MAX_STEPS_DERIVED})`;
  }
  return '';
}
