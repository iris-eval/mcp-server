/*
 * no_tool_loop generalised, and max_steps (arc 4, A4-11).
 *
 * The families measure both rules on trajectories they JUDGE. This file
 * holds the paths they decline, the helpers' own properties, and the two
 * claims that are easiest to assert and hardest to see in a confusion
 * matrix: that period-2 repetition still fires exactly where it did, and
 * that a trajectory carrying no timing is judged exactly as it was before.
 */
import { describe, expect, it } from 'vitest';
import { maxSteps, noToolLoop, DEFAULT_MAX_STEPS } from '../../../src/eval/rules/cost.js';
import { longestCycle, looksLikePolling, subjectOf, targetKey } from '../../../src/eval/rules/trajectory.js';
import type { EvalContext } from '../../../src/types/eval.js';
import type { Step } from '../../../src/types/trace.js';

const call = (tool: string, input: unknown) => ({ tool_name: tool, input, output: 'result' });
const run = (rule: typeof noToolLoop, ctx: Partial<EvalContext>) => rule.evaluate({ output: 'done', ...ctx } as EvalContext);

describe('no_tool_loop — what it declines to judge', () => {
  it('skips without a trajectory rather than reporting a clean run', () => {
    const r = run(noToolLoop, {});
    expect(r.skipped).toBe(true);
    expect(r.passed).toBe(false);
  });
});

describe('no_tool_loop — repetition at more than one period', () => {
  it('period 2 still fires exactly where it did: three alternating cycles, not two', () => {
    // The threshold that keeps every pre-existing corpus case where it was.
    const two = (n: number) => Array.from({ length: n }, (_, i) => call(i % 2 === 0 ? 'a' : 'b', { i: i % 2 }));
    expect(run(noToolLoop, { toolCalls: two(4) }).passed).toBe(true);
    expect(run(noToolLoop, { toolCalls: two(6) }).passed).toBe(false);
  });

  it('period 3 is new recall the pair detector could not reach', () => {
    const three = (n: number) => Array.from({ length: n }, (_, i) => call(['a', 'b', 'c'][i % 3], { i: i % 3 }));
    expect(run(noToolLoop, { toolCalls: three(6) }).passed).toBe(true);
    const r = run(noToolLoop, { toolCalls: three(9) });
    expect(r.passed).toBe(false);
    expect(r.message).toContain('3-call sequence');
  });

  it('a run whose period is shorter is reported at the shorter period, never twice', () => {
    // A,A,A,A is a period-1 run. Counting it as period 2 as well would hand
    // the risk estimate two correlated detectors of one failure class.
    expect(longestCycle(['a', 'a', 'a', 'a'], 2)).toBeNull();
    expect(longestCycle(['a', 'b', 'a', 'b', 'a', 'b'], 2)?.repetitions).toBe(3);
  });

  it('does not invent a cycle out of a plan', () => {
    const distinct = Array.from({ length: 12 }, (_, i) => call(`t${i}`, { i }));
    expect(run(noToolLoop, { toolCalls: distinct }).passed).toBe(true);
  });
});

describe('no_tool_loop — a poll is not a loop', () => {
  const span = (at: number) => ({
    trace_id: 'tr-1',
    span_id: `s${at}`,
    name: 'tool.check',
    kind: 'TOOL' as const,
    start_time: new Date(Date.UTC(2026, 8, 6, 12, 0, at)).toISOString(),
    status_code: 'OK' as const,
    attributes: { 'gen_ai.tool.name': 'check', 'gen_ai.tool.call.arguments': '{"id":1}' },
  });

  it('a steady cadence passes, and the message says why', () => {
    const r = run(noToolLoop, { spans: [span(0), span(10), span(20), span(30), span(40)] });
    expect(r.passed).toBe(true);
    expect(r.message).toContain('polling rather than a loop');
  });

  it('a burst and an irregular sequence both stay loops', () => {
    expect(run(noToolLoop, { spans: [span(0), span(0), span(1), span(1), span(2)] }).passed).toBe(false);
    expect(run(noToolLoop, { spans: [span(0), span(3), span(40), span(44), span(120)] }).passed).toBe(false);
  });

  it('WITHOUT timing everything stays a loop, so sending spans can only remove a false positive', () => {
    const five = Array.from({ length: 5 }, () => call('check', { id: 1 }));
    expect(run(noToolLoop, { toolCalls: five }).passed).toBe(false);
    expect(looksLikePolling([undefined, undefined, undefined])).toBe(false);
  });

  it('sub-second gaps are a burst however regular they are', () => {
    const times = ['2026-09-06T12:00:00.000Z', '2026-09-06T12:00:00.100Z', '2026-09-06T12:00:00.200Z', '2026-09-06T12:00:00.300Z'];
    expect(looksLikePolling(times)).toBe(false);
  });
});

