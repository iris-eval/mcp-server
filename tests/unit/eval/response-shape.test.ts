/*
 * The response-shape drift-lock.
 *
 * Runs the REAL evaluate_output handler over an in-memory MCP transport on a
 * real agent transcript and validates what comes back against
 * src/eval/response-schema.ts — the one zod object that is the response.
 * Then it asserts the promise of the 0.9.0 release: every built-in rule
 * result carries what kind of claim it makes, what the composer did with
 * it, what it saw, and how wrong it tends to be; a skipped rule says whether
 * it was never asked or asked and could not answer; and nothing about the
 * verdict changed (the same transcript passes and fails exactly as it did).
 *
 * The indicator this moves: rule results carrying kind, evidence and
 * uncertainty, 0 of 15 → 15 of 15 (plans/iris-eval-synthetic-teacup.md §16).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../../src/server.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { rulesByType } from '../../../src/eval/rules/index.js';
import { evaluateOutputResponseSchema, type EvaluateOutputResponse } from '../../../src/eval/response-schema.js';
import { publishedRuleNames } from '../../../src/eval/accuracy.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const root = resolve(__dirname, '..', '..', '..');
const BUILT_INS = (['completeness', 'relevance', 'safety', 'cost'] as const).flatMap((t) => rulesByType[t].map((r) => r.name));

interface Transcript {
  input: string;
  output: string;
  tool_calls: Array<{ tool_name: string; input?: unknown; output?: unknown; error?: string }>;
  token_usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  cost_usd: number;
}
const t13 = JSON.parse(readFileSync(resolve(root, 'tests', 'fixtures', 'real-transcripts', 't-13-grep-no-match.json'), 'utf-8')) as Transcript;

describe('response shape — every built-in result carries its receipt', () => {
  let client: Client;
  let storage: SqliteAdapter;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const { mcpServer } = createIrisServer(defaultConfig, storage);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    await client.connect(clientTransport);
  });
  afterEach(async () => {
    await client.close();
    await storage.close();
  });

  async function evaluate(args: Record<string, unknown>): Promise<EvaluateOutputResponse> {
    const res = await client.callTool({ name: 'evaluate_output', arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = evaluateOutputResponseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`response does not match src/eval/response-schema.ts: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
    return parsed.data;
  }

  it('a rich call (input, tool calls, cost, tokens) stamps kind, role, question, saw, ruleVersion and uncertainty on 15 of 15', async () => {
    const r = await evaluate({
      output: t13.output,
      input: t13.input,
      tool_calls: t13.tool_calls,
      cost_usd: t13.cost_usd,
      token_usage: t13.token_usage,
      eval_type: 'all',
    });
    const byName = new Map(r.rule_results.map((x) => [x.ruleName, x]));
    for (const name of BUILT_INS) {
      const x = byName.get(name);
      expect(x, `${name} missing from rule_results`).toBeDefined();
      expect(x!.kind, `${name}.kind`).toBeDefined();
      expect(['veto', 'term'], `${name}.role`).toContain(x!.role);
      expect(x!.question, `${name}.question`).toBeDefined();
      expect(x!.ruleVersion, `${name}.ruleVersion`).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(x!.saw), `${name}.saw`).toBe(true);
      expect(x!.saw!.length, `${name} saw nothing`).toBeGreaterThan(0);
      if (!x!.skipped) expect(x!.uncertainty, `${name}.uncertainty`).toBeDefined();
    }
    // The stamp changes no verdict: the silent grep failure is caught, the SSN rule is quiet.
    expect(byName.get('no_silent_tool_failure')!.passed).toBe(false);
    expect(byName.get('no_pii')!.passed).toBe(true);
    // The whole-evaluation receipt: verdict with its basis, coverage by question, provenance.
    expect(r.verdict).toBeDefined();
    expect(r.verdict!.passed).toBe(r.passed);
    // Every basis the composer can reach. score_below_threshold belongs to
    // the legacy composer and stays in the list while that path is selectable.
    expect([
      'clean',
      'score_below_threshold',
      'detector_veto',
      'policy_gate',
      'no_rules',
      'risk_over_loss',
      'critical_unknown',
      'required_evidence_missing',
    ]).toContain(r.verdict!.basis);
    expect(r.coverage!.questions.find((q) => q.id === 'tool_use_correct')!.status).toBe('judged');
    expect(r.coverage!.inputs).toMatchObject({ output: true, input: true, tool_calls: true, cost: true, tokens: true });
    expect(r.provenance!.irisVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.provenance!.thresholds.default).toBe(defaultConfig.eval.defaultThreshold);
  });

  it('trace_id is echoed on the response when the evaluation was linked', async () => {
    const logged = await client.callTool({ name: 'log_trace', arguments: { agent_name: 'echo-test', input: t13.input, output: t13.output } });
    const { trace_id } = JSON.parse((logged.content as Array<{ type: string; text: string }>)[0].text) as { trace_id: string };
    const r = await evaluate({ output: t13.output, eval_type: 'safety', trace_id });
    expect(r.trace_id).toBe(trace_id);
    const unlinked = await evaluate({ output: t13.output, eval_type: 'safety' });
    expect(unlinked.trace_id).toBeUndefined();
  });

  it('a fired detection or inference carries the published PPV interval with its provenance; a quiet one carries the miss rate', async () => {
    const r = await evaluate({ output: t13.output, input: t13.input, tool_calls: t13.tool_calls, eval_type: 'all' });
    const fired = r.rule_results.find((x) => x.ruleName === 'no_silent_tool_failure')!;
    expect(fired.uncertainty?.basis).toBe('published_accuracy');
    if (fired.uncertainty?.basis === 'published_accuracy' && fired.uncertainty.fired) {
      expect(fired.uncertainty.ppv!.lo).toBeLessThanOrEqual(fired.uncertainty.ppv!.point);
      expect(fired.uncertainty.ppv!.point).toBeLessThanOrEqual(fired.uncertainty.ppv!.hi);
      expect(fired.uncertainty.corpus.labelling).toBe('same-model');
      expect(fired.uncertainty.prior).toEqual({ pi: 0.5, source: 'default' });
      expect(publishedRuleNames()).toContain('no_silent_tool_failure');
    } else {
      throw new Error('expected a fired published_accuracy uncertainty');
    }
    const quiet = r.rule_results.find((x) => x.ruleName === 'no_pii')!;
    expect(quiet.uncertainty?.basis).toBe('published_accuracy');
    if (quiet.uncertainty?.basis === 'published_accuracy' && !quiet.uncertainty.fired) {
      expect(quiet.uncertainty.missRate!.point).toBeLessThanOrEqual(0.5);
    } else {
      throw new Error('expected a quiet published_accuracy uncertainty');
    }
    const policy = r.rule_results.find((x) => x.ruleName === 'no_blocklist_words')!;
    expect(policy.uncertainty).toEqual({ basis: 'policy' });
    const measurement = r.rule_results.find((x) => x.ruleName === 'keyword_overlap')!;
    expect(measurement.uncertainty?.basis).toBe('definition');
  });

  it('an output-only call skips the rules that need more, each saying it was never asked', async () => {
    const r = await evaluate({ output: t13.output, eval_type: 'all' });
    const byName = new Map(r.rule_results.map((x) => [x.ruleName, x]));
    for (const name of ['keyword_overlap', 'topic_consistency', 'no_silent_tool_failure', 'no_tool_loop', 'cost_under_threshold', 'verbosity_ratio', 'expected_coverage']) {
      const x = byName.get(name)!;
      expect(x.skipped, name).toBe(true);
      expect(x.skipClass, name).toBe('not_applicable');
      expect(x.uncertainty, `${name} should carry no uncertainty when it made no claim`).toBeUndefined();
      // The only input this call carried was the output; a skipped rule's `saw` cannot name anything else.
      expect((x.saw ?? []).every((need) => need === 'output'), `${name}.saw = ${JSON.stringify(x.saw)}`).toBe(true);
    }
    const noPii = byName.get('no_pii')!;
    expect(noPii.skipped).toBeFalsy();
    expect(noPii.saw).toEqual(['output']);
    expect(noPii.role).toBe('veto');
  });

  it('the stored row carries the stamp too (rule_results is persisted whole)', async () => {
    const logged = await client.callTool({ name: 'log_trace', arguments: { agent_name: 'stamp-test', input: t13.input, output: t13.output } });
    const { trace_id } = JSON.parse((logged.content as Array<{ type: string; text: string }>)[0].text) as { trace_id: string };
    await evaluate({ output: t13.output, input: t13.input, eval_type: 'safety', trace_id });
    const stored = await storage.getEvalsByTraceId(LOCAL_TENANT, trace_id);
    expect(stored.length).toBe(1);
    const pii = stored[0].rule_results.find((x) => x.ruleName === 'no_pii')!;
    expect(pii.kind).toBe('detection');
    expect(pii.role).toBe('veto');
    expect(pii.uncertainty?.basis).toBe('published_accuracy');
  });
});
