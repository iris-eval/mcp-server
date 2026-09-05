/*
 * Evidence is locatable, never an excerpt, and points at the right bytes.
 *
 * Arc zero (2026-09-05) found that every rule's evidence was its message —
 * offsets computed inside the rules never left them, so a leak detector
 * could not redact the span it found and nothing could programmatically
 * locate what fired. Now a detection reports offsets into the raw output,
 * a trajectory rule the index of the call it judged, a measurement its
 * statistic with a unit and threshold. Two anchors:
 *
 *   1. Real transcripts through the real handler: the SSN transcript's
 *      no_pii spans slice to SSN-shaped text; the silent-grep transcript's
 *      no_silent_tool_failure names call 0; the loop transcript's
 *      no_tool_loop names the repeated calls and the count it was held to;
 *      the hidden-comment transcript's injection span is inside the output.
 *   2. The proof corpus, rule by rule: for every positive case of the
 *      detection families, every span is inside the output, non-empty, and
 *      (for no_pii) matches the pattern its label names — the property the
 *      plan calls E2. Nothing about pass/fail moves: `npm run proof --
 *      --check` is the other half of that assertion.
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
import { PII_PATTERNS } from '../../../src/eval/rules/safety.js';
import { evaluateOutputResponseSchema, type EvaluateOutputResponse } from '../../../src/eval/response-schema.js';
import type { EvalRule, EvalRuleResult, Evidence } from '../../../src/types/eval.js';
import { loadCorpus } from '../../../proof/lib/corpus.js';
import { materialiseCase } from '../../../proof/lib/materialise.js';
import { contextFor } from '../../../proof/run.js';

const root = resolve(__dirname, '..', '..', '..');
const FIXTURES = resolve(root, 'tests', 'fixtures', 'real-transcripts');

interface Transcript {
  input: string;
  output: string;
  tool_calls: Array<{ tool_name: string; input?: unknown; output?: unknown; error?: string }>;
  token_usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  cost_usd?: number;
}
const load = (name: string): Transcript => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf-8')) as Transcript;
const t07 = load('t-07-support-ticket-ssn.json');
const t13 = load('t-13-grep-no-match.json');
const t16 = load('t-16-ls-loop.json');
const t24 = load('t-24-hidden-html-comment.json');

const spans = (r: { evidence?: Evidence[] } | undefined): Array<Extract<Evidence, { type: 'span' }>> =>
  (r?.evidence ?? []).filter((e): e is Extract<Evidence, { type: 'span' }> => e.type === 'span');

describe('evidence — real transcripts through the real handler', () => {
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

  async function evaluate(t: Transcript): Promise<EvaluateOutputResponse> {
    const res = await client.callTool({
      name: 'evaluate_output',
      arguments: { output: t.output, input: t.input, tool_calls: t.tool_calls, cost_usd: t.cost_usd, token_usage: t.token_usage, eval_type: 'all' },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return evaluateOutputResponseSchema.parse(JSON.parse(text));
  }

  it('the SSN transcript: no_pii fires with spans that slice to what it matched, and no evidence repeats the text', async () => {
    const r = await evaluate(t07);
    const pii = r.rule_results.find((x) => x.ruleName === 'no_pii')!;
    expect(pii.passed).toBe(false);
    const s = spans(pii);
    expect(s.length).toBeGreaterThan(0);
    for (const e of s) {
      expect(e.start).toBeGreaterThanOrEqual(0);
      expect(e.end).toBeLessThanOrEqual(t07.output.length);
      expect(e.end).toBeGreaterThan(e.start);
      expect(e.source).toBe('output');
    }
    const slices = s.map((e) => t07.output.slice(e.start, e.end));
    expect(slices.some((x) => /\d{3}-\d{2}-\d{4}/.test(x)), `slices: ${JSON.stringify(slices)}`).toBe(true);
    // The evidence carries labels and offsets only — never the matched text.
    expect(JSON.stringify(pii.evidence)).not.toMatch(/\d{3}-\d{2}-\d{4}/);
  });

  it('the silent-grep transcript: no_silent_tool_failure names the failed call by index', async () => {
    const r = await evaluate(t13);
    const silent = r.rule_results.find((x) => x.ruleName === 'no_silent_tool_failure')!;
    expect(silent.passed).toBe(false);
    const calls = (silent.evidence ?? []).filter((e) => e.type === 'toolCall');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ type: 'toolCall', index: 0, toolName: t13.tool_calls[0].tool_name });
    expect((calls[0] as { label: string }).label).toMatch(/^failed: .*unacknowledged/);
    expect(silent.value).toEqual({ stat: 'failed_calls', unit: 'calls', value: 1 });
  });

  it('the loop transcript: no_tool_loop names every repeated call and the count it was held to', async () => {
    const r = await evaluate(t16);
    const loop = r.rule_results.find((x) => x.ruleName === 'no_tool_loop')!;
    expect(loop.passed).toBe(false);
    const count = (loop.evidence ?? []).find((e) => e.type === 'count') as Extract<Evidence, { type: 'count' }> | undefined;
    expect(count).toBeDefined();
    expect(count!.value).toBeGreaterThan(count!.threshold!);
    expect(count!.thresholdSource).toBe('default');
    const calls = (loop.evidence ?? []).filter((e) => e.type === 'toolCall');
    expect(calls.length).toBe(count!.value);
    expect(loop.value).toEqual({ stat: 'max_repeats_of_one_call', unit: 'calls', value: count!.value });
  });

  it('the hidden-comment transcript: the injection span sits inside the output and is labelled by tier', async () => {
    const r = await evaluate(t24);
    const inj = r.rule_results.find((x) => x.ruleName === 'no_injection_patterns')!;
    expect(inj.passed).toBe(false);
    const s = spans(inj);
    expect(s.length).toBeGreaterThan(0);
    for (const e of s) {
      expect(e.end).toBeLessThanOrEqual(t24.output.length);
      expect(t24.output.slice(e.start, e.end).length).toBeGreaterThan(0);
      expect(e.label).toMatch(/^injection (phrase|structure) #\d+$/);
    }
  });

  it('every measurement carries its statistic with a unit and the threshold it was held to', async () => {
    const r = await evaluate(t13);
    for (const name of ['min_output_length', 'sentence_count', 'keyword_overlap', 'topic_consistency', 'token_efficiency', 'cost_under_threshold']) {
      const x = r.rule_results.find((y) => y.ruleName === name)!;
      expect(x.skipped, name).toBeFalsy();
      expect(x.value, `${name}.value`).toBeDefined();
      expect(x.value!.unit.length).toBeGreaterThan(0);
      const count = (x.evidence ?? []).find((e) => e.type === 'count') as Extract<Evidence, { type: 'count' }> | undefined;
      expect(count, `${name} count evidence`).toBeDefined();
      expect(count!.threshold, `${name} threshold`).toBeDefined();
      expect(['default', 'config', 'rule']).toContain(count!.thresholdSource);
    }
  });
});

describe('evidence — the proof corpus, rule by rule (E2: spans index the raw text)', () => {
  const byName = new Map<string, EvalRule>((['completeness', 'relevance', 'safety', 'cost'] as const).flatMap((t) => rulesByType[t]).map((r) => [r.name, r]));
  const piiPatternByName = new Map(PII_PATTERNS.map((p) => [p.name, p.pattern]));

  it('every fired detection on every positive corpus case reports spans that are inside the output, non-empty, and labelled', async () => {
    const { files } = await loadCorpus(root);
    let checked = 0;
    for (const file of files) {
      if (!['no_pii', 'no_injection_patterns', 'no_stub_output', 'no_blocklist_words'].includes(file.rule)) continue;
      const rule = byName.get(file.rule)!;
      for (const raw of file.cases) {
        if (raw.label !== 'positive') continue;
        const c = materialiseCase(raw);
        const result = rule.evaluate(contextFor(c, file.config));
        if (result.skipped || result.passed) continue; // the proof reports misses; this test is about what fires
        expect(result.evidence, `${file.rule} ${c.id} fired without evidence`).toBeDefined();
        expect(result.evidence!.length).toBeGreaterThan(0);
        for (const e of result.evidence!) {
          if (e.type !== 'span') continue;
          expect(e.start, `${file.rule} ${c.id}`).toBeGreaterThanOrEqual(0);
          expect(e.end, `${file.rule} ${c.id}`).toBeLessThanOrEqual(c.output.length);
          const slice = c.output.slice(e.start, e.end);
          expect(slice.length, `${file.rule} ${c.id} empty span`).toBeGreaterThan(0);
          if (file.rule === 'no_pii') {
            const pattern = piiPatternByName.get(e.label);
            expect(pattern, `${c.id}: no PII pattern named ${e.label}`).toBeDefined();
            expect(new RegExp(pattern!.source, pattern!.flags.replace('g', '')).test(slice), `${c.id}: span "${e.label}" does not match its pattern`).toBe(true);
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(30);
  });
});
