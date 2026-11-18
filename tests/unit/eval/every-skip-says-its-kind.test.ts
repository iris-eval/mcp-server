/*
 * Every skip says what kind it is (0.22.0). A rule that skipped says whether
 * there was nothing to judge (`not_applicable`) or it could not judge
 * (`defeated`, `config_invalid`), and the engine reads a skip that says
 * nothing as one that could not judge. Before, a skip with no flag was read
 * as having had nothing to judge, and five places a deployment can meet
 * skipped that way when they could not judge: a check the deployment made
 * critical then read as a clean pass.
 */
import { describe, expect, it, vi } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { skipClassOf } from '../../../src/eval/stamp.js';
import { builtInRules } from '../../../src/eval/criticality.js';
import { MAX_TOOL_INPUT_BYTES } from '../../../src/eval/schema-validator.js';
import { MAX_STEPS_DERIVED } from '../../../src/eval/steps.js';
import { answersTheAsk } from '../../../src/eval/rules/relevance.js';
import { noDroppedStep, noUnusualAction } from '../../../src/eval/rules/case-history.js';
import { createCustomRule } from '../../../src/eval/rules/custom.js';
import type { CaseRun, CustomRuleDefinition, EvalContext, EvalResult, EvalRule, EvalRuleResult, RuleAnswer } from '../../../src/types/eval.js';

/** The regex sandbox, as the server runs it, unless a test says its worker died. */
const sandbox = vi.hoisted(() => ({ dies: false }));
vi.mock('../../../src/eval/rules/regex-sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/eval/rules/regex-sandbox.js')>();
  return {
    ...actual,
    sandboxedRegexTest: (...args: Parameters<typeof actual.sandboxedRegexTest>) => (sandbox.dies ? { kind: 'error' as const } : actual.sandboxedRegexTest(...args)),
  };
});

const engine = (overrides: Partial<typeof defaultConfig.eval> = {}): EvalEngine =>
  new EvalEngine(defaultConfig.eval.defaultThreshold, { ...defaultConfig.eval.ruleThresholds }, { ...defaultConfig.eval, ...overrides });
const row = (result: EvalResult, name: string): EvalRuleResult => result.rule_results.find((r) => r.ruleName === name)!;
const said = (result: EvalResult): string[] => (result.interpretations ?? []).map((i) => i.text);

const ASK = 'Summarise the quarterly report in two sentences.';
const ANSWER = 'Revenue grew four percent on the quarter, led by the services line. Costs were flat and the margin widened by one point.';
const SCHEMA = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };

describe('the kind of a skip is read from what the result says', () => {
  const skip = (fields: Partial<EvalRuleResult>): EvalRuleResult => ({ ruleName: 'r', passed: false, score: 0, message: 'not judged', skipped: true, ...fields });

  it('the class a rule said, and a skip that says none could not judge', () => {
    expect(skipClassOf(skip({ skipClass: 'not_applicable' }))).toBe('not_applicable');
    expect(skipClassOf(skip({ skipClass: 'defeated' }))).toBe('defeated');
    expect(skipClassOf(skip({ skipClass: 'config_invalid' }))).toBe('config_invalid');
    expect(skipClassOf(skip({}))).toBe('defeated');
    expect(skipClassOf(skip({ skipClass: 'nothing to judge' as never }))).toBe('defeated');
    expect(skipClassOf({ ruleName: 'r', passed: true, score: 1, message: 'ok' })).toBeUndefined();
  });

  it('the flags the engine and the sandbox set come first', () => {
    for (const flag of ['threw', 'budgetExceeded', 'evidenceIncomplete'] as const) expect(skipClassOf(skip({ skipClass: 'not_applicable', [flag]: true })), flag).toBe('defeated');
    expect(skipClassOf(skip({ skipClass: 'not_applicable', configInvalid: true }))).toBe('config_invalid');
  });
});

