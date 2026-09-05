/*
 * One serializer for the evaluation response.
 *
 * Three surfaces used to hand-build the same JSON — the evaluate_output
 * tool, the HTTP ingest route and (its own shape) the judge tool — and each
 * had to remember every optional field on its own; `critical_skipped` was
 * missing from one for a release, and `trace_id` was set on the result and
 * echoed by none. This is the one place the response is assembled; the
 * response schema (src/eval/response-schema.ts) describes what it emits and
 * the drift-lock validates it against the real handlers.
 */
import type { EvalResult } from '../types/eval.js';
import type { DormantRule } from './dormant.js';

export interface EvaluationResponseOptions {
  /** The trace the evaluation was linked to, echoed so a caller can join the two without a second read. */
  traceId?: string;
  /** Present only when `eval_type` was omitted and the default ran. */
  note?: string;
  /** Quarantined gating rules on this server, carried as coverage.dormant (a gate reads the verdict, never list_rules). */
  dormant?: DormantRule[];
}

/** The response body for an evaluation — what the tool returns as text and, later, as structured content. */
export function toEvaluationResponse(result: EvalResult, options: EvaluationResponseOptions = {}): Record<string, unknown> {
  const traceId = options.traceId ?? result.trace_id;
  return {
    id: result.id,
    ...(traceId ? { trace_id: traceId } : {}),
    // Echo which bundle actually ran. Without this, a caller who omitted
    // eval_type could not tell a "safety pass" from a completeness eval
    // that never ran a single safety rule.
    eval_type: result.eval_type,
    score: result.score,
    passed: result.passed,
    ...(result.verdict ? { verdict: result.verdict } : {}),
    ...(result.critical_failures?.length ? { critical_failures: result.critical_failures } : {}),
    // The other half of the veto contract: every critical rule that SKIPPED
    // is named so a fail-closed gate can treat the evaluation as unknown.
    ...(result.critical_skipped?.length ? { critical_skipped: result.critical_skipped } : {}),
    rule_results: result.rule_results,
    suggestions: result.suggestions,
    rules_evaluated: result.rules_evaluated,
    rules_skipped: result.rules_skipped,
    insufficient_data: result.insufficient_data,
    ...(result.coverage ? { coverage: options.dormant?.length ? { ...result.coverage, dormant: options.dormant } : result.coverage } : {}),
    ...(result.erased_at ? { erased_at: result.erased_at } : {}),
    ...(result.provenance ? { provenance: result.provenance } : {}),
    // Per-bundle breakdown — eval_type="all" only.
    ...(result.categories ? { categories: result.categories } : {}),
    ...(options.note ? { note: options.note } : {}),
  };
}
