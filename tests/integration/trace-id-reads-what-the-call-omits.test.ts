/*
 * evaluate_output with a trace_id reads what the call omits from the trace.
 *
 * The output, the tool calls, the catalogue and the cost always were. The
 * ask and the token usage were read only when the call scored the record (a
 * trace_id and nothing else), so the call the tool points to for a narrower
 * run narrowed it further than it said. On a stored trace:
 *
 *   { trace_id, eval_type: "relevance" }  -> 0 rules, 4 skipped on
 *                                            "context.input not provided",
 *                                            passed false, basis no_rules
 *   { trace_id, eval_type: "cost" }       -> verbosity_ratio skipped over
 *                                            token counts the trace held
 *   { trace_id, output: "<another>" }     -> not read against the stored ask
 *
 * Through the real server over MCP, on a store and a rule file of its own.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createCustomRuleStore } from '../../src/custom-rule-store.js';
import { createIrisServer } from '../../src/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';
import { verdictOfRecord } from '../../src/eval/of-record.js';

const ASK = 'What is the refund policy for annual plans, and how long does a refund take?';
const OFF_TOPIC = 'Bananas are a good source of potassium. They ripen faster in a paper bag.';
const ON_TOPIC = 'Annual plans are refundable within 30 days of purchase, and a refund takes 5 to 7 business days to reach the card.';
const TOKENS = { prompt_tokens: 200, completion_tokens: 4000, total_tokens: 4200 };

let client: Client;
let storage: SqliteAdapter;
let home: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'iris-trace-id-omits-'));
  storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const rules = createCustomRuleStore({ pathFor: () => join(home, 'custom-rules.json'), auditPath: join(home, 'audit.log') });
  const { mcpServer } = createIrisServer(defaultConfig, storage, rules, { warn: () => undefined });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(s);
  client = new Client({ name: 'trace-id-omits', version: '0.1.0' });
  await client.connect(c);
});
afterEach(async () => {
  await client.close();
  await storage.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Row {
  ruleName: string;
  passed: boolean;
  skipped?: boolean;
  skipReason?: string;
  message: string;
}
interface Body {
  trace_id?: string;
  reference_trace_id?: string;
  score: number;
  passed: boolean;
  verdict: { state: string; basis: string };
  rule_results: Row[];
  rules_evaluated: number;
  rules_skipped: number;
  provenance?: { beside?: string[] };
}
async function call(name: string, args: Record<string, unknown>): Promise<Body> {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: Body };
  const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
  if (res.isError === true) throw new Error(text);
  return res.structuredContent ?? (JSON.parse(text) as Body);
}
const row = (body: Body, name: string): Row => {
  const found = body.rule_results.find((r) => r.ruleName === name);
  if (!found) throw new Error(`no ${name} row`);
  return found;
};
/** Which rules judged, and how: what two evaluations of the same evidence must agree on. */
const judged = (body: Body): string[] => body.rule_results.filter((r) => r.skipped !== true).map((r) => `${r.ruleName}:${r.passed ? 'pass' : 'fail'}`);

async function stored(fields: Record<string, unknown> = {}): Promise<string> {
  const logged = await call('log_trace', {
    agent_name: 'support-agent',
    input: ASK,
    output: OFF_TOPIC,
    tool_calls: [{ tool_name: 'kb_search', input: { query: 'refund policy annual' }, output: 'Annual plans are refundable within 30 days. Refunds take 5 to 7 business days.' }],
    token_usage: TOKENS,
    cost_usd: 0.02,
    ...fields,
  });
  return logged.trace_id as string;
}

