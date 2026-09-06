/*
 * The step layer (arc 4, A4-1).
 *
 * Two things are asserted here and they matter for different reasons.
 *
 * The DERIVATION tests pin the choices src/eval/steps.ts makes that a reader
 * would otherwise have to infer: whole-source precedence, a total order over
 * spans, an ERROR span becoming a Step with an `error` string so the shipped
 * definition of a failed call still decides, and a cap that is reported
 * rather than silent.
 *
 * The SINGLE-READING test is the structural one. `EvalContext` now carries
 * both the raw spans a caller supplied and the derived trajectory, and the
 * whole value of the abstraction is that exactly one of them is what a rule
 * judges. A rule reaching for `context.spans` would be a second vocabulary
 * for "what the agent did", inside rules whose measured accuracy is
 * arithmetic in the verdict. A grep is a blunt instrument and it is the
 * right one: it fails on the line that introduces the drift, in the PR that
 * introduces it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_STEPS_DERIVED, stepScopeNote, stepStatsOf, stepsOf, toSteps } from '../../../src/eval/steps.js';
import type { Span } from '../../../src/types/trace.js';

const root = resolve(__dirname, '..', '..', '..');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function span(over: Partial<Span> & Pick<Span, 'span_id' | 'start_time'>): Span {
  return {
    trace_id: 't',
    name: 'tool.call',
    kind: 'TOOL',
    status_code: 'UNSET',
    ...over,
  } as Span;
}

describe('the step layer — one derived reading of the trajectory', () => {
  it('no rule reads context.spans; the derived list is the only reading', () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(join(root, 'src', 'eval', 'rules'))) {
      const text = readFileSync(file, 'utf-8');
      // Strip block and line comments: this module's own prose explains the
      // rule and must not trip it.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (/\b(?:context|ctx)\s*\.\s*spans\b/.test(code)) offenders.push(file.slice(root.length + 1));
    }
    expect(offenders, 'a rule must read the trajectory through stepsOf(), never the raw spans').toEqual([]);
  });

  it('tool_calls wins outright when both shapes are present — never a merge', () => {
    const steps = toSteps({
      toolCalls: [{ tool_name: 'read', input: { path: 'a.ts' } }],
      spans: [span({ span_id: 's1', start_time: '2026-09-05T00:00:00Z' })],
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].source).toBe('tool_calls');
    expect(steps[0].name).toBe('read');
  });

  it('TOOL spans are derived in a total order, and non-TOOL spans are not steps', () => {
    const steps = toSteps({
      spans: [
        span({ span_id: 'b', start_time: '2026-09-05T00:00:02Z', attributes: { 'tool.name': 'second' } }),
        span({ span_id: 'a', start_time: '2026-09-05T00:00:01Z', attributes: { 'tool.name': 'first' } }),
        span({ span_id: 'c', start_time: '2026-09-05T00:00:03Z', kind: 'LLM', name: 'chat' }),
      ],
    });
    expect(steps.map((s) => s.name)).toEqual(['first', 'second']);
    expect(steps.map((s) => s.index)).toEqual([0, 1]);
    expect(steps.every((s) => s.source === 'span')).toBe(true);
  });

  it('ties on start_time break by span_id, so the order is total rather than merely sorted', () => {
    const at = '2026-09-05T00:00:00Z';
    const steps = toSteps({
      spans: [
        span({ span_id: 'zz', start_time: at, attributes: { 'tool.name': 'z' } }),
        span({ span_id: 'aa', start_time: at, attributes: { 'tool.name': 'a' } }),
      ],
    });
    expect(steps.map((s) => s.name)).toEqual(['a', 'z']);
  });

  it('an ERROR span becomes a step carrying an error STRING, which is what the shipped failure definition reads', () => {
    const [step] = toSteps({
      spans: [
        span({
          span_id: 's',
          start_time: '2026-09-05T00:00:00Z',
          status_code: 'ERROR',
          status_message: 'No such file or directory',
          attributes: { 'tool.name': 'ls' },
        }),
      ],
    });
    expect(step.status).toBe('error');
    expect(step.error).toBe('No such file or directory');
  });

  it('an ERROR span with no message still carries a non-empty error', () => {
    const [step] = toSteps({
      spans: [span({ span_id: 's', start_time: '2026-09-05T00:00:00Z', status_code: 'ERROR' })],
    });
    expect(step.error).toBeTruthy();
  });

  it('the span name falls back to the span itself with a tool. prefix stripped', () => {
    const [step] = toSteps({ spans: [span({ span_id: 's', start_time: '2026-09-05T00:00:00Z', name: 'tool.web_fetch' })] });
    expect(step.name).toBe('web_fetch');
  });

  it('latency comes from the span clock when both ends are present', () => {
    const [step] = toSteps({
      spans: [span({ span_id: 's', start_time: '2026-09-05T00:00:00.000Z', end_time: '2026-09-05T00:00:00.250Z' })],
    });
    expect(step.latencyMs).toBe(250);
    expect(step.startedAt).toBe('2026-09-05T00:00:00.000Z');
  });

  it('the four new capture fields reach the step unchanged', () => {
    const [step] = toSteps({
      toolCalls: [
        {
          tool_name: 'read',
          call_id: 'toolu_01',
          truncated: true,
          token_usage: { prompt_tokens: 10, completion_tokens: 2 },
          cost_usd: 0.0004,
        },
      ],
    });
    expect(step.callId).toBe('toolu_01');
    expect(step.truncated).toBe(true);
    expect(step.tokens).toEqual({ prompt_tokens: 10, completion_tokens: 2 });
    expect(step.costUsd).toBe(0.0004);
  });

  it('truncated is never inferred: an untruncated call leaves it undefined, not false', () => {
    const [step] = toSteps({ toolCalls: [{ tool_name: 'read', output: 'x'.repeat(50_000) }] });
    expect(step.truncated).toBeUndefined();
  });

  it('the derivation is capped, and the cap is reported rather than silent', () => {
    const many = Array.from({ length: MAX_STEPS_DERIVED + 7 }, (_, i) => ({ tool_name: `t${i}` }));
    const steps = toSteps({ toolCalls: many });
    expect(steps).toHaveLength(MAX_STEPS_DERIVED);
    const stats = stepStatsOf({ output: '', toolCalls: many });
    expect(stats).toEqual({ source: 'tool_calls', available: MAX_STEPS_DERIVED + 7, kept: MAX_STEPS_DERIVED });
    expect(stepScopeNote({ output: '', toolCalls: many })).toContain(`of ${MAX_STEPS_DERIVED + 7} steps`);
  });

  it('a whole trajectory examined says nothing about scope', () => {
    expect(stepScopeNote({ output: '', toolCalls: [{ tool_name: 'read' }] })).toBe('');
  });

  it('spans with no TOOL kind name the diagnosis instead of reading as no trajectory', () => {
    const note = stepScopeNote({
      output: '',
      spans: [span({ span_id: 's', start_time: '2026-09-05T00:00:00Z', kind: 'LLM' })],
    });
    expect(note).toContain('none of kind TOOL');
  });

  it('stepsOf prefers what the engine derived, and derives it when nothing did', () => {
    const derived = toSteps({ toolCalls: [{ tool_name: 'read' }] });
    expect(stepsOf({ output: '', steps: derived, toolCalls: [{ tool_name: 'ignored' }] })).toBe(derived);
    expect(stepsOf({ output: '', toolCalls: [{ tool_name: 'read' }] })[0].name).toBe('read');
    expect(stepsOf({ output: '' })).toEqual([]);
  });
});
