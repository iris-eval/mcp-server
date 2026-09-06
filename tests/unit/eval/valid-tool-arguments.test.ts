/*
 * valid_tool_arguments (arc 4, A4-5).
 *
 * The proof family measures the rule against its definition on trajectories
 * it JUDGES. This file holds the paths the family must not contain, and the
 * reason is a defect in the harness that is older than this rule:
 * `proof/run.ts` scores a SKIPPED case as *not failed*. A skipping negative
 * is therefore a free true negative, which inflates specificity, which
 * inflates the published positive predictive value — and since arc 3 that
 * number is arithmetic inside the verdict. So skip behaviour is proved here,
 * where a skip is asserted as a skip.
 */
import { describe, expect, it } from 'vitest';
import { validToolArguments } from '../../../src/eval/rules/completeness.js';
import { resetSchemaCache } from '../../../src/eval/schema-validator.js';
import type { EvalContext } from '../../../src/types/eval.js';
import type { ToolDescriptor } from '../../../src/types/trace.js';

const READ: ToolDescriptor = {
  name: 'read_file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

const run = (context: Partial<EvalContext>) => validToolArguments.evaluate({ output: 'done', ...context } as EvalContext);

describe('valid_tool_arguments — the paths that skip', () => {
  it('skips, naming the Need, when there is no trajectory at all', () => {
    const r = run({ tools: [READ] });
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toContain('not provided');
    expect(r.passed).toBe(false);
  });

  it('skips, naming the catalogue, when a trajectory arrives without one', () => {
    const r = run({ toolCalls: [{ tool_name: 'read_file', input: {} }] });
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toContain('context.tools not provided');
    // An unchecked call is never a pass: a schema nobody supplied cannot
    // clear a call, and saying otherwise is the fail-open this arc is about.
    expect(r.passed).toBe(false);
  });

  it('skips when the only tool called declares no schema — not_applicable, not config_invalid', () => {
    const r = run({
      toolCalls: [{ tool_name: 'legacy', input: { anything: 1 } }],
      tools: [{ name: 'legacy' }],
    });
    expect(r.skipped).toBe(true);
    // A catalogue with nothing to check against is not a BROKEN catalogue.
    // The difference decides whether a deployment that promotes this rule to
    // critical gets `unknown` or merely coverage.
    expect(r.configInvalid ?? false).toBe(false);
  });

  it('skips as config_invalid when the schema itself was refused, and names the tool and the reason', () => {
    resetSchemaCache();
    const r = run({
      toolCalls: [{ tool_name: 'grep', input: { q: 'x' } }],
      tools: [{ name: 'grep', inputSchema: { type: 'object', properties: { q: { type: 'string', pattern: '^(a+)+$' } } } }],
    });
    expect(r.skipped).toBe(true);
    expect(r.configInvalid).toBe(true);
    expect(r.skipReason).toContain('grep');
    expect(r.message).toMatch(/star height|backtrack/i);
  });

  it('skips when the deployment turned argument checking off, and names the key', () => {
    const r = run({
      toolCalls: [{ tool_name: 'read_file', input: {} }],
      tools: [READ],
      customConfig: { validate_tool_arguments: false },
    });
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toContain('eval.validateToolArguments');
  });
});

describe('valid_tool_arguments — partial evidence is reported, not hidden', () => {
  it('judges what it can when one tool is checkable and another is not', () => {
    const r = run({
      toolCalls: [
        { tool_name: 'legacy', input: { anything: 1 } },
        { tool_name: 'read_file', input: {} },
      ],
      tools: [{ name: 'legacy' }, READ],
    });
    expect(r.skipped ?? false).toBe(false);
    expect(r.passed).toBe(false);
    // The reader is told how much was actually examined.
    expect(r.message).toContain('not checked');
    const counts = (r.evidence ?? []).filter((e) => e.type === 'count').map((e) => (e as { stat: string }).stat);
    expect(counts).toContain('calls_checked');
    expect(counts).toContain('calls_unchecked');
  });

  it('a recovered call is recorded on a PASSING result, so the retry is visible', () => {
    const r = run({
      toolCalls: [
        { tool_name: 'read_file', input: {} },
        { tool_name: 'read_file', input: { path: 'a.ts' } },
      ],
      tools: [READ],
    });
    expect(r.passed).toBe(true);
    expect(r.message).toContain('retried successfully');
    const labels = (r.evidence ?? []).filter((e) => e.type === 'toolCall').map((e) => (e as { label: string }).label);
    expect(labels.some((l) => l.includes('recovered by a later call'))).toBe(true);
  });

  it('evidence names the pointer and the keyword, never the argument value', () => {
    const r = run({
      toolCalls: [{ tool_name: 'read_file', input: { path: 42, secret: 'sk-live-must-not-appear' } }],
      tools: [READ],
    });
    const text = JSON.stringify(r.evidence) + r.message;
    expect(text).toContain('/path');
    expect(text).toContain('type');
    // Argument values are attacker-controlled and are never echoed into a
    // stored evidence row or onto a dashboard.
    expect(text).not.toContain('sk-live-must-not-appear');
  });

  it('a tool absent from the catalogue is never recovered by a later good call to it', () => {
    const r = run({
      toolCalls: [
        { tool_name: 'deploy', input: { env: 'prod' } },
        { tool_name: 'deploy', input: { env: 'prod' } },
      ],
      tools: [READ],
    });
    expect(r.passed).toBe(false);
    expect(r.message).toContain('not in the catalogue');
  });
});