describe('evaluate_output with a trace_id and one bundle', () => {
  it('relevance judges the stored output against the stored ask', async () => {
    const id = await stored();
    const narrowed = await call('evaluate_output', { trace_id: id, eval_type: 'relevance' });
    expect(row(narrowed, 'keyword_overlap').skipped).not.toBe(true);
    expect(row(narrowed, 'answers_the_ask').skipped).not.toBe(true);
    expect(row(narrowed, 'answers_the_ask')).toMatchObject({ passed: false });
    expect(narrowed.rules_evaluated).toBe(3);
    expect(narrowed.verdict.basis).not.toBe('no_rules');
    // The same answer as a call that sends the stored ask again.
    const resent = await call('evaluate_output', { trace_id: id, eval_type: 'relevance', input: ASK });
    expect(judged(narrowed)).toEqual(judged(resent));
    expect(narrowed.score).toBe(resent.score);
  });

  it('cost judges the stored token usage', async () => {
    const id = await stored();
    const narrowed = await call('evaluate_output', { trace_id: id, eval_type: 'cost' });
    expect(row(narrowed, 'verbosity_ratio')).toMatchObject({ passed: false });
    expect(row(narrowed, 'verbosity_ratio').skipped).not.toBe(true);
    const resent = await call('evaluate_output', { trace_id: id, eval_type: 'cost', token_usage: TOKENS });
    expect(judged(narrowed)).toEqual(judged(resent));
    expect(narrowed.score).toBe(resent.score);
  });

  it('safety grounds its signals in the stored ask, as it does when the ask is sent', async () => {
    const id = await stored();
    const narrowed = await call('evaluate_output', { trace_id: id, eval_type: 'safety' });
    const resent = await call('evaluate_output', { trace_id: id, eval_type: 'safety', input: ASK });
    expect(row(narrowed, 'no_hallucination_markers').message).toBe(row(resent, 'no_hallucination_markers').message);
    expect(row(narrowed, 'no_hallucination_markers').message).toContain('against the provided input context');
  });

  it('is kept beside the trace, and the trace\'s own verdict does not change', async () => {
    const id = await stored({ evaluate: true });
    const before = verdictOfRecord(await storage.getEvalsByTraceId(LOCAL_TENANT, id));
    const narrowed = await call('evaluate_output', { trace_id: id, eval_type: 'relevance' });
    expect(narrowed.trace_id).toBeUndefined();
    expect(narrowed.reference_trace_id).toBe(id);
    expect(narrowed.provenance?.beside).toEqual(['eval_type']);
    const after = verdictOfRecord(await storage.getEvalsByTraceId(LOCAL_TENANT, id));
    expect(after?.id).toBe(before?.id);
  });
});

describe('evaluate_output with a trace_id and another output', () => {
  it('reads the other output against the stored ask and the stored token usage', async () => {
    const id = await stored();
    const other = await call('evaluate_output', { trace_id: id, output: ON_TOPIC });
    expect(other.reference_trace_id).toBe(id);
    expect(other.provenance?.beside).toEqual(['output']);
    expect(row(other, 'keyword_overlap')).toMatchObject({ passed: true });
    expect(row(other, 'answers_the_ask')).toMatchObject({ passed: true });
    expect(row(other, 'verbosity_ratio').skipped).not.toBe(true);
    const resent = await call('evaluate_output', { trace_id: id, output: ON_TOPIC, input: ASK, token_usage: TOKENS });
    expect(judged(other)).toEqual(judged(resent));
  });
});

describe('what the call passes is what is judged', () => {
  it('an ask of the call\'s own is read in place of the stored one', async () => {
    const id = await stored();
    const own = await call('evaluate_output', { trace_id: id, eval_type: 'relevance', input: 'Which fruit is a good source of potassium, and how do bananas ripen faster?' });
    expect(own.provenance?.beside).toEqual(['input', 'eval_type']);
    expect(row(own, 'keyword_overlap')).toMatchObject({ passed: true });
  });

  it('token usage of the call\'s own is read in place of the stored one', async () => {
    const id = await stored();
    const own = await call('evaluate_output', { trace_id: id, eval_type: 'cost', token_usage: { prompt_tokens: 4000, completion_tokens: 200, total_tokens: 4200 } });
    expect(own.provenance?.beside).toEqual(['token_usage', 'eval_type']);
    expect(row(own, 'verbosity_ratio')).toMatchObject({ passed: true });
  });

  it('a trace that stored no ask and no token usage leaves those rules skipped, as before', async () => {
    const logged = await call('log_trace', { agent_name: 'support-agent', output: OFF_TOPIC, cost_usd: 0.02 });
    const id = logged.trace_id as string;
    const relevance = await call('evaluate_output', { trace_id: id, eval_type: 'relevance' });
    expect(relevance.rules_evaluated).toBe(0);
    expect(row(relevance, 'keyword_overlap')).toMatchObject({ skipped: true, skipReason: 'context.input not provided' });
    const cost = await call('evaluate_output', { trace_id: id, eval_type: 'cost' });
    expect(row(cost, 'verbosity_ratio')).toMatchObject({ skipped: true, skipReason: 'context.tokenUsage not provided' });
  });

  it('scoring the record reads the same evidence as before, and its result is the trace\'s verdict', async () => {
    const id = await stored();
    const record = await call('evaluate_output', { trace_id: id });
    expect(record.trace_id).toBe(id);
    expect(record.reference_trace_id).toBeUndefined();
    expect(row(record, 'keyword_overlap').skipped).not.toBe(true);
    // A skipped row reads passed: false as well, so the row is held to having judged.
    expect(row(record, 'verbosity_ratio').skipped).not.toBe(true);
    expect(row(record, 'verbosity_ratio')).toMatchObject({ passed: false });
  });
});
