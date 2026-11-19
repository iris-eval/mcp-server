/*
 * tool_choice takes each catalogue entry's words once an evaluation.
 *
 * It took them to say what the ask can be judged on, again for every name
 * the run called that led to the entry, and again for every entry not
 * called. These tests count the taking (a description that counts each time
 * it is read says how often the rule read it, whatever the machine), and
 * hold the answers a taking kept too long, or left out, would change.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { actionableTerms, toolChoice } from '../../../src/eval/rules/tool-choice.js';
import { contentTerms } from '../../../src/eval/terms.js';
import type { EvalContext } from '../../../src/types/eval.js';
import type { ToolDescriptor } from '../../../src/types/trace.js';

describe('tool_choice — a catalogue entry’s words are taken once an evaluation', () => {
  /** A tool whose description counts each time it is read: taking a tool's words reads it. */
  const countedTool = (name: string, description: string): { tool: ToolDescriptor; reads: () => number } => {
    let reads = 0;
    const tool = { name, inputSchema: { type: 'object', properties: { customer: { type: 'string' } } } } as ToolDescriptor;
    Object.defineProperty(tool, 'description', {
      enumerable: true,
      get: () => {
        reads += 1;
        return description;
      },
    });
    return { tool, reads: () => reads };
  };
  const ask = 'Send the invoice to the customer acme by email.';
  const judge = (tools: ToolDescriptor[], called: string[], input = ask) => toolChoice.evaluate({ input, output: 'Sent.', tools, toolCalls: called.map((tool_name) => ({ tool_name, input: {} })) } as EvalContext);

  it('an entry reached under one name or under five is read the same number of times, and so is one not called at all', () => {
    const once = [countedTool('send_invoice', 'Send an invoice to a customer by email.'), countedTool('read_file', 'Read one source file.')];
    const one = judge(once.map((t) => t.tool), ['send_invoice']);
    const many = [countedTool('send_invoice', 'Send an invoice to a customer by email.'), countedTool('read_file', 'Read one source file.')];
    const five = judge(many.map((t) => t.tool), ['mcp__a__send_invoice', 'mcp__b__send_invoice', 'mcp__c__send_invoice', 'mcp__d__send_invoice', 'mcp__e__send_invoice']);
    expect(one.passed).toBe(true);
    expect(five.passed).toBe(true);
    expect(many.map((t) => t.reads())).toEqual(once.map((t) => t.reads()));
    // Once each: to say what the ask can be judged on, which is every entry's words, and never again.
    expect(once.map((t) => t.reads())).toEqual([1, 1]);
  });

  it('the finding is the one taking the words each time gave: the tool that fits and was not called is named', () => {
    const tools = [countedTool('send_invoice', 'Send an invoice to a customer by email.'), countedTool('read_file', 'Read one source file.')];
    const result = judge(tools.map((t) => t.tool), ['read_file', 'mcp__fs__read_file']);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('send_invoice fits');
    expect(tools.map((t) => t.reads())).toEqual([1, 1]);
  });

  it('the words of every entry called count together: two tools called that between them fit the ask pass beside one uncalled that fits it alone', () => {
    const tools = [
      { name: 'assistant', description: 'Search the web, then send an email to a customer.' },
      { name: 'send_email', description: 'Send an email to a customer.' },
      { name: 'web_search', description: 'Search the web for pages.' },
    ] as ToolDescriptor[];
    const result = judge(tools, ['web_search', 'send_email'], 'Search the web for the release notes, then send an email to the customer.');
    expect(result.passed).toBe(true);
    expect(result.message).toContain('The tools called (web_search, send_email) fit 100%');
  });

  it('a second name for an entry already called ends nothing: the tools called after it are still tools called', () => {
    const tools = [countedTool('send_invoice', 'Send an invoice to a customer by email.'), countedTool('read_file', 'Read one source file.')];
    // read_file under two names, and then the tool that fits the ask.
    const result = judge(tools.map((t) => t.tool), ['mcp__a__read_file', 'mcp__b__read_file', 'send_invoice']);
    expect(result.passed).toBe(true);
    expect(result.message).toContain('Every tool in the catalogue was called');
  });

  it('every name the run called is in the message, a second name for an entry already called among them', () => {
    const tools = [countedTool('send_invoice', 'Send an invoice to a customer by email.'), countedTool('read_file', 'Read one source file.')];
    const result = judge(tools.map((t) => t.tool), ['mcp__a__read_file', 'mcp__b__read_file']);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("mcp__a__read_file, read as the catalogue's read_file");
    expect(result.message).toContain("mcp__b__read_file, read as the catalogue's read_file");
  });

  it('an entry’s words are taken once an evaluation, not once a process: changed between two evaluations of one context, they are taken again', () => {
    const mailer = { name: 'mailer', description: 'Read one source file.' } as ToolDescriptor;
    const context = { input: ask, output: 'Sent.', tools: [{ name: 'send_invoice', description: 'Send an invoice.' }, mailer], toolCalls: [{ tool_name: 'send_invoice', input: {} }] } as EvalContext;
    expect(toolChoice.evaluate(context).passed).toBe(true);
    (mailer as { description: string }).description = 'Send an invoice to a customer by email.';
    const second = toolChoice.evaluate(context);
    expect(second.passed).toBe(false);
    expect(second.message).toContain('mailer fits 100%');
  });

  it('actionableTerms answers as it did: the ask’s terms some tool in the catalogue mentions', () => {
    const tools = [
      { name: 'send_invoice', description: 'Send an invoice to a customer by email.' },
      { name: 'read_file', description: 'Read one source file.', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } } },
    ] as ToolDescriptor[];
    const terms = new Set(contentTerms('Send the invoice to the customer acme by email, and read the file path.'));
    // Every term of the ask but the customer's name, which no tool mentions.
    const unmentioned = contentTerms('acme');
    expect(unmentioned).toHaveLength(1);
    const actionable = actionableTerms(terms, tools);
    expect([...actionable].sort()).toEqual([...terms].filter((t) => !unmentioned.includes(t)).sort());
    expect(actionable.size).toBe(terms.size - 1);
    expect(actionableTerms(terms, [])).toEqual(new Set());
  });
});

describe('the changelog says what tool_choice takes once', () => {
  it('word for word, under Fixed in the release to come', () => {
    const changelog = readFileSync(resolve(__dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
    const unreleased = changelog.split('\n## [Unreleased]\n')[1]?.split('\n## [')[0] ?? '';
    const fixed = unreleased.split('\n### Fixed\n')[1]?.split('\n### ')[0] ?? '';
    expect(fixed).toContain(ENTRY);
  });
});

const ENTRY =
  "- **`tool_choice` takes each catalogue entry's words once an evaluation.** It took an entry's words to say what the ask can be judged on, again for every name the run called that led to the entry, and again for every entry not called. It now takes them once, in one pass over the catalogue, and every answer is as it was. Timed against the code before this change in one process, the two alternated, on 300 drawn requests, a request takes at the median 0.57 of the time it took (0.57 in each of two runs); the dearest requests found, timed again, took no longer than they did.\n  - What an embedder sees: a catalogue entry's name, description and input schema are read once an evaluation, where they were read once for each name that led to the entry and once more, so a getter that answers differently when read again is judged by its first answer. A request carries none.";
