/*
 * Export formats (#4): what a trace or an evaluation looks like as a CSV
 * row and as a JSON Lines record. One module for every door that exports
 * — the dashboard's download, GET /api/v1/{traces,evaluations}/export and
 * `iris-eval export` — so the bytes cannot differ by door.
 *
 * CSV (RFC 4180, for spreadsheets):
 *   - UTF-8 with a byte-order mark. Excel reads a CSV without one in the
 *     machine's legacy code page, so every non-ASCII character (names,
 *     CJK text, emoji) arrives garbled; with the mark it reads UTF-8.
 *     Scripts that want no mark read the JSON Lines export.
 *   - CRLF between records; a field holding a comma, a quote, CR or LF is
 *     quoted, with quotes doubled. Newlines inside a field are kept.
 *   - Formula injection is neutralised: a text cell beginning with = + - @
 *     tab or CR is prefixed with a single quote (the OWASP rule), so a
 *     stored output like `=HYPERLINK(...)` is shown as text, never run.
 *     Number columns are written by this module from numbers and are not
 *     prefixed, so they stay numbers.
 *   - The column set is fixed and documented (docs/api-reference.md);
 *     an absent value is an empty cell. Nested values that do not fit a
 *     cell (metadata, tool calls) are one JSON string each. Nothing is
 *     truncated here — note that Excel itself shows at most 32,767
 *     characters of a cell.
 *
 * JSON Lines (for programs): one record per line, UTF-8, LF, no mark. A
 * trace record is exactly what GET /api/v1/traces/:id answers for that
 * trace — {trace, spans, evals} — so a program that reads one trace reads
 * the export, and the spans and evaluations travel with their trace
 * instead of in files that must be joined back. An evaluation record is
 * exactly an item of GET /api/v1/evaluations.
 */
import type { EvalResult } from '../types/eval.js';
import type { TraceRecord } from '../types/query.js';

export const EXPORT_FORMATS = ['csv', 'jsonl'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export type ExportKind = 'traces' | 'evaluations';

/** UTF-8 byte-order mark; the first bytes of every CSV export. */
export const CSV_BOM = '\uFEFF';

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** One CSV cell. Strings are neutralised against formulas and quoted when needed; numbers and booleans are written as they are. */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV record, CRLF-terminated. */
export function csvRow(cells: ReadonlyArray<string | number | boolean | null | undefined>): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

type Cell = string | number | boolean | null | undefined;
interface Column<T> {
  name: string;
  value: (row: T) => Cell;
}

const json = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : JSON.stringify(v));
/** Rules that fired: not passed and not skipped (a skip is not a failure anywhere in Iris). */
const failedRules = (e: EvalResult): string => e.rule_results.filter((r) => !r.passed && !r.skipped).map((r) => r.ruleName).join('; ');

/** The trace CSV columns, in order. The latest_* columns describe the newest evaluation of the trace, the one min_score and max_score filter on. */
export const TRACE_COLUMNS: ReadonlyArray<Column<TraceRecord>> = [
  { name: 'trace_id', value: (r) => r.trace.trace_id },
  { name: 'timestamp', value: (r) => r.trace.timestamp },
  { name: 'agent_name', value: (r) => r.trace.agent_name },
  { name: 'framework', value: (r) => r.trace.framework },
  { name: 'source', value: (r) => r.trace.source },
  { name: 'session_id', value: (r) => r.trace.session_id },
  { name: 'run_id', value: (r) => r.trace.run_id },
  { name: 'case_key', value: (r) => r.trace.case_key },
  { name: 'latency_ms', value: (r) => r.trace.latency_ms },
  { name: 'prompt_tokens', value: (r) => r.trace.token_usage?.prompt_tokens },
  { name: 'completion_tokens', value: (r) => r.trace.token_usage?.completion_tokens },
  { name: 'total_tokens', value: (r) => r.trace.token_usage?.total_tokens },
  { name: 'cost_usd', value: (r) => r.trace.cost_usd },
  // `reported` or `estimated` (from the tokens at list price); empty when the trace has no cost. The JSON Lines record carries cost_estimate as well: the calls, tokens and prices behind an estimate.
  { name: 'cost_source', value: (r) => r.trace.cost_source },
  { name: 'input', value: (r) => r.trace.input },
  { name: 'output', value: (r) => r.trace.output },
  { name: 'tool_call_count', value: (r) => r.trace.tool_calls?.length ?? 0 },
  { name: 'tool_names', value: (r) => r.trace.tool_calls?.map((t) => t.tool_name).join('; ') },
  { name: 'span_count', value: (r) => r.spans.length },
  { name: 'eval_count', value: (r) => r.evals.length },
  { name: 'latest_eval_id', value: (r) => r.evals[0]?.id },
  { name: 'latest_score', value: (r) => r.evals[0]?.score },
  { name: 'latest_passed', value: (r) => r.evals[0]?.passed },
  { name: 'latest_verdict', value: (r) => r.evals[0]?.verdict?.state },
  { name: 'latest_verdict_basis', value: (r) => r.evals[0]?.verdict?.basis },
  { name: 'latest_verdict_also', value: (r) => alsoBases(r.evals[0]) },
  { name: 'latest_failed_rules', value: (r) => (r.evals[0] ? failedRules(r.evals[0]) : undefined) },
  { name: 'metadata', value: (r) => json(r.trace.metadata) },
  { name: 'tool_calls', value: (r) => json(r.trace.tool_calls) },
];

