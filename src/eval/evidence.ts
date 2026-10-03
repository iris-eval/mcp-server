/*
 * The evidence contract: what a call carried, who recorded it, and what the
 * recorder promised.
 *
 * An empty list of tool calls is two different statements. From software
 * that watched the agent and records every call, it says none were made;
 * from the agent's own report, it says the agent reported none, which an
 * agent that called a tool and failed can say as easily as one that did
 * not. Until 0.20.0 Iris read both the same way, and a deployment that
 * required tool calls could not accept an honest turn that made none.
 *
 * A capture source now declares itself on the trace (Trace.capture) and
 * names the fields it records in full. Three things follow:
 *
 *   - a field it declares is evidence even when it is empty: its empty
 *     list of tool calls satisfies a deployment that requires tool calls;
 *   - a field it declares and the trace leaves out makes the verdict not
 *     checked: the record broke its source's promise, and a record with a
 *     hole in it is not a clean one;
 *   - every verdict says who recorded what it judged: a capture source, the
 *     agent, or nobody said.
 *
 * The agent's own doors (the log_trace and evaluate_output tools) take no
 * declaration: a record cannot vouch for itself.
 */
import type { EvalContext, EvidenceRecord, Need, RecordedBy } from '../types/eval.js';
import { CAPTURE_FIELDS, type CaptureField, type Trace, type TraceCapture } from '../types/trace.js';
import { inputsPresent } from './stamp.js';
import { stepsOf } from './steps.js';

/** Who recorded a stored trace: the agent when it came through the agent's own door, the capture source that declared itself, else nobody said. */
export function recordOfTrace(trace: Pick<Trace, 'source' | 'capture'>): { recordedBy: RecordedBy; capture?: TraceCapture } {
  if (trace.source === 'tool') return { recordedBy: 'agent' };
  if (trace.capture !== undefined) return { recordedBy: 'harness', capture: trace.capture };
  return { recordedBy: 'not_declared' };
}

/** A declaration in one canonical form: each complete field once, in CAPTURE_FIELDS order, and no empty list. */
export function canonicalCapture(capture: TraceCapture): TraceCapture {
  const complete = CAPTURE_FIELDS.filter((f) => capture.complete?.includes(f));
  return {
    name: capture.name,
    ...(capture.version !== undefined ? { version: capture.version } : {}),
    ...(complete.length > 0 ? { complete } : {}),
  };
}

/** The evidence record the engine stamps on an evaluation. */
export function evidenceOf(context: EvalContext): EvidenceRecord {
  const recordedBy = context.recordedBy ?? 'not_declared';
  const carried = [...inputsPresent(context)].sort() as Need[];
  return {
    recordedBy,
    ...(recordedBy === 'harness' && context.capture !== undefined ? { capture: canonicalCapture(context.capture) } : {}),
    carried,
    ...(carried.includes('tool_calls') ? { toolCalls: stepsOf(context).length } : {}),
  };
}

/**
 * The fields the capture source declared complete that the record does not
 * carry. Tool outputs are whole on a record with no tool call in it: there
 * was nothing to keep, and the hole, if any, is in the tool calls.
 */
export function brokenOf(evidence: EvidenceRecord | undefined): CaptureField[] {
  if (evidence === undefined || evidence.recordedBy !== 'harness') return [];
  const carried = new Set<Need>(evidence.carried);
  const calls = evidence.toolCalls ?? 0;
  return (evidence.capture?.complete ?? []).filter((f) => !carried.has(f) && !(f === 'tool_outputs' && calls === 0));
}

/** Whether a capture source that records every tool call recorded none. */
export function observedNoToolCalls(evidence: EvidenceRecord | undefined): boolean {
  return evidence !== undefined && evidence.recordedBy === 'harness' && (evidence.capture?.complete ?? []).includes('tool_calls') && evidence.toolCalls === 0;
}

/** The capture source as a reader names it: `iris-eval-capture 0.20.0`. */
export function captureLabel(capture: TraceCapture | undefined): string {
  if (capture === undefined) return 'the capture source';
  return capture.version !== undefined ? `${capture.name} ${capture.version}` : capture.name;
}
