/*
 * The verdict of a trace, and everything else said about it.
 *
 * A trace is a record: what was asked, what the agent answered, what it
 * did, what it cost. Its VERDICT is the server's own scoring of that
 * record: at ingest, by evaluate_runs, by the re-evaluate route, or by
 * evaluate_output when the call passes nothing that differs from it. Only
 * such an evaluation carries `trace_id`, and a later one of the same kind
 * supersedes an earlier one. That is what re-scoring under changed rules
 * is for.
 *
 * Anything else linked to a trace was shaped by the caller: other text, a
 * narrower bundle, a different list of tool calls, or another question
 * altogether (the LLM judge, the citation verifier). It is stored BESIDE
 * the trace (`reference_trace_id`, migration 020), listed with the trace's
 * evaluations, and is never its verdict.
 *
 * Until 0.20.0 both kinds carried `trace_id`, and every reader of a trace's
 * verdict took the newest. An agent whose trace failed on a leaked
 * credential called evaluate_output with the trace's id and clean text, and
 * the trace read `pass` in the run, the comparison and the export, with no
 * flag anywhere.
 */
import type { EvalResult, Interpretation } from '../types/eval.js';
import type { Trace } from '../types/trace.js';

/** What a caller can pass that the trace also records. Passing one that differs makes the evaluation the caller's, not the trace's. */
export const RECORD_FIELDS = ['output', 'input', 'tool_calls', 'tools', 'cost_usd', 'token_usage'] as const;
export type RecordField = (typeof RECORD_FIELDS)[number];

/** Why an evaluation sits beside a trace: the fields that differed, the narrowed bundle, or the tool that asked another question. */
export type BesideReason = RecordField | 'eval_type' | 'no_stored_output' | 'judge' | 'citations';

/** The newest evaluation that is a verdict on its trace; undefined when the trace has only evaluations made beside it. */
export function verdictOfRecord<T extends Pick<EvalResult, 'trace_id'>>(evals: readonly T[]): T | undefined {
  return evals.find((e) => e.trace_id !== undefined && e.trace_id !== null && e.trace_id !== '');
}

/** JSON with object keys in one order, so two values that say the same thing compare equal however they were built. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

const same = (a: unknown, b: unknown): boolean => stable(a ?? null) === stable(b ?? null);

export interface CallShape {
  output?: string;
  input?: string;
  tool_calls?: unknown;
  tools?: unknown;
  cost_usd?: number;
  token_usage?: unknown;
  eval_type?: string;
}

/**
 * How a call differs from the trace it names. Empty: the call scores the
 * stored record, and its evaluation is the trace's verdict. A field the
 * call omits is read from the trace, so omitting everything is the way to
 * score the record; a field passed with the stored value changes nothing.
 */
export function differsFromRecord(call: CallShape, trace: Pick<Trace, 'output' | 'input' | 'tool_calls' | 'tools' | 'cost_usd' | 'token_usage'>): BesideReason[] {
  const out: BesideReason[] = [];
  const stored = trace.output;
  if (stored === undefined || stored === null || stored === '') out.push('no_stored_output');
  else if (call.output !== undefined && call.output !== stored) out.push('output');
  if (call.input !== undefined && call.input !== (trace.input ?? undefined)) out.push('input');
  /*
   * An empty list is not the same as none. A trace stored without its tool
   * calls, and a call that sends `tool_calls: []` for it, is the caller
   * saying "no tool was called" where the record said nothing: other
   * evidence. Compared as equal, the call scored the record, and a capture
   * source's promise to record every call vouched for the caller's "none".
   */
  if (call.tool_calls !== undefined && !same(call.tool_calls, trace.tool_calls)) out.push('tool_calls');
  if (call.tools !== undefined && !same(call.tools, trace.tools ?? [])) out.push('tools');
  if (call.cost_usd !== undefined && call.cost_usd !== (trace.cost_usd ?? undefined)) out.push('cost_usd');
  if (call.token_usage !== undefined && !same(call.token_usage, trace.token_usage)) out.push('token_usage');
  if (call.eval_type !== undefined && call.eval_type !== 'all') out.push('eval_type');
  return out;
}

const list = (items: readonly string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** The sentence an evaluation made beside a trace carries, on the live response and on every later read. */
export function besideNote(traceId: string, reasons: readonly BesideReason[]): Interpretation {
  const kept = `It is kept beside trace ${traceId}; the trace's verdict is unchanged.`;
  if (reasons.includes('judge')) {
    return { severity: 'note', addressee: 'agent', text: `This is the LLM judge's answer to its own question, not the verdict of the trace. ${kept}` };
  }
  if (reasons.includes('citations')) {
    return { severity: 'note', addressee: 'agent', text: `This is the citation verifier's answer to its own question, not the verdict of the trace. ${kept}` };
  }
  const fields = reasons.filter((r) => r !== 'eval_type' && r !== 'no_stored_output');
  const why = [
    ...(reasons.includes('no_stored_output') ? ['the trace recorded no output, so there is no stored answer for it to be a verdict on'] : []),
    ...(fields.length > 0 ? [`this call passed ${list(fields.map((f) => `\`${f}\``))} that ${fields.length === 1 ? 'differs' : 'differ'} from what the trace stored`] : []),
    ...(reasons.includes('eval_type') ? ['it ran one bundle rather than every bundle'] : []),
  ];
  const how = reasons.includes('no_stored_output')
    ? 'Log the execution with its output (log_trace) to give it a verdict.'
    : 'To score the trace as stored, call evaluate_output with its trace_id and none of output, input, tool_calls, tools, cost_usd, token_usage or eval_type.';
  return {
    severity: 'warn',
    addressee: 'agent',
    text: `This evaluation is not the verdict of the trace: ${why.join('; ') || 'it judged what this call passed'}. ${kept} ${how}`,
  };
}
