/*
 * A trace's verdict cannot be replaced by the agent it judges.
 *
 * Every reader of "a trace's verdict" takes the newest evaluation carrying
 * the trace's id, and every evaluation a caller linked to a trace used to
 * carry it, whatever was judged. So, over the MCP tools:
 *
 *   log_trace (an SSN in the output, evaluate: true)  -> fail, detector_veto
 *   evaluate_output (the same trace_id, clean text)   -> pass, clean
 *   compare_runs / the run's results                  -> that trace PASSED
 *
 * with no flag anywhere. The same worked with the leaking text and one
 * bundle (`eval_type: "cost"`), and with an empty `tool_calls`.
 *
 * The verdict of a trace is now only the server's own scoring of the trace
 * as stored. Anything else is kept beside it (`reference_trace_id`), listed
 * with it, and is never its verdict (src/eval/of-record.ts, migration 020).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import { verdictOfRecord } from '../../src/eval/of-record.js';
import { traceEncoder } from '../../src/export/format.js';

const LEAK = 'The reporter is Marisol Quintero, SSN 123-45-6789, and her card ending 4242 was charged twice.';
const CLEAN = 'The reporter was charged twice for one order. The duplicate charge is refunded and she has been told.';

let client: Client;
let storage: SqliteAdapter;

beforeEach(async () => {
  storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const { mcpServer } = createIrisServer(defaultConfig, storage);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(s);
  client = new Client({ name: 'verdict-of-record', version: '0.1.0' });
  await client.connect(c);
});
afterEach(async () => {
  await client.close();
  await storage.close();
});

type Body = Record<string, unknown> & { verdict?: { state: string; basis: string }; interpretations?: Array<{ text: string; severity: string }> };
async function call(name: string, args: Record<string, unknown>): Promise<{ body: Body; isError: boolean }> {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: Body };
  const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
  let body: Body;
  try {
    body = res.structuredContent ?? (JSON.parse(text) as Body);
  } catch {
    body = { text } as Body;
  }
  return { body, isError: res.isError === true };
}

/** A failing trace in a run, as an agent logs it. */
async function failingTrace(extra: Record<string, unknown> = {}): Promise<string> {
  const { body } = await call('log_trace', {
    agent_name: 'support-bot',
    input: 'Summarise the ticket for the customer.',
    output: LEAK,
    run: 'nightly-1',
    case_key: 'refund',
    evaluate: true,
    ...extra,
  });
  const evaluation = body.evaluation as Body;
  expect(evaluation.verdict).toMatchObject({ state: 'fail', basis: 'detector_veto' });
  return body.trace_id as string;
}

/** What every reader of the trace's verdict sees. */
async function verdictReaders(traceId: string) {
  const run = await storage.getRunResults(LOCAL_TENANT, 'nightly-1');
  const inRun = run.find((r) => r.traceId === traceId);
  const cases = await storage.getCaseResults(LOCAL_TENANT, { caseKey: 'refund' });
  const all = await storage.getEvalsByTraceId(LOCAL_TENANT, traceId);
  const record = (await storage.queryTraces(LOCAL_TENANT, { limit: 10 })).traces.find((t) => t.trace_id === traceId)!;
  const enc = traceEncoder('jsonl');
  const exported = JSON.parse(enc.batch([{ trace: record, spans: [], evals: all }]).trim()) as { evals: Array<{ id: string }> };
  return { inRun, cases, all, ofRecord: verdictOfRecord(all), exported };
}

