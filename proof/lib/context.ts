/*
 * The EvalContext a corpus case declares: the text fields plus any extra
 * context keys (cost, tokens, tool calls, metadata, custom config). Shared by
 * the per-rule runner, the transforms run and the custom-type conformance
 * run so one case materialises the same way everywhere.
 */
import type { EvalContext } from '../../src/types/eval.js';
import type { materialiseCase } from './materialise.js';

export function contextFor(c: ReturnType<typeof materialiseCase>, fileConfig?: Record<string, unknown>): EvalContext {
  const ctx: EvalContext = { output: c.output };
  if (c.input !== undefined) ctx.input = c.input;
  if (c.expected !== undefined) ctx.expected = c.expected;
  if (fileConfig && Object.keys(fileConfig).length > 0) ctx.customConfig = { ...fileConfig };
  if (c.context) {
    const extra = c.context as Partial<EvalContext>;
    if (extra.costUsd !== undefined) ctx.costUsd = extra.costUsd;
    if (extra.tokenUsage !== undefined) ctx.tokenUsage = extra.tokenUsage;
    if (extra.toolCalls !== undefined) ctx.toolCalls = extra.toolCalls;
    if (extra.metadata !== undefined) ctx.metadata = extra.metadata;
    if (extra.customConfig !== undefined) ctx.customConfig = { ...(ctx.customConfig ?? {}), ...extra.customConfig };
  }
  return ctx;
}
