/*
 * The export formats (#4): CSV cells that a spreadsheet can neither
 * misparse nor execute, and JSON Lines records that are one line each.
 */
import { describe, expect, it } from 'vitest';
import { CSV_BOM, EVAL_COLUMNS, TRACE_COLUMNS, csvCell, csvRow, evalEncoder, exportFilename, traceEncoder } from '../../../src/export/format.js';
import type { TraceRecord } from '../../../src/types/query.js';
import type { EvalResult } from '../../../src/types/eval.js';
import { parseCsv } from '../../helpers/csv.js';

describe('csvCell', () => {
  it('prefixes a quote to every text cell a spreadsheet would read as a formula (OWASP: = + - @ tab CR)', () => {
    expect(csvCell('=HYPERLINK("http://x","click")')).toBe(`"'=HYPERLINK(""http://x"",""click"")"`);
    expect(csvCell('+1+2')).toBe("'+1+2");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    expect(csvCell('\r=1')).toBe(`"'\r=1"`);
  });

  it('leaves text that only contains those characters later, and numbers, alone', () => {
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell('email me@x.io')).toBe('email me@x.io');
    expect(csvCell(-1.5)).toBe('-1.5');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(Number.NaN)).toBe('');
  });

  it('quotes a field holding a comma, a quote, CR or LF, doubles quotes, and keeps newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line 1\nline 2')).toBe('"line 1\nline 2"');
    expect(csvCell('line 1\r\nline 2')).toBe('"line 1\r\nline 2"');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(null)).toBe('');
  });

  it('ends every record with CRLF', () => {
    expect(csvRow(['a', 1, undefined, 'b,c'])).toBe('a,1,,"b,c"\r\n');
  });
});

const record: TraceRecord = {
  trace: {
    trace_id: 't1',
    agent_name: 'support-bot',
    framework: 'langchain',
    input: '=cmd|"/c calc"!A1',
    output: 'Réponse: 返金は承認されました 🎉\nSecond line, with "quotes"',
    tool_calls: [{ tool_name: 'lookup', input: { id: 1 } }, { tool_name: 'refund' }],
    latency_ms: 120,
    token_usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    cost_usd: 0.002,
    cost_source: 'estimated',
    metadata: { channel: 'web' },
    timestamp: '2026-09-28T10:00:00.000Z',
    session_id: 's1',
    source: 'http',
  },
  spans: [{ span_id: 'sp1', trace_id: 't1', name: 'llm', kind: 'LLM', status_code: 'OK', start_time: '2026-09-28T10:00:00.000Z' }],
  evals: [
    {
      id: 'e2',
      trace_id: 't1',
      eval_type: 'safety',
      output_text: 'x',
      score: 0.4,
      passed: false,
      rule_results: [
        { ruleName: 'no_pii', passed: false, score: 0, message: '' },
        { ruleName: 'no_injection', passed: true, score: 1, message: '' },
        { ruleName: 'skipped_rule', passed: false, skipped: true, score: 0, message: '' },
      ],
      verdict: { state: 'fail', passed: false, basis: 'detector_veto', by: ['no_pii'], risk: null },
    } as EvalResult,
    { id: 'e1', trace_id: 't1', eval_type: 'completeness', output_text: 'x', score: 1, passed: true, rule_results: [] } as EvalResult,
  ],
};

describe('trace export', () => {
  it('CSV: a BOM, the documented header, and a row a CSV reader returns unchanged', () => {
    const enc = traceEncoder('csv');
    expect(enc.header.startsWith(CSV_BOM)).toBe(true);
    const text = enc.header + enc.batch([record]);
    const [header, row] = parseCsv(text.slice(CSV_BOM.length));
    expect(header).toEqual(TRACE_COLUMNS.map((c) => c.name));
    const cell = (name: string) => row[header.indexOf(name)];
    expect(cell('trace_id')).toBe('t1');
    expect(cell('input'), 'the formula is neutralised').toBe(`'=cmd|"/c calc"!A1`);
    expect(cell('output'), 'non-ASCII and newlines survive').toBe(record.trace.output);
    expect(cell('cost_source')).toBe('estimated');
    expect(cell('tool_call_count')).toBe('2');
    expect(cell('tool_names')).toBe('lookup; refund');
    expect(cell('span_count')).toBe('1');
    expect(cell('eval_count')).toBe('2');
    expect(cell('latest_eval_id'), 'the newest evaluation, which evals[0] is').toBe('e2');
    expect(cell('latest_passed')).toBe('false');
    expect(cell('latest_verdict_basis')).toBe('detector_veto');
    expect(cell('latest_failed_rules'), 'a skip is not a failure').toBe('no_pii');
    expect(JSON.parse(cell('metadata'))).toEqual({ channel: 'web' });
    expect(JSON.parse(cell('tool_calls'))).toEqual(record.trace.tool_calls);
    expect(cell('run_id')).toBe('');
  });

  it('JSON Lines: one record per line, the trace-detail shape, no BOM', () => {
    const enc = traceEncoder('jsonl');
    const text = enc.header + enc.batch([record, record]);
    expect(text.startsWith(CSV_BOM)).toBe(false);
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[0])).toEqual(record);
  });
});

describe('evaluation export', () => {
  it('CSV: the documented columns', () => {
    const enc = evalEncoder('csv');
    const [header, row] = parseCsv((enc.header + enc.batch([record.evals[0]])).slice(CSV_BOM.length));
    expect(header).toEqual(EVAL_COLUMNS.map((c) => c.name));
    const cell = (name: string) => row[header.indexOf(name)];
    expect(cell('eval_id')).toBe('e2');
    expect(cell('score')).toBe('0.4');
    expect(cell('failed_rules')).toBe('no_pii');
    expect(cell('verdict')).toBe('fail');
    expect(cell('verdict_by')).toBe('no_pii');
    expect(cell('verdict_also'), 'one layer decided alone').toBe('');
  });

  it('CSV: a veto a policy gate decided ahead of is in verdict_also, so a filter on the basis alone does not lose it', () => {
    const masked = {
      ...record.evals[0],
      verdict: { state: 'fail', passed: false, basis: 'policy_gate', by: ['cost_under_threshold'], risk: null, also: [{ basis: 'detector_veto', state: 'fail', by: ['no_pii'] }, { basis: 'risk_over_loss', state: 'fail', by: ['pii_leak'] }] },
    } as EvalResult;
    const enc = evalEncoder('csv');
    const [header, row] = parseCsv((enc.header + enc.batch([masked])).slice(CSV_BOM.length));
    expect(row[header.indexOf('verdict_basis')]).toBe('policy_gate');
    expect(row[header.indexOf('verdict_also')]).toBe('detector_veto; risk_over_loss');
    const trace = traceEncoder('csv');
    const [th, tr] = parseCsv((trace.header + trace.batch([{ ...record, evals: [masked] }])).slice(CSV_BOM.length));
    expect(tr[th.indexOf('latest_verdict_also')]).toBe('detector_veto; risk_over_loss');
  });
});

describe('exportFilename', () => {
  it('names the kind, the UTC moment and the format, with nothing a filesystem refuses', () => {
    expect(exportFilename('traces', 'csv', new Date('2026-09-28T10:15:00.123Z'))).toBe('iris-traces-2026-09-28T101500Z.csv');
    expect(exportFilename('evaluations', 'jsonl', new Date('2026-09-28T10:15:00.123Z'))).toBe('iris-evaluations-2026-09-28T101500Z.jsonl');
  });
});
