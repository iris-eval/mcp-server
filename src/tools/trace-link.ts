import type { IStorageAdapter } from '../types/query.js';
import type { EvalResult } from '../types/eval.js';
import type { Trace } from '../types/trace.js';
import type { TenantId } from '../types/tenant.js';
import { irisError } from './errors.js';

/*
 * Linking an evaluation to a trace that does not exist.
 *
 * eval_results.trace_id is a foreign key. Passing an unknown trace_id to
 * evaluate_output used to run the whole evaluation and then fail at the
 * INSERT with SQLite's own words — "FOREIGN KEY constraint failed" — which
 * names no field, no value and no fix (#376). Worse for the paid tools:
 * evaluate_with_llm_judge had already spent the provider call by the time
 * the insert refused it.
 *
 * Two layers, because a check-then-insert has a gap: the pre-check refuses
 * BEFORE any work (and before any money) with the trace_id named; the
 * insert wrapper translates the constraint error for the race where the
 * trace is deleted between the check and the write.
 */
export function unknownTraceMessage(traceId: string): string {
  return (
    `trace_id "${traceId}" does not match any stored trace, so the evaluation cannot be linked to it. ` +
    'Nothing was evaluated or written. Pass the trace_id returned by log_trace (or listed by get_traces), ' +
    'or omit trace_id to store an unlinked evaluation.'
  );
}

/**
 * The same refuse-before-any-work check, returning the row it already read.
 *
 * evaluate_output needs the trace itself (its `tool_calls`, so a caller who
 * has already logged the trajectory does not have to resend it), and the
 * existence check had to load the row anyway. Fetching it twice would be
 * two reads for one fact — and two chances for them to disagree.
 */
/** The IRIS_UNKNOWN_TRACE error, built once for both the pre-check and the insert race. */
export function unknownTraceError(traceId: string) {
  return irisError('IRIS_UNKNOWN_TRACE', unknownTraceMessage(traceId), {
    field: 'trace_id',
    recovery: [
      'Pass the trace_id that log_trace returned, or one listed by get_traces.',
      'Or omit trace_id to store an unlinked evaluation.',
    ],
  });
}

export async function getTraceOrThrow(
  storage: IStorageAdapter,
  tenantId: TenantId,
  traceId: string,
): Promise<Trace> {
  const trace = await storage.getTrace(tenantId, traceId);
  if (!trace) throw unknownTraceError(traceId);
  return trace;
}

export async function assertTraceExists(
  storage: IStorageAdapter,
  tenantId: TenantId,
  traceId: string,
): Promise<void> {
  await getTraceOrThrow(storage, tenantId, traceId);
}

/** insertEvalResult with the foreign-key race translated into the same clear message. */
export async function insertLinkedEvalResult(
  storage: IStorageAdapter,
  tenantId: TenantId,
  result: EvalResult,
): Promise<void> {
  try {
    await storage.insertEvalResult(tenantId, result);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const message = err instanceof Error ? err.message : String(err);
    if (result.trace_id && (code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || /FOREIGN KEY constraint failed/i.test(message))) {
      throw unknownTraceError(result.trace_id);
    }
    throw err;
  }
}
