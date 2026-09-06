/*
 * The tools catalogue — what the agent could have called.
 *
 * Iris has always stored what an agent DID and never what it was ABLE to do.
 * That absence is why argument validity has no evaluator: a call can only be
 * judged against the schema its own tool declares, and nothing held that
 * schema. The catalogue closes it, and it is carried in the MCP `tools/list`
 * shape verbatim so an MCP agent pastes the result it already has.
 *
 * Server-only, like the step layer and for the same reason: the website's
 * vendored rule library has no catalogue and never will, so pinning this
 * would ship it into a browser bundle for a path that cannot be taken.
 */
import { createHash } from 'node:crypto';
import type { EvalContext } from '../types/eval.js';
import type { Step, ToolDescriptor } from '../types/trace.js';

/**
 * The most tools one catalogue may carry, and the most bytes it may occupy.
 *
 * Enforced at INGEST as a rejection, never as a truncation. A truncated
 * catalogue makes "this tool is not in the catalogue" a lie, and that
 * sentence is evidence on a security-relevant failure class — an agent
 * calling a tool that does not exist is inventing capability. Refusing the
 * body names the limit and the actual size; silently keeping the first two
 * hundred would produce confident false findings for as long as nobody
 * noticed.
 */
export const MAX_TOOLS = 200;
export const MAX_TOOLS_BYTES = 262_144;

/**
 * Tool names that read rather than act, when the catalogue does not say.
 *
 * Only ever consulted as a FALLBACK, and only by signals that are allowed to
 * be approximate. `annotations.readOnlyHint` is the tool author's own
 * statement and is preferred wherever it exists; the MCP specification is
 * explicit that even that hint must not be relied on for security, so
 * neither it nor this list may inform a safety veto.
 *
 * A literal token list rather than a pattern: the same reason tool OUTPUT is
 * never scanned with a regular expression, and it is cheaper anyway.
 */
export const READ_TOKENS: readonly string[] = [
  'read', 'get', 'list', 'search', 'find', 'fetch', 'query', 'view', 'show',
  'cat', 'grep', 'head', 'tail', 'stat', 'ls', 'describe', 'lookup', 'select', 'count',
];

/** The catalogue as a lookup, or null when the call carried none. */
export function catalogueIndex(context: EvalContext): Map<string, ToolDescriptor> | null {
  const tools = context.tools;
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const index = new Map<string, ToolDescriptor>();
  for (const tool of tools) index.set(tool.name, tool);
  return index;
}

/**
 * Does this step read, or act?
 *
 * Three-valued on purpose. `unknown` is a real answer — the catalogue is
 * silent and the name says nothing — and a signal built on this must decide
 * for itself whether to treat unknown as read (loosening, safe for a cost
 * signal) or to stay quiet (correct for anything that fires).
 */
export function readFamilyOf(step: Step, tools?: readonly ToolDescriptor[]): 'read' | 'not_read' | 'unknown' {
  const declared = tools?.find((tool) => tool.name === step.name)?.annotations?.readOnlyHint;
  if (declared === true) return 'read';
  if (declared === false) return 'not_read';
  const tokens = step.name.toLowerCase().split(/[-_. ]+/);
  return tokens.some((token) => READ_TOKENS.includes(token)) ? 'read' : 'unknown';
}

/**
 * A stable identity for the catalogue, over the parts a rule reads.
 *
 * Name, input schema and the read-only hint — nothing else. Two catalogues
 * differing in nothing but a description hash identically, and that is
 * correct rather than sloppy: a description edit cannot change a verdict, so
 * a hash that moved on one would make a re-evaluation unexplainable for a
 * change that never mattered.
 */
export function toolsHash(tools: readonly ToolDescriptor[] | undefined): string | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const canonical = tools
    .map((tool) => [tool.name, stableJson(tool.inputSchema ?? null), tool.annotations?.readOnlyHint ?? null])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

/** Key order is not meaning: two schemas that differ only in it are one schema. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}