describe('every rule Iris ships says, of each place it had nothing to judge, that it had nothing to judge', () => {
  const READ = { tool_name: 'read_file', input: { path: 'a.ts' }, output: 'x' };
  const CATALOGUE = [{ name: 'read_file', description: 'Read a file from the workspace', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
  const own = ['delete_file', 'post_message', 'create_event', 'update_password'];
  // Six earlier runs, four of which each took an action none of the others took: the case has no usual way of going.
  const scattered: CaseRun[] = Array.from({ length: 6 }, (_, i) => ({ tools: i < 4 ? ['get_balance', own[i]] : ['get_balance'] }));
  const contexts: Array<[string, EvalContext]> = [
    ['nothing but an output', { output: ANSWER }],
    ['an empty output', { output: '' }],
    ['an ask of one word', { input: 'Hi', output: 'Hello.' }],
    ['an ask and an answer', { input: ASK, output: ANSWER }],
    ['an empty list of tool calls', { input: ASK, output: ANSWER, toolCalls: [] }],
    ['one call, no catalogue', { input: ASK, output: ANSWER, toolCalls: [READ] }],
    ['spans and no tool span', { input: ASK, output: ANSWER, spans: [{ span_id: 's1', trace_id: 't1', name: 'llm', kind: 'LLM', start_time: '2026-11-18T00:00:00.000Z' }] as unknown as EvalContext['spans'] }],
    ['two earlier runs', { input: ASK, output: ANSWER, toolCalls: [READ], caseHistory: [{ tools: ['read_file'] }, { tools: ['read_file'] }] }],
    ['a case with no usual way', { input: ASK, output: ANSWER, toolCalls: [{ tool_name: 'send_money', input: {}, output: 'ok' }], caseHistory: scattered }],
    ['a case with no usual step', { input: ASK, output: ANSWER, toolCalls: [READ], caseHistory: [{ tools: ['a_tool'] }, { tools: ['b_tool'] }, { tools: ['c_tool'] }] }],
    ['argument checking turned off', { input: ASK, output: ANSWER, toolCalls: [READ], tools: CATALOGUE, customConfig: { validate_tool_arguments: false } }],
    ['an input too long to be an ask', { input: 'word '.repeat(402), output: ANSWER }],
    ['no word over three letters', { input: 'the cat sat', output: 'yes it did' }],
    ['an output too brief', { input: ASK, output: 'Revenue grew.' }],
    ['an ask of no content terms', { input: 'What about this one, then? Would that work?', output: ANSWER }],
    ['an output of no content terms', { input: ASK, output: 'That would have been there with them, they said, and then some.' }],
    ['calls that carry no output', { input: ASK, output: ANSWER, toolCalls: [{ tool_name: 'read_file', input: { path: 'a.ts' } }] }],
    ['a catalogue and a short ask', { input: 'Hi', output: 'Hello.', toolCalls: [READ], tools: CATALOGUE }],
    ['a catalogue that does not speak to the ask', { input: ASK, output: ANSWER, toolCalls: [{ tool_name: 'get_weather', input: { city: 'Paris' }, output: 'sunny' }], tools: [{ name: 'get_weather', description: 'Weather forecast for a city' }] }],
    ['a call without its input', { output: ANSWER, toolCalls: [READ], tools: CATALOGUE }],
    ['an ask and an empty output', { input: ASK, output: '' }],
    ['a cost and no history of costs', { input: ASK, output: ANSWER, costUsd: 0.01, costHistory: [] }],
  ];
  /*
   * Each place, by its rule and the start of its reason: what the rule reads was not sent, or the question does not
   * apply to what was. Every place must be reached by the calls above, so a place turned to "could not judge" fails here.
   */
  const NOTHING_TO_JUDGE: Array<[rule: string, reason: string]> = [
    ['answers_the_ask', 'context.input not provided'],
    ['answers_the_ask', 'input has no content terms'],
    ['answers_the_ask', 'input or output has no words >'],
    ['answers_the_ask', 'output has <'],
    ['answers_the_ask', 'output has no content terms'],
    ['answers_the_ask', 'the ask has'],
    ['ask_coverage', 'context.input not provided — the parts of an ask'],
    ['ask_coverage', 'the input asks for one thing — this rule judges'],
    ['ask_coverage', 'the input is'],
    ['ask_coverage', 'the output is empty — non_empty_output judges th'],
    ['cost_anomaly', 'context.costUsd not provided'],
    ['cost_anomaly', 'insufficient_history:'],
    ['cost_under_threshold', 'context.costUsd not provided'],
    ['expected_coverage', 'context.expected not provided'],
    ['grounded_in_reads', 'context.toolCalls is empty — the agent made no t'],
    ['grounded_in_reads', 'context.toolCalls not provided — no trajectory t'],
    ['grounded_in_reads', 'spans were supplied but none has kind TOOL — a t'],
    ['keyword_overlap', 'context.input not provided'],
    ['max_steps', 'context.toolCalls is empty — the agent made no t'],
    ['max_steps', 'context.toolCalls not provided — no trajectory t'],
    ['max_steps', 'spans were supplied but none has kind TOOL — a t'],
    ['no_dropped_step', 'context.toolCalls not provided — no trajectory t'],
    ['no_dropped_step', 'insufficient_history:'],
    ['no_dropped_step', 'insufficient_history: no stored case (evaluate a'],
    ['no_dropped_step', 'no_usual_step: no tool was called by every one o'],
    ['no_dropped_step', 'spans were supplied but none has kind TOOL — a t'],
    ['no_injection_compliance', 'context.toolCalls is empty — the agent made no t'],
    ['no_injection_compliance', 'context.toolCalls not provided — no trajectory t'],
    ['no_injection_compliance', 'no tool output could be scanned — every call car'],
    ['no_injection_compliance', 'spans were supplied but none has kind TOOL — a t'],
    ['no_silent_tool_failure', 'context.toolCalls is empty — the agent made no t'],
    ['no_silent_tool_failure', 'context.toolCalls not provided — no trajectory t'],
    ['no_silent_tool_failure', 'spans were supplied but none has kind TOOL — a t'],
    ['no_tool_loop', 'context.toolCalls is empty — the agent made no t'],
    ['no_tool_loop', 'context.toolCalls not provided — no trajectory t'],
    ['no_tool_loop', 'spans were supplied but none has kind TOOL — a t'],
    ['no_unusual_action', 'context.toolCalls is empty — the agent made no t'],
    ['no_unusual_action', 'context.toolCalls not provided — no trajectory t'],
    ['no_unusual_action', 'insufficient_history:'],
    ['no_unusual_action', 'insufficient_history: no stored case (evaluate a'],
    ['no_unusual_action', 'no_usual_way:'],
    ['no_unusual_action', 'spans were supplied but none has kind TOOL — a t'],
    ['says_something', 'the output is empty; non_empty_output judges tha'],
    ['step_budget', 'context.expectedTrajectory.step_budget (or tool_'],
    ['tool_choice', 'context.input not provided'],
    ['tool_choice', 'context.toolCalls is empty — the agent made no t'],
    ['tool_choice', 'context.toolCalls not provided — no trajectory t'],
    ['tool_choice', 'context.tools not provided — a choice cannot be'],
    ['tool_choice', 'no tool in the catalogue mentions any of the ask'],
    ['tool_choice', 'spans were supplied but none has kind TOOL — a t'],
    ['tool_choice', 'the ask has'],
    ['tool_sequence', 'context.expectedTrajectory.tool_calls not provid'],
    ['topic_consistency', 'context.input not provided'],
    ['topic_consistency', 'input has no content terms'],
    ['topic_consistency', 'input or output has no words >'],
    ['topic_consistency', 'output has <'],
    ['topic_consistency', 'output has no content terms'],
    ['valid_tool_arguments', 'context.toolCalls is empty — the agent made no t'],
    ['valid_tool_arguments', 'context.toolCalls not provided — no trajectory t'],
    ['valid_tool_arguments', 'context.tools not provided — a call cannot be ch'],
    ['valid_tool_arguments', 'eval.validateToolArguments is false — argument c'],
    ['valid_tool_arguments', 'no call could be checked: get_weather (no inputS'],
    ['valid_tool_arguments', 'spans were supplied but none has kind TOOL — a t'],
    ['verbosity_ratio', 'context.tokenUsage not provided'],
  ];

  it('every skip on these calls is one of these places and says not_applicable, and every place is reached', () => {
    const reached = new Set<number>();
    for (const rule of builtInRules()) {
      for (const [what, context] of contexts) {
        const answer: RuleAnswer = rule.evaluate(structuredClone(context));
        if (answer.skipped !== true) continue;
        const reason = answer.skipReason ?? '';
        // The place whose reason starts this one, the longest where two do.
        let place = -1;
        NOTHING_TO_JUDGE.forEach(([name, start], i) => {
          if (name === rule.name && reason.startsWith(start) && (place === -1 || start.length > NOTHING_TO_JUDGE[place][1].length)) place = i;
        });
        expect(place, `${rule.name} on ${what}: ${reason}`).toBeGreaterThanOrEqual(0);
        expect(answer.skipClass, `${rule.name} on ${what}: ${reason}`).toBe('not_applicable');
        reached.add(place);
      }
    }
    expect(NOTHING_TO_JUDGE.filter((_, i) => !reached.has(i))).toEqual([]);
  });
});

describe('the type a rule answers with holds the kind (CI type-checks every test file)', () => {
  it('a skip that does not say its kind does not compile; one that does, does', () => {
    // @ts-expect-error A skip must say whether there was nothing to judge or the rule could not judge.
    const noKind: RuleAnswer = { ruleName: 'r', passed: false, score: 0, message: 'not judged', skipped: true };
    const withKind: RuleAnswer = { ruleName: 'r', passed: false, score: 0, message: 'not judged', skipped: true, skipClass: 'not_applicable' };
    expect([noKind.skipped, withKind.skipClass]).toEqual([true, 'not_applicable']);
  });
});

describe('the places beside the rules Iris ships that had nothing to judge say so', () => {
  it('a custom cost rule with no cost sent, and a custom policy over a run that sent no calls or an empty list', () => {
    const cost = createCustomRule({ name: 'under_a_cent', type: 'cost_threshold', config: { max_cost: 0.01 } }, 'high');
    expect(cost.evaluate({ input: ASK, output: ANSWER })).toMatchObject({ skipped: true, skipClass: 'not_applicable', skipReason: 'context.costUsd not provided' });
    const policy = createCustomRule({ name: 'no_deletes', type: 'action_policy', config: { deny: [{ tool: 'delete_*' }] } }, 'high');
    for (const toolCalls of [undefined, []]) {
      expect(policy.evaluate({ input: ASK, output: ANSWER, toolCalls }), `${toolCalls === undefined ? 'no' : 'an empty list of'} calls`).toMatchObject({ skipped: true, skipClass: 'not_applicable' });
    }
  });

  it('a judgment rule on a path that may not spend', async () => {
    const e = engine();
    e.registerRule('completeness', { name: 'acme_judge', description: 'a judgment', evalType: 'completeness', weight: 1, kind: 'judgment', evaluate: () => ({ ruleName: 'acme_judge', passed: true, score: 1, message: 'judged' }) });
    const result = await e.evaluateAll({ input: ASK, output: ANSWER });
    expect(row(result, 'acme_judge')).toMatchObject({ skipped: true, skipClass: 'not_applicable', skipReason: 'this evaluation may not spend (context.allowPaid is not set)' });
  });

  it('answers_the_ask whose installed judge did not answer, where the words alone could judge: an answer, which says no kind of skip', () => {
    const judgeDown = { template: 'relevance', provider: 'anthropic', model: 'acme-judge', error: 'the provider did not answer', costUsd: null, inputTokens: 0, outputTokens: 0 } as unknown as EvalContext['relevanceJudgment'];
    const answered = answersTheAsk.evaluate({ input: ASK, output: ANSWER, relevanceJudgment: judgeDown });
    expect(answered.skipped).not.toBe(true);
    expect(answered.skipClass).toBeUndefined();
  });
});

describe('a check that could not judge, made critical, leaves the verdict unknown where it read as a clean pass', () => {
  it("a custom rule's pattern, when the worker that matches it died", async () => {
    const pattern: CustomRuleDefinition = { name: 'no_internal_hostnames', type: 'regex_no_match', config: { pattern: 'corp\\.internal' }, severity: 'high' };
    sandbox.dies = true;
    try {
      const result = await engine().evaluateAll({ input: ASK, output: ANSWER }, [pattern]);
      expect(row(result, 'no_internal_hostnames')).toMatchObject({ skipped: true, skipClass: 'defeated', critical: true });
      expect(result.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['no_internal_hostnames'] });
    } finally {
      sandbox.dies = false;
    }
    // The pattern that runs is judged as before.
    expect((await engine().evaluateAll({ input: ASK, output: ANSWER }, [pattern])).verdict).toMatchObject({ state: 'pass' });
  });

  it("a custom rule's JSON Schema, when the output is too large to check", async () => {
    const shape: CustomRuleDefinition = { name: 'answer_shape', type: 'json_schema', config: { schema: { type: 'object' } }, severity: 'high' };
    const output = JSON.stringify({ text: 'x'.repeat(MAX_TOOL_INPUT_BYTES + 1_000) });
    const result = await engine().evaluateAll({ input: ASK, output }, [shape]);
    expect(row(result, 'answer_shape')).toMatchObject({ skipped: true, skipClass: 'defeated' });
    expect(result.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['answer_shape'] });
  });

  describe('valid_tool_arguments, made critical by the deployment', () => {
    const critical = (): EvalEngine => engine({ criticalRules: ['valid_tool_arguments'] });
    it("a call whose arguments are too large to check against the tool's schema", async () => {
      const result = await critical().evaluateAll({ input: ASK, output: ANSWER, tools: [{ name: 'search', inputSchema: SCHEMA }], toolCalls: [{ tool_name: 'search', input: { query: 'q'.repeat(MAX_TOOL_INPUT_BYTES + 10) }, output: 'found' }] });
      expect(row(result, 'valid_tool_arguments')).toMatchObject({ skipped: true, skipClass: 'defeated' });
      expect(result.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['valid_tool_arguments'] });
    });
    it('calls under two names that lead to one entry of the catalogue', async () => {
      const result = await critical().evaluateAll({
        input: ASK,
        output: ANSWER,
        tools: [{ name: 'search', inputSchema: SCHEMA }],
        toolCalls: [
          { tool_name: 'mcp__docs__search', input: { query: 'quarterly' }, output: 'a' },
          { tool_name: 'mcp__tickets__search', input: { query: 'quarterly' }, output: 'b' },
        ],
      });
      expect(row(result, 'valid_tool_arguments')).toMatchObject({ skipped: true, skipClass: 'defeated' });
      expect(result.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['valid_tool_arguments'] });
    });
    it('a catalogue that declares no schema for the tool called had nothing to check against, as before', async () => {
      const result = await critical().evaluateAll({ input: ASK, output: ANSWER, tools: [{ name: 'search' }], toolCalls: [{ tool_name: 'search', input: { query: 'quarterly' }, output: 'found' }] });
      expect(row(result, 'valid_tool_arguments')).toMatchObject({ skipped: true, skipClass: 'not_applicable' });
      expect(result.verdict).toMatchObject({ state: 'pass' });
    });
  });

  it("a deployment's own rule that skipped and said no kind (as a plugin's may)", async () => {
    const silent = (said: Partial<EvalRuleResult>): EvalRule => ({
      name: 'acme_policy',
      description: "The deployment's own policy.",
      evalType: 'custom',
      weight: 1,
      critical: true,
      kind: 'policy',
      mechanism: 'formula',
      needs: ['output'],
      version: 1,
      evaluate: () => ({ ruleName: 'acme_policy', passed: false, score: 0, message: 'Not judged', skipped: true, skipReason: 'no reading', ...said }) as unknown as RuleAnswer,
    });
    const withRule = (rule: EvalRule): EvalEngine => {
      const e = engine();
      e.registerRule('custom', rule, 'embedder:acme_policy');
      return e;
    };
    const unsaid = await withRule(silent({})).evaluateAll({ input: ASK, output: ANSWER });
    expect(row(unsaid, 'acme_policy')).toMatchObject({ skipClass: 'defeated' });
    expect(unsaid.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['acme_policy'] });
    const nothingToJudge = await withRule(silent({ skipClass: 'not_applicable' })).evaluateAll({ input: ASK, output: ANSWER });
    expect(row(nothingToJudge, 'acme_policy')).toMatchObject({ skipClass: 'not_applicable' });
    expect(nothingToJudge.verdict).toMatchObject({ state: 'pass' });
  });
});

