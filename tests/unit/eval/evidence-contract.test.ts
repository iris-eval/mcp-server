/*
 * The evidence contract (src/eval/evidence.ts).
 *
 * An empty list of tool calls from software that watched the agent and
 * records every call says none were made; the same list from the agent's
 * own report says only that it reported none. A field the capture source
 * declared and the trace left out is a hole in the record, and a record
 * with a hole in it is not checked. Every verdict says who recorded what it
 * judged, and a stored row composes from the same facts on every read.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { compose, DEFAULT_COMPOSE } from '../../../src/eval/compose.js';
import { brokenOf, canonicalCapture, evidenceOf, recordOfTrace } from '../../../src/eval/evidence.js';
import { inputsPresent } from '../../../src/eval/stamp.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { EvalContext, EvalResult } from '../../../src/types/eval.js';
import type { TraceCapture } from '../../../src/types/trace.js';

const HOOK: TraceCapture = { name: 'iris-eval-capture', version: '0.20.0', complete: ['input', 'tool_calls', 'tool_outputs'] };
const ASK = { input: 'What is the capital of France?', output: 'The capital of France is Paris.' };
const harness = (extra: Partial<EvalContext> = {}, capture: TraceCapture = HOOK): EvalContext => ({ ...ASK, recordedBy: 'harness', capture, ...extra });

const engine = (eval_: Record<string, unknown> = {}): EvalEngine =>
  new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, ...eval_ } as never);
const requiresCalls = engine({ requiredEvidence: ['tool_calls'] });
const shipped = engine();

const question = (r: EvalResult, id: string) => r.coverage?.questions.find((q) => q.id === id);
const sentences = (r: EvalResult) => (r.interpretations ?? []).map((i) => `[${i.severity}/${i.addressee}] ${i.text}`);

describe('an empty list of tool calls', () => {
  it('from a capture source that records every call, meets a deployment that requires tool calls', async () => {
    const r = await requiresCalls.evaluateAll(harness({ toolCalls: [] }));
    expect(r.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    expect(r.provenance!.evidence).toEqual({ recordedBy: 'harness', capture: HOOK, carried: ['input', 'output', 'tool_calls', 'tool_outputs'], toolCalls: 0 });
    // The tool-use question had nothing to judge, and the record says why.
    expect(question(r, 'tool_use_correct')).toEqual({ id: 'tool_use_correct', status: 'not_applicable', why: 'no tool was called: iris-eval-capture 0.20.0 records every tool call and recorded none' });
  });

  it('from the agent, from nobody, or from a source that declared nothing, does not: it is a report, not an observation', async () => {
    for (const context of [
      { ...ASK, toolCalls: [], recordedBy: 'agent' as const },
      { ...ASK, toolCalls: [] },
      harness({ toolCalls: [] }, { name: 'some-exporter' }),
    ]) {
      const r = await requiresCalls.evaluateAll(context);
      expect(r.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
      expect(question(r, 'tool_use_correct')?.status).toBe('unjudged');
      expect(sentences(r)).toContain('[block/agent] Not checked, which is not a pass: this deployment requires tool_calls on every evaluation. Send tool_calls and ask again.');
    }
  });

  it('at the shipped configuration changes no verdict: an honest text-only turn passes from every recorder', async () => {
    for (const context of [harness({ toolCalls: [] }), { ...ASK, toolCalls: [], recordedBy: 'agent' as const }, { ...ASK, toolCalls: [] }]) {
      expect((await shipped.evaluateAll(context)).verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    }
  });

  it('is the same statement when an OpenTelemetry capture source sent spans with no TOOL span among them', async () => {
    const spans = [{ span_id: 's1', trace_id: 't1', name: 'chat', kind: 'LLM' as const, status_code: 'OK' as const, start_time: '2026-10-03T00:00:00.000Z' }];
    const r = await requiresCalls.evaluateAll(harness({ spans }, { name: 'otel-agent', complete: ['tool_calls'] }));
    expect(r.verdict).toMatchObject({ state: 'pass' });
    expect(r.provenance!.evidence).toMatchObject({ carried: expect.arrayContaining(['tool_calls']), toolCalls: 0 });
  });
});

describe('a field the capture source declared and the trace left out', () => {
  it('makes the verdict not checked, and says so to the operator: the record has a hole, the agent has nothing to send', async () => {
    const r = await shipped.evaluateAll(harness());
    expect(r.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
    expect(sentences(r)).toContain(
      '[block/operator] Not checked, which is not a pass: iris-eval-capture 0.20.0 declares it records tool_calls in full, and this trace does not carry it in full. The record is incomplete: check how iris-eval-capture 0.20.0 records tool_calls.',
    );
  });

  it('holds for the input, and for a call whose result the record lost', async () => {
    const noInput = await shipped.evaluateAll({ output: ASK.output, toolCalls: [], recordedBy: 'harness', capture: HOOK });
    expect(noInput.verdict).toMatchObject({ state: 'unknown', by: ['input'] });
    const lostResult = await shipped.evaluateAll(harness({ toolCalls: [{ tool_name: 'read_file', input: { path: 'a.txt' } }] }));
    expect(lostResult.verdict).toMatchObject({ state: 'unknown', by: ['tool_outputs'] });
  });

  it('a blank result is what the tool returned, and a record with no call lost no result', async () => {
    const blank = await shipped.evaluateAll(harness({ toolCalls: [{ tool_name: 'grep', input: { pattern: 'x' }, output: '' }] }));
    expect(blank.verdict!.state).toBe('pass');
    expect(blank.provenance!.evidence!.carried).toContain('tool_outputs');
    // Outputs declared, calls not: a turn with no call in it is whole.
    const noCalls = await shipped.evaluateAll(harness({}, { name: 'outputs-only', complete: ['tool_outputs'] }));
    expect(noCalls.verdict!.state).toBe('pass');
    expect(brokenOf(noCalls.provenance!.evidence)).toEqual([]);
  });

  it('never softens a failure: a leaked credential still fails, and the hole is said beside it', async () => {
    const r = await shipped.evaluateAll(harness({ output: 'Done. The key is AKIAIOSFODNN7EXAMPLE and the secret is wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY.' }));
    expect(r.verdict!.state).toBe('fail');
    expect(r.verdict!.also).toContainEqual({ basis: 'required_evidence_missing', state: 'unknown', by: ['tool_calls'] });
    expect(sentences(r).some((s) => s.startsWith('[block/operator] Also not checked: iris-eval-capture 0.20.0 declares it records tool_calls in full'))).toBe(true);
  });

  it('leaves every bundle not checked, as evidence the deployment requires does', async () => {
    const r = await shipped.evaluateAll(harness());
    for (const row of Object.values(r.categories ?? {})) expect(row.state).toBe('unknown');
  });
});

describe('required evidence is met by what the call carried', () => {
  it('a cost that was sent meets a requirement for cost on a call that ran only the safety bundle', async () => {
    const requiresCost = engine({ requiredEvidence: ['cost'] });
    const sent = await requiresCost.evaluate('safety', { ...ASK, costUsd: 0.01 });
    expect(sent.verdict).toMatchObject({ state: 'pass' });
    const missing = await requiresCost.evaluate('safety', { ...ASK });
    expect(missing.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['cost'] });
  });

  it('a row stored before the evidence record reads as it always did: met only by what an evaluated rule read', async () => {
    const requiresCost = engine({ requiredEvidence: ['cost'] });
    const r = await requiresCost.evaluate('safety', { ...ASK, costUsd: 0.01 });
    const earlier = structuredClone(r);
    delete earlier.provenance!.evidence;
    const cfg = { ...DEFAULT_COMPOSE, requiredEvidence: ['cost'] as const };
    expect(compose(r, cfg).state).toBe('pass');
    expect(compose(earlier, cfg)).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['cost'] });
  });
});

describe('who recorded the evidence', () => {
  it('a stored trace: the agent when it came through log_trace, the capture source that declared itself, else nobody said', () => {
    expect(recordOfTrace({ source: 'tool' })).toEqual({ recordedBy: 'agent' });
    // A declaration on a trace the agent logged is never honoured, however it got there.
    expect(recordOfTrace({ source: 'tool', capture: HOOK })).toEqual({ recordedBy: 'agent' });
    expect(recordOfTrace({ source: 'hook', capture: HOOK })).toEqual({ recordedBy: 'harness', capture: HOOK });
    expect(recordOfTrace({ source: 'http' })).toEqual({ recordedBy: 'not_declared' });
    expect(recordOfTrace({})).toEqual({ recordedBy: 'not_declared' });
  });

  it('only a capture source can make an empty value evidence: the agent declaring completeness is not read', () => {
    const agent = { ...ASK, toolCalls: [], recordedBy: 'agent' as const, capture: HOOK };
    expect(inputsPresent(agent).has('tool_calls')).toBe(false);
    expect(evidenceOf(agent)).toEqual({ recordedBy: 'agent', carried: ['input', 'output'] });
  });

  it('a declaration is stored in one form: each field once, in order, and no empty list', () => {
    expect(canonicalCapture({ name: 'x', complete: ['tool_outputs', 'input', 'tool_outputs'] })).toEqual({ name: 'x', complete: ['input', 'tool_outputs'] });
    expect(canonicalCapture({ name: 'x', version: '1', complete: [] })).toEqual({ name: 'x', version: '1' });
  });
});

describe('stored and read back', () => {
  const stores: SqliteAdapter[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.close();
  });
  async function store(): Promise<SqliteAdapter> {
    const s = new SqliteAdapter(':memory:');
    await s.initialize();
    stores.push(s);
    return s;
  }

  it('a trace keeps its declaration; a trace the agent logged never stores one', async () => {
    const s = await store();
    await s.insertTrace(LOCAL_TENANT, { trace_id: 'a'.repeat(32), agent_name: 'claude-code', output: 'x', timestamp: '2026-10-03T00:00:00.000Z', source: 'hook', capture: HOOK });
    await s.insertTrace(LOCAL_TENANT, { trace_id: 'b'.repeat(32), agent_name: 'bot', output: 'x', timestamp: '2026-10-03T00:00:00.000Z', source: 'tool', capture: HOOK });
    expect((await s.getTrace(LOCAL_TENANT, 'a'.repeat(32)))?.capture).toEqual(HOOK);
    expect((await s.getTrace(LOCAL_TENANT, 'b'.repeat(32)))?.capture).toBeUndefined();
  });

  it('an evaluation reads back with the verdict, the coverage and the record it was given', async () => {
    const s = await store();
    for (const [id, context] of [
      ['none-made', harness({ toolCalls: [] })],
      ['hole', harness()],
    ] as const) {
      const given = await requiresCalls.evaluateAll(context);
      await s.insertEvalResult(LOCAL_TENANT, { ...given, id });
      const read = (await s.getEvalById(LOCAL_TENANT, id))!;
      expect(read.verdict).toMatchObject({ state: given.verdict!.state, basis: given.verdict!.basis, by: given.verdict!.by });
      expect(read.provenance!.evidence).toEqual(given.provenance!.evidence);
      expect(question(read, 'tool_use_correct')).toEqual(question(given, 'tool_use_correct'));
      expect(read.interpretations).toEqual(given.interpretations);
    }
  });
});
