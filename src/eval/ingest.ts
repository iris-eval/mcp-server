/*
 * Store-and-evaluate, once.
 *
 * Three doors take a trace in and can score it in the same breath: the
 * log_trace tool (evaluate: true), POST /api/v1/traces (evaluate: true)
 * and the CLI's ingest verb. Until 0.13.0 the HTTP route carried its own
 * copy of this block and the tool had none — a caller on the MCP path had
 * to make two calls, and the two paths could only stay identical by
 * someone remembering. One function now: the context is built from the
 * trace exactly as evaluate_output builds it from a stored trace, the
 * bundle default is the same constant, the result is linked and stored,
 * and the response is the one serializer every reader sees.
 */
import type { EvalEngine } from './engine.js';
import { DEFAULT_EVAL_TYPE, DEFAULT_EVAL_TYPE_NOTE } from './engine.js';
import type { DormantRule } from './dormant.js';
import { toEvaluationResponse } from './response.js';
import type { IStorageAdapter } from '../types/query.js';
import type { Trace } from '../types/trace.js';
import type { EvalResult, EvalType } from '../types/eval.js';
import type { TenantId } from '../types/tenant.js';

export type IngestEvalType = EvalType | 'all';

export interface EvaluateStoredTraceOptions {
  /** The bundle to run; omitted means every bundle, and the response says the default ran. */
  evalType?: IngestEvalType;
  /** The quarantined gating rules on this server, for coverage.dormant. */
  dormant?: DormantRule[];
}

export interface StoredTraceEvaluation {
  result: EvalResult;
  /** The same object evaluate_output returns for this trace. */
  response: Record<string, unknown>;
}

/**
 * Evaluate a trace that has just been stored, and store the evaluation
 * linked to it. The trace must carry an output — the callers check that
 * before storing anything, so a refusal never leaves a half-done write.
 */
export async function evaluateStoredTrace(
  engine: EvalEngine,
  storage: IStorageAdapter,
  tenantId: TenantId,
  trace: Trace & { output: string },
  options: EvaluateStoredTraceOptions = {},
): Promise<StoredTraceEvaluation> {
  const context = {
    output: trace.output,
    input: trace.input,
    costUsd: trace.cost_usd,
    tokenUsage: trace.token_usage,
    // What the agent DID, as this same request stored it. Whole-source
    // precedence in the step layer means spans are only reached when
    // tool_calls is absent, so forwarding both costs a reference and buys
    // trajectory evaluation for a span-only capture.
    toolCalls: trace.tool_calls,
    spans: trace.spans,
    tools: trace.tools,
  };
  const omitted = options.evalType === undefined;
  const evalType = options.evalType ?? DEFAULT_EVAL_TYPE;
  const result =
    evalType === 'all' ? await engine.evaluateAll(context) : await engine.evaluate(evalType as EvalType, context);
  result.trace_id = trace.trace_id;
  await storage.insertEvalResult(tenantId, result);
  return {
    result,
    response: toEvaluationResponse(result, {
      traceId: trace.trace_id,
      dormant: options.dormant,
      ...(omitted ? { note: DEFAULT_EVAL_TYPE_NOTE } : {}),
    }),
  };
}
