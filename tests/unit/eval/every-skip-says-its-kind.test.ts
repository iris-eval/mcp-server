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

describe('every rule Iris ships says the kind of each skip', () => {
  const contexts: Array<[string, EvalContext]> = [
    ['nothing but an output', { output: ANSWER }],
    ['an empty output', { output: '' }],
    ['an ask of one word', { input: 'Hi', output: 'Hello.' }],
    ['an ask and an answer', { input: ASK, output: ANSWER }],
    ['an empty list of tool calls', { input: ASK, output: ANSWER, toolCalls: [] }],
    ['one call, no catalogue', { input: ASK, output: ANSWER, toolCalls: [{ tool_name: 'read_file', input: { path: 'a.ts' }, output: 'x' }] }],
  ];
  it.each(builtInRules().map((rule) => [rule.name, rule] as const))('%s', (_name, rule: EvalRule) => {
    for (const [what, context] of contexts) {
      let answer: RuleAnswer;
      try {
        answer = rule.evaluate(structuredClone(context));
      } catch {
        continue;
      }
      if (answer.skipped === true) expect(['not_applicable', 'defeated', 'config_invalid'], `${rule.name} on ${what}`).toContain(answer.skipClass);
    }
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

  it('no_unusual_action, where a call of the run carries no name', () => {
    expect(noUnusualAction.evaluate({ input: ASK, output: ANSWER, toolCalls: [{ tool_name: '', input: {}, output: 'x' }] })).toMatchObject({ skipped: true, skipClass: 'defeated' });
  });

  it('no_dropped_step, where only the first calls of the run were read', () => {
    const calls = Array.from({ length: MAX_STEPS_DERIVED + 5 }, (_, i) => ({ tool_name: 'read_file', input: { path: `f${i}.ts` }, output: 'x' }));
    const history: CaseRun[] = [];
    expect(noDroppedStep.evaluate({ input: ASK, output: ANSWER, toolCalls: calls, caseHistory: history })).toMatchObject({ skipped: true, skipClass: 'defeated', evidenceIncomplete: true });
  });
});

describe('what a reader is told', () => {
  it('a critical check with nothing to judge is named even where the layer names another check', async () => {
    const pattern: CustomRuleDefinition = { name: 'no_internal_hostnames', type: 'regex_no_match', config: { pattern: 'corp\\.internal' }, severity: 'high' };
    sandbox.dies = true;
    try {
      // tool_choice is made critical and has no catalogue to judge against: nothing to judge.
      const result = await engine({ criticalRules: ['tool_choice'] }).evaluateAll({ input: ASK, output: ANSWER }, [pattern]);
      expect(row(result, 'tool_choice')).toMatchObject({ skipped: true, skipClass: 'not_applicable' });
      expect(result.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['no_internal_hostnames'] });
      expect(said(result).some((t) => t.startsWith('A critical check was asked and could not answer (no_internal_hostnames)'))).toBe(true);
      expect(said(result).some((t) => t.startsWith('Critical check(s) did not judge this output (tool_choice)'))).toBe(true);
    } finally {
      sandbox.dies = false;
    }
  });
});