function alsoBases(e: EvalResult | undefined): string | undefined {
  return e?.verdict?.also?.map((l) => l.basis).join('; ');
}

/** The evaluation CSV columns, in order. */
export const EVAL_COLUMNS: ReadonlyArray<Column<EvalResult>> = [
  { name: 'eval_id', value: (e) => e.id },
  { name: 'created_at', value: (e) => e.created_at },
  { name: 'trace_id', value: (e) => e.trace_id },
  { name: 'run_id', value: (e) => e.run_id },
  { name: 'eval_type', value: (e) => e.eval_type },
  { name: 'score', value: (e) => e.score },
  { name: 'passed', value: (e) => e.passed },
  { name: 'verdict', value: (e) => e.verdict?.state },
  { name: 'verdict_basis', value: (e) => e.verdict?.basis },
  { name: 'verdict_by', value: (e) => e.verdict?.by.join('; ') },
  // Every later layer that would have decided it too: a filter on verdict_basis alone misses a veto a policy gate decided ahead of.
  { name: 'verdict_also', value: alsoBases },
  { name: 'rules_evaluated', value: (e) => e.rules_evaluated },
  { name: 'rules_skipped', value: (e) => e.rules_skipped },
  { name: 'failed_rules', value: failedRules },
  { name: 'critical_failures', value: (e) => e.critical_failures?.join('; ') },
  { name: 'critical_skipped', value: (e) => e.critical_skipped?.join('; ') },
  { name: 'insufficient_data', value: (e) => e.insufficient_data },
  { name: 'eval_cost_usd', value: (e) => e.eval_cost_usd },
  { name: 'eval_tokens', value: (e) => e.eval_tokens },
  { name: 'iris_version', value: (e) => e.provenance?.irisVersion },
  { name: 'ruleset_hash', value: (e) => e.provenance?.rulesetHash },
  { name: 'erased_at', value: (e) => e.erased_at },
  { name: 'output_text', value: (e) => e.output_text },
  { name: 'expected_text', value: (e) => e.expected_text },
];

/** Turns records of one kind into the bytes of one format: a header (the BOM and column names for CSV, nothing for JSON Lines), then one chunk per batch. */
export interface ExportEncoder<T> {
  header: string;
  batch(rows: readonly T[]): string;
}

function csvEncoder<T>(columns: ReadonlyArray<Column<T>>): ExportEncoder<T> {
  return {
    header: CSV_BOM + csvRow(columns.map((c) => c.name)),
    batch: (rows) => rows.map((row) => csvRow(columns.map((c) => c.value(row)))).join(''),
  };
}

function jsonlEncoder<T>(): ExportEncoder<T> {
  // JSON.stringify escapes every control character, LF and CR included, so a record is always one line.
  return { header: '', batch: (rows) => rows.map((row) => `${JSON.stringify(row)}\n`).join('') };
}

export function traceEncoder(format: ExportFormat): ExportEncoder<TraceRecord> {
  return format === 'csv' ? csvEncoder(TRACE_COLUMNS) : jsonlEncoder();
}

export function evalEncoder(format: ExportFormat): ExportEncoder<EvalResult> {
  return format === 'csv' ? csvEncoder(EVAL_COLUMNS) : jsonlEncoder();
}

export const CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8; header=present',
  jsonl: 'application/x-ndjson; charset=utf-8',
};

/** `iris-traces-2026-09-28T101500Z.csv`: the kind, the moment the export began (UTC, filename-safe), the format. */
export function exportFilename(kind: ExportKind, format: ExportFormat, at: Date = new Date()): string {
  const stamp = at.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '');
  return `iris-${kind}-${stamp}.${format}`;
}