describe('no_tool_loop — the same target through different tools', () => {
  const CATALOGUE = [
    { name: 'read_file', description: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'cat', description: 'print', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'view', description: 'show', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'write_file', description: 'write', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
  ];
  const rereads = [call('read_file', { path: 'a.ts' }), call('cat', { path: 'a.ts' }), call('view', { path: 'a.ts' }), call('read_file', { path: 'a.ts', enc: 'utf8' })];

  it('four reads of one file through three tools is one wasted read, and fires', () => {
    const r = run(noToolLoop, { toolCalls: rereads, tools: CATALOGUE });
    expect(r.passed).toBe(false);
    expect(r.message).toContain('same target');
  });

  it('is DORMANT without a catalogue — a rule must not guess that a tool is a read', () => {
    expect(run(noToolLoop, { toolCalls: rereads }).passed).toBe(true);
  });

  it('never counts a write, however many times it hits the same path', () => {
    const writes = Array.from({ length: 5 }, (_, i) => call('write_file', { path: 'out.txt', chunk: i }));
    expect(run(noToolLoop, { toolCalls: writes, tools: CATALOGUE }).passed).toBe(true);
  });

  it('the name heuristic explains what was left out and never decides', () => {
    const r = run(noToolLoop, {
      toolCalls: [call('read_file', { path: 'a.ts' }), call('fetch_page', { url: 'https://x.test' }), call('fetch_page', { url: 'https://x.test' })],
      tools: [CATALOGUE[0]],
    });
    expect(r.passed).toBe(true);
    expect(r.message).toContain('the catalogue does not say so');
  });

  it('reads the subject from a fixed key precedence, so a bash call has one too', () => {
    const bash = { index: 0, kind: 'tool' as const, name: 'bash', source: 'tool_calls' as const, status: 'ok' as const, input: { command: 'grep -rn needle src/' } };
    expect(subjectOf(bash as Step)).toBe('grep -rn needle src/');
    expect(targetKey({ ...bash, input: { path: '/A/B.ts' } } as Step)).toBe('/a/b.ts');
    expect(subjectOf({ ...bash, input: {} } as Step)).toBeNull();
  });
});

describe('max_steps', () => {
  const trajectory = (n: number) => Array.from({ length: n }, (_, i) => call('read_file', { path: `f${i}.ts` }));

  it('skips without a trajectory', () => {
    const r = maxSteps.evaluate({ output: 'done' } as EvalContext);
    expect(r.skipped).toBe(true);
  });

  it('passes AT the budget and fails one over it', () => {
    expect(maxSteps.evaluate({ output: 'x', toolCalls: trajectory(DEFAULT_MAX_STEPS) } as EvalContext).passed).toBe(true);
    expect(maxSteps.evaluate({ output: 'x', toolCalls: trajectory(DEFAULT_MAX_STEPS + 1) } as EvalContext).passed).toBe(false);
  });

  it('ADVISES at the shipped default and GATES once the deployment sets it', () => {
    // compose.decides() reads thresholdSource, so this is the whole
    // mechanism of "a default is not your policy".
    const dflt = maxSteps.evaluate({ output: 'x', toolCalls: trajectory(3) } as EvalContext);
    const source = (dflt.evidence ?? []).find((e) => e.type === 'count') as { thresholdSource: string };
    expect(source.thresholdSource).toBe('default');
    expect(dflt.message).toContain('advises rather than gates');

    const set = maxSteps.evaluate({ output: 'x', toolCalls: trajectory(3), customConfig: { max_steps: 10 } } as EvalContext);
    const setSource = (set.evidence ?? []).find((e) => e.type === 'count') as { thresholdSource: string; threshold: number };
    expect(setSource.thresholdSource).toBe('config');
    expect(setSource.threshold).toBe(10);
  });

  it('leaves the default standing on a budget it cannot honour, rather than inventing one', () => {
    for (const max_steps of [0, -5, 'ten', null]) {
      const r = maxSteps.evaluate({ output: 'x', toolCalls: trajectory(20), customConfig: { max_steps } } as EvalContext);
      expect(r.passed, `max_steps: ${JSON.stringify(max_steps)}`).toBe(true);
      const e = (r.evidence ?? []).find((x) => x.type === 'count') as { threshold: number };
      expect(e.threshold).toBe(DEFAULT_MAX_STEPS);
    }
  });

  it('floors a fractional budget, which is the denial-favouring reading', () => {
    expect(maxSteps.evaluate({ output: 'x', toolCalls: trajectory(41), customConfig: { max_steps: 40.7 } } as EvalContext).passed).toBe(false);
    expect(maxSteps.evaluate({ output: 'x', toolCalls: trajectory(40), customConfig: { max_steps: 40.7 } } as EvalContext).passed).toBe(true);
  });

  it('counts length and nothing else, so repetition stays no_tool_loop\'s finding', () => {
    const identical = Array.from({ length: 5 }, () => call('read_file', { path: 'a.ts' }));
    expect(maxSteps.evaluate({ output: 'x', toolCalls: identical } as EvalContext).passed).toBe(true);
  });
});
