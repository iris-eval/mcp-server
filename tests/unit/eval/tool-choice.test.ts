/*
 * tool_choice (arc 9, N-13): the formula on one catalogue, the skips, the
 * trajectory-level judgement, and the configuration.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_CHOICE_MARGIN, DEFAULT_TOOL_CHOICE_MIN_FIT, fitOf, toolChoice, toolTerms } from '../../../src/eval/rules/tool-choice.js';
import { contentTerms } from '../../../src/eval/terms.js';
import type { EvalContext } from '../../../src/types/eval.js';
import type { ToolDescriptor } from '../../../src/types/trace.js';

const tools: ToolDescriptor[] = [
  { name: 'list_files', description: 'List the files in a directory', inputSchema: { type: 'object', properties: { directory: { type: 'string' } } } },
  { name: 'count_lines', description: 'Count the lines, words and bytes in a file', inputSchema: { type: 'object', properties: { file: { type: 'string' } } } },
  { name: 'read_file', description: 'Return the contents of a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'web_search', description: 'Search the web for a query and return the top results', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
];
const call = (tool: string) => ({ tool_name: tool, input: {}, output: 'ok' });
const run = (ctx: Partial<EvalContext>) => toolChoice.evaluate({ output: 'done', tools, ...ctx } as EvalContext);

describe('the formula', () => {
  it('toolTerms reads the name, the description and the input property names through the relevance tokenizer', () => {
    const terms = toolTerms(tools[1]);
    for (const t of contentTerms('count lines words bytes file')) expect(terms.has(t)).toBe(true);
    expect(toolTerms(tools[3]).has('query')).toBe(true);
  });
  it('fitOf is the share of the ask covered', () => {
    const ask = new Set(contentTerms('count the lines in the README file'));
    expect(fitOf(ask, toolTerms(tools[1]))).toBeCloseTo(2 / 3);
    expect(fitOf(ask, toolTerms(tools[2]))).toBeCloseTo(1 / 3);
    expect(fitOf(new Set(), toolTerms(tools[1]))).toBe(0);
  });
});

describe('tool_choice — the rule', () => {
  it('fires when an uncalled tool fits the ask by at least min_fit and beats the tools called by at least the margin, naming both', () => {
    // "lines" and "words" are stopwords (the form of a deliverable); of the ask's terms count, bytes, readme, file,
    // no tool speaks of a readme, so the actionable terms are count, bytes, file (stemmed: count, byt, fil).
    const r = run({ input: 'Count the lines and bytes in the README file', toolCalls: [call('list_files')] });
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/count_lines fits 100% of the ask's actionable terms \(count, byt, fil\) .*\(list_files\) fit 33%/);
    expect(r.evidence?.[0]).toMatchObject({ type: 'count', stat: 'ask_fit_called_tools', value: 1 / 3 });
    expect(r.evidence?.[1]).toMatchObject({ type: 'count', stat: 'ask_fit_best_uncalled_tool', threshold: DEFAULT_TOOL_CHOICE_MIN_FIT });
    expect(r.evidence?.some((e) => e.type === 'toolCall' && e.toolName === 'list_files')).toBe(true);
  });
  it('does not fire when the tools called cover the ask, even across several calls that each serve one part', () => {
    const r = run({ input: 'List the files in src and count the lines in each file', toolCalls: [call('list_files'), call('count_lines')] });
    expect(r.passed).toBe(true);
    expect(r.message).toMatch(/best uncalled tool/);
  });
  it('does not fire when the best uncalled tool is under min_fit, or when it beats the called ones by less than the margin', () => {
    // web_search covers "search web" of a long ask: high fit for nothing else; the called tool covers as much.
    const r = run({ input: 'Read the config file and report its contents', toolCalls: [call('read_file')] });
    expect(r.passed).toBe(true);
    const close = run({ input: 'Count the lines in the file', toolCalls: [call('read_file')], customConfig: { tool_choice_margin: 0.9 } });
    expect(close.passed).toBe(true);
  });
  it('passes when every catalogue tool was called — nothing better was left to choose', () => {
    const r = run({ input: 'Count the lines and bytes in the README file', toolCalls: tools.map((t) => call(t.name)) });
    expect(r.passed).toBe(true);
    expect(r.message).toMatch(/Every tool in the catalogue was called/);
  });
  it("skips when no tool in the catalogue mentions any of the ask's terms — there is nothing to choose between", () => {
    const r = run({ input: 'Translate this poem into Welsh', toolCalls: [call('web_search')] });
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toMatch(/no tool in the catalogue mentions/);
  });
  it('skips without the input, without a trajectory, without a catalogue, and on an ask with fewer than two content terms', () => {
    expect(run({ toolCalls: [call('read_file')] }).skipReason).toMatch(/input/);
    expect(run({ input: 'Count the lines in the file' }).skipped).toBe(true);
    expect(toolChoice.evaluate({ output: 'done', input: 'Count the lines in the file', toolCalls: [call('read_file')] } as EvalContext).skipReason).toMatch(/tools/);
    expect(run({ input: 'Please help', toolCalls: [call('read_file')] }).skipReason).toMatch(/content term/);
  });
  it('is a detection with a heuristic behind it: never critical, so a fire degrades the score rather than vetoing', () => {
    expect(toolChoice.kind).toBe('detection');
    expect(toolChoice.mechanism).toBe('heuristic');
    expect(toolChoice.critical).toBeUndefined();
    expect(toolChoice.classes).toEqual(['wrong_tool']);
    expect(toolChoice.needs).toEqual(['input', 'tool_calls', 'tools_catalogue']);
    const r = run({ input: 'Count the lines and bytes in the README file', toolCalls: [call('list_files')] });
    expect(r.score).toBeCloseTo(1 / 3);
    expect(DEFAULT_TOOL_CHOICE_MARGIN).toBe(0.34);
  });
});
