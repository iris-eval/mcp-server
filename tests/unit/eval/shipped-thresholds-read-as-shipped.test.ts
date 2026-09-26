/*
 * A shipped threshold reads as shipped, on the engine a real server builds.
 *
 * compose.decides() gates a policy only when its threshold is the
 * deployment's, and it learns that from `thresholdSource` on the rule's
 * count evidence. Four rules used to derive that stamp by comparing the
 * threshold's VALUE with the number in their own file. The shipped config
 * carries topic_consistency 0.33 where relevance.ts says 1/3, so on every
 * server built from config the stamp read "config", and answers_the_ask —
 * a policy that reads it — gated at the shipped defaults from 0.18.0 while
 * its notes said it advised. The unit tests built bare engines, which never
 * merge the shipped config, so none of them could see it.
 *
 * This test builds the engine the way the server does, from loadConfig()
 * with no config file (and from defaultConfig, which embedders use), runs
 * outputs that make every rule with a configurable threshold report one, and
 * requires every such stamp to read "default". Then it writes a config file
 * that sets each of those keys to its SHIPPED value and requires every stamp
 * to read "config": a deployment that chose the shipped number has still
 * chosen it. Provenance, never value.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../../src/config/index.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import type { EvalContext, EvalResult, IrisConfig } from '../../../src/types/index.js';

/** Calls that make every rule with a configurable threshold compute against it. */
const CALLS: EvalContext[] = [
  // Short, one sentence, off-topic: the length and sentence floors, both relevance measurements, answers_the_ask.
  { input: 'Summarize the latest quarterly report for the board meeting', output: 'The weather is 62 degrees with partly cloudy skies today in the city.' },
  // Cost, token ratio.
  { input: 'Say hello', output: 'Hello there, it is good to meet you today.', costUsd: 0.5, tokenUsage: { prompt_tokens: 10, completion_tokens: 500 } },
  // A repeated call (max_tool_repeats), a re-read target (max_target_rereads) and a step count (max_steps).
  {
    input: 'Read the config file and tell me the port',
    output: 'The port in the config file is 8080, read from settings.json after checking it twice.',
    toolCalls: [
      { tool_name: 'read_file', input: { path: 'settings.json' } },
      { tool_name: 'read_file', input: { path: 'settings.json' } },
      { tool_name: 'read_file', input: { path: 'settings.json' } },
      { tool_name: 'read_file', input: { path: 'settings.json' } },
      { tool_name: 'read_file', input: { path: 'settings.json' } },
    ],
    tools: [
      { name: 'read_file', description: 'Read a file from disk', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, annotations: { readOnlyHint: true } },
      { name: 'send_email', description: 'Send an email message to a recipient', inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } } } },
    ],
  },
  // The wrong tool for the ask (tool_choice).
  {
    input: 'Send an email to the team about the release',
    output: 'I read the release notes file for you and the release is ready to go out now.',
    toolCalls: [{ tool_name: 'read_file', input: { path: 'NOTES.md' } }],
    tools: [
      { name: 'read_file', description: 'Read a file from disk', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'send_email', description: 'Send an email message to the team or a recipient', inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } } } },
    ],
  },
];

/** Every count stamp that says whose number it is, by rule. */
async function stamps(engine: EvalEngine): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const call of CALLS) {
    const r: EvalResult = await engine.evaluateAll(call);
    for (const row of r.rule_results) {
      for (const e of row.evidence ?? []) {
        if (e.type !== 'count' || (e.thresholdSource !== 'default' && e.thresholdSource !== 'config')) continue;
        if (!out.has(row.ruleName)) out.set(row.ruleName, new Set());
        out.get(row.ruleName)!.add(e.thresholdSource);
      }
    }
  }
  return out;
}

const engineFrom = (c: IrisConfig) => new EvalEngine(c.eval.defaultThreshold, c.eval.ruleThresholds, c.eval);

/** Every rule whose threshold is configurable, and so must say whose number it compared against. */
const CONFIGURABLE = [
  'min_output_length',
  'sentence_count',
  'keyword_overlap',
  'topic_consistency',
  'answers_the_ask',
  'cost_under_threshold',
  'verbosity_ratio',
  'no_tool_loop',
  'max_steps',
  'tool_choice',
];

describe('shipped thresholds read as shipped', () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.IRIS_HOME;
    home = mkdtempSync(join(tmpdir(), 'iris-shipped-'));
    process.env.IRIS_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.IRIS_HOME;
    else process.env.IRIS_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  it('on the engine loadConfig() builds with no config file, every threshold stamp reads "default"', async () => {
    const got = await stamps(engineFrom(loadConfig()));
    expect([...got.keys()].sort()).toEqual(expect.arrayContaining(CONFIGURABLE));
    for (const [rule, sources] of got) expect([...sources], rule).toEqual(['default']);
  });

  it('on the engine defaultConfig builds (the embedder form), the same', async () => {
    const got = await stamps(engineFrom(defaultConfig));
    for (const [rule, sources] of got) expect([...sources], rule).toEqual(['default']);
  });

  it('a config file that sets each key to its SHIPPED value reads "config": choosing the shipped number is still a choice', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ eval: { ruleThresholds: defaultConfig.eval.ruleThresholds } }));
    const got = await stamps(engineFrom(loadConfig()));
    for (const rule of CONFIGURABLE) expect(got.has(rule), `${rule} reported no threshold stamp`).toBe(true);
    // tool_choice's margin and fit are per-call keys, not config-file keys, so the file leaves them ours.
    for (const [rule, sources] of got) expect([...sources], rule).toEqual([rule === 'tool_choice' ? 'default' : 'config']);
  });

  it('the per-call keys of tool_choice read "config" when the call sets them, at the shipped values too', async () => {
    const call = { ...CALLS[3], customConfig: { tool_choice_margin: 0.34, tool_choice_min_fit: 0.5 } };
    const r = await engineFrom(loadConfig()).evaluateAll(call);
    const tc = r.rule_results.find((x) => x.ruleName === 'tool_choice')!;
    const sources = (tc.evidence ?? []).flatMap((e) => (e.type === 'count' && e.thresholdSource ? [e.thresholdSource] : []));
    expect(sources.length).toBeGreaterThan(0);
    expect(new Set(sources)).toEqual(new Set(['config']));
  });

  it('answers_the_ask advises at the shipped config and gates once a relevance threshold is set', async () => {
    const off = CALLS[0];
    const shipped = await engineFrom(loadConfig()).evaluateAll(off);
    expect(shipped.rule_results.find((r) => r.ruleName === 'answers_the_ask')).toMatchObject({ passed: false, role: 'advisory' });
    expect(shipped.verdict?.by ?? []).not.toContain('answers_the_ask');

    writeFileSync(join(home, 'config.json'), JSON.stringify({ eval: { ruleThresholds: { topic_consistency: 0.33 } } }));
    const set = await engineFrom(loadConfig()).evaluateAll(off);
    expect(set.rule_results.find((r) => r.ruleName === 'answers_the_ask')).toMatchObject({ passed: false, role: 'gate' });
    expect(set.verdict).toMatchObject({ state: 'fail', basis: 'policy_gate' });
  });
});