describe('the other places that could not judge say so', () => {
  it('answers_the_ask, where an installed judge did not answer and the words alone could not judge either', () => {
    const judgeDown = { template: 'relevance', provider: 'anthropic', model: 'acme-judge', error: 'the provider did not answer', costUsd: null, inputTokens: 0, outputTokens: 0 } as unknown as EvalContext['relevanceJudgment'];
    const tooShort = { input: 'Hi', output: 'Hello there.' };
    expect(answersTheAsk.evaluate({ ...tooShort, relevanceJudgment: judgeDown })).toMatchObject({ skipped: true, skipClass: 'defeated' });
    // With no judge installed, the words alone had nothing to judge.
    expect(answersTheAsk.evaluate(tooShort)).toMatchObject({ skipped: true, skipClass: 'not_applicable' });
  });

  // Six earlier runs of the case, each of which read a file: enough to read a run against.
  const SIX: CaseRun[] = Array.from({ length: 6 }, () => ({ tools: ['read_file'] }));
  const NAMELESS = [{ tool_name: 'read_file', input: {}, output: 'x' }, { tool_name: '', input: {}, output: 'x' }];
  const PAST_THE_READ = Array.from({ length: MAX_STEPS_DERIVED + 1 }, (_, i) => ({ tool_name: 'read_file', input: { path: `f${i}.ts` }, output: 'x' }));

  it('no_unusual_action, where a call of the run carries no name, against earlier runs to read it against', () => {
    expect(noUnusualAction.evaluate({ input: ASK, output: ANSWER, toolCalls: NAMELESS, caseHistory: SIX })).toMatchObject({ skipped: true, skipClass: 'defeated' });
  });

  it('no_dropped_step, where only the first calls of the run were read, against earlier runs to read it against', () => {
    expect(noDroppedStep.evaluate({ input: ASK, output: ANSWER, toolCalls: PAST_THE_READ, caseHistory: SIX })).toMatchObject({ skipped: true, skipClass: 'defeated', evidenceIncomplete: true });
    expect(noDroppedStep.evaluate({ input: ASK, output: ANSWER, toolCalls: NAMELESS, caseHistory: SIX })).toMatchObject({ skipped: true, skipClass: 'defeated' });
  });

  it('with no stored case, or too few earlier runs, the case-history rules had nothing to judge, whatever the run holds', () => {
    for (const caseHistory of [undefined, [] as CaseRun[], SIX.slice(0, 2)]) {
      for (const toolCalls of [NAMELESS, PAST_THE_READ]) {
        for (const rule of [noUnusualAction, noDroppedStep]) {
          const answer = rule.evaluate({ input: ASK, output: ANSWER, toolCalls, caseHistory });
          expect(answer, `${rule.name}, ${caseHistory?.length ?? 'no'} earlier runs, ${toolCalls.length} calls`).toMatchObject({ skipped: true, skipClass: 'not_applicable' });
          expect(answer.skipReason).toMatch(/^insufficient_history: /);
        }
      }
    }
  });

  it('made critical, a case-history rule with no stored case leaves the verdict as it was, whatever the run holds', async () => {
    for (const name of ['no_unusual_action', 'no_dropped_step']) {
      for (const toolCalls of [NAMELESS, PAST_THE_READ]) {
        const result = await engine({ criticalRules: [name] }).evaluateAll({ input: ASK, output: ANSWER, toolCalls });
        expect(row(result, name), `${name}, ${toolCalls.length} calls`).toMatchObject({ skipped: true, skipClass: 'not_applicable' });
        expect(result.verdict?.by ?? [], `${name}, ${toolCalls.length} calls`).not.toContain(name);
      }
    }
  });
});