describe('evaluate_output cannot replace a trace\'s verdict', () => {
  it('different text against the trace is kept beside it: the run, the case and the export still read the failure', async () => {
    const traceId = await failingTrace();
    const { body, isError } = await call('evaluate_output', { output: CLEAN, trace_id: traceId });
    expect(isError).toBe(false);
    // The call is answered: the clean text does pass. It is just not the trace's verdict.
    expect(body.verdict?.state).toBe('pass');
    expect(body).not.toHaveProperty('trace_id');
    expect(body.reference_trace_id).toBe(traceId);
    const note = body.interpretations?.find((i) => i.text.includes('not the verdict of the trace'));
    expect(note, 'the response says so').toBeDefined();
    expect(note!.text).toContain('`output`');
    expect((body.provenance as { beside?: string[] }).beside).toEqual(['output']);

    const seen = await verdictReaders(traceId);
    expect(seen.inRun?.passed, 'the run still counts the trace as failed').toBe(false);
    expect(seen.inRun?.failedRules).toContain('no_pii');
    expect(seen.cases.map((c) => c.passed), 'the case has one attempt, and it failed').toEqual([false]);
    expect(seen.ofRecord?.passed).toBe(false);
    // Listed with the trace, as what it is.
    expect(seen.all).toHaveLength(2);
    expect(seen.all.filter((e) => e.reference_trace_id === traceId)).toHaveLength(1);
  });

  it('the same text and one bundle is kept beside it too: a narrowed evaluation is not the trace\'s verdict', async () => {
    const traceId = await failingTrace({ cost_usd: 0.01 });
    const { body } = await call('evaluate_output', { output: LEAK, trace_id: traceId, eval_type: 'cost' });
    expect(body.verdict?.state).toBe('pass');
    expect(body.reference_trace_id).toBe(traceId);
    expect((body.provenance as { beside?: string[] }).beside).toEqual(['eval_type']);
    expect((await verdictReaders(traceId)).inRun?.passed).toBe(false);
  });

  it('withholding the tool calls the trace stored is kept beside it', async () => {
    const calls = [{ tool_name: 'grep', input: { pattern: 'refund' }, error: 'ripgrep: permission denied' }];
    const { body: logged } = await call('log_trace', {
      agent_name: 'support-bot',
      input: 'Find the refund policy and summarise it.',
      output: 'I searched the repository and the refund policy allows a refund within thirty days of purchase.',
      tool_calls: calls,
      run: 'nightly-1',
      case_key: 'policy',
      evaluate: true,
    });
    const traceId = logged.trace_id as string;
    const before = (await storage.getEvalsByTraceId(LOCAL_TENANT, traceId))[0];
    const { body } = await call('evaluate_output', { trace_id: traceId, tool_calls: [] });
    expect(body.reference_trace_id).toBe(traceId);
    expect((body.provenance as { beside?: string[] }).beside).toEqual(['tool_calls']);
    expect(verdictOfRecord(await storage.getEvalsByTraceId(LOCAL_TENANT, traceId))?.id).toBe(before.id);
  });

  it('naming the trace and nothing else scores the record, and that IS the trace\'s verdict', async () => {
    const traceId = await failingTrace();
    const { body, isError } = await call('evaluate_output', { trace_id: traceId });
    expect(isError).toBe(false);
    expect(body.trace_id).toBe(traceId);
    expect(body).not.toHaveProperty('reference_trace_id');
    expect(body.verdict).toMatchObject({ state: 'fail', basis: 'detector_veto' });
    // The stored ask was read too: the relevance question is judged, as it is at ingest.
    const questions = (body.coverage as { questions: Array<{ id: string; status: string }> }).questions;
    expect(questions.find((q) => q.id === 'relevant')?.status).toBe('judged');
    const seen = await verdictReaders(traceId);
    expect(seen.ofRecord?.id).toBe(body.id);
    expect(seen.inRun?.evalId).toBe(body.id);
  });

  it('passing the stored values back changes nothing: it is still the record', async () => {
    const traceId = await failingTrace();
    const { body } = await call('evaluate_output', { trace_id: traceId, output: LEAK, input: 'Summarise the ticket for the customer.', eval_type: 'all' });
    expect(body.trace_id).toBe(traceId);
    expect(body).not.toHaveProperty('reference_trace_id');
  });

  it('a trace that recorded no output has no verdict to give: with text it is kept beside, without text it is refused', async () => {
    const { body: logged } = await call('log_trace', { agent_name: 'support-bot', input: 'What is the refund window?' });
    const traceId = logged.trace_id as string;
    const withText = await call('evaluate_output', { trace_id: traceId, output: CLEAN });
    expect(withText.body.reference_trace_id).toBe(traceId);
    expect((withText.body.provenance as { beside?: string[] }).beside).toEqual(['no_stored_output']);
    const bare = await call('evaluate_output', { trace_id: traceId });
    expect(bare.isError).toBe(true);
    expect(JSON.stringify(bare.body)).toContain('recorded no output');
  });

  it('neither output nor a trace is refused, naming what to pass', async () => {
    const { body, isError } = await call('evaluate_output', {});
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).toContain('needs output, or a trace_id');
  });

  it('an evaluation with no trace is unchanged', async () => {
    const { body } = await call('evaluate_output', { output: CLEAN });
    expect(body).not.toHaveProperty('trace_id');
    expect(body).not.toHaveProperty('reference_trace_id');
    expect(body.interpretations?.some((i) => i.text.includes('not the verdict of the trace')) ?? false).toBe(false);
  });
});

describe('what is kept beside a trace', () => {
  it('reads back with its sentence, from the stored row', async () => {
    const traceId = await failingTrace();
    const { body } = await call('evaluate_output', { output: CLEAN, trace_id: traceId });
    const stored = await client.readResource({ uri: `iris://evaluations/${String(body.id)}` });
    const read = JSON.parse((stored.contents[0] as { text: string }).text) as Body;
    expect(read.reference_trace_id).toBe(traceId);
    expect(read).not.toHaveProperty('trace_id');
    expect(read.interpretations?.some((i) => i.text.includes('not the verdict of the trace'))).toBe(true);
    // And under the trace, beside its verdict.
    const trace = await client.readResource({ uri: `iris://traces/${traceId}` });
    const evals = (JSON.parse((trace.contents[0] as { text: string }).text) as { evals: Body[] }).evals;
    expect(evals.map((e) => (e.trace_id ? 'verdict' : 'beside')).sort()).toEqual(['beside', 'verdict']);
  });

  it('is erased with the trace: deleting the trace leaves none of its text', async () => {
    const traceId = await failingTrace();
    const { body } = await call('evaluate_output', { output: `${CLEAN} Her SSN is 123-45-6789.`, trace_id: traceId });
    expect(await storage.deleteTrace(LOCAL_TENANT, traceId)).toBe(true);
    const row = await storage.getEvalById(LOCAL_TENANT, String(body.id));
    expect(row?.output_text).toBe('');
    expect(row?.erased_at).toBeDefined();
    expect(JSON.stringify(row)).not.toContain('123-45-6789');
  });
});