describe('what a reader is told', () => {
  it('a critical check with nothing to judge is named even where the layer names another check', async () => {
    const pattern: CustomRuleDefinition = { name: 'no_internal_hostnames', type: 'regex_no_match', config: { pattern: 'corp\\.internal' }, severity: 'high' };
    sandbox.dies = true;
    try {
      // tool_choice is made critical, and the call sends no tool calls: nothing to judge.
      const result = await engine({ criticalRules: ['tool_choice'] }).evaluateAll({ input: ASK, output: ANSWER }, [pattern]);
      expect(row(result, 'tool_choice')).toMatchObject({ skipped: true, skipClass: 'not_applicable' });
      expect(result.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['no_internal_hostnames'] });
      expect(said(result).some((t) => t.startsWith('A critical check was asked and could not answer (no_internal_hostnames)'))).toBe(true);
      expect(said(result).some((t) => t.startsWith('Critical check(s) did not judge this output (tool_choice)'))).toBe(true);
    } finally {
      sandbox.dies = false;
    }
  });

  it('a critical check with nothing to judge is named beside the layer even where the check the layer names carries its name', async () => {
    // A custom rule called tool_choice whose definition is broken: the layer names it. The built-in tool_choice, critical, had no calls to judge.
    const broken: CustomRuleDefinition = { name: 'tool_choice', type: 'regex_no_match', config: { pattern: '(' }, severity: 'high' };
    const result = await engine({ criticalRules: ['tool_choice'] }).evaluateAll({ input: ASK, output: ANSWER }, [broken]);
    const rows = result.rule_results.filter((r) => r.ruleName === 'tool_choice');
    expect(rows.map((r) => [r.origin ?? 'built-in', r.skipClass])).toEqual([
      ['built-in', 'not_applicable'],
      ['custom', 'config_invalid'],
    ]);
    expect(result.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['tool_choice'] });
    expect(said(result).some((t) => t.startsWith('Critical check(s) did not judge this output (tool_choice)'))).toBe(true);
  });
});
