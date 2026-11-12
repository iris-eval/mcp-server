/*
 * The tools catalogue — what the agent could have called.
 *
 * Iris has always stored what an agent DID and never what it was ABLE to do.
 * That absence is why argument validity has no evaluator: a call can only be
 * judged against the schema its own tool declares, and nothing held that
 * schema. The catalogue closes it, and it is carried in the MCP `tools/list`
 * shape verbatim so an MCP agent pastes the result it already has.
 *
 * A pasted `tools/list` names each tool as its server does. The host that
 * calls it may not: one that reaches its tools through MCP can call them
 * `mcp__<server>__<tool>`. So a call is looked up under the name it was
 * made by and then under the tool's own (catalogueMatch). Matched by exact
 * name alone, no call on such a host was in a catalogue pasted as
 * documented, and a correct run failed for calling tools "not in the
 * catalogue".
 *
 * A catalogue names no server, so an entry found under a tool's own name
 * may be another server's tool of that name. That bounds what such an
 * entry is taken for:
 *
 *   - its schema and its description are read, and the result says the
 *     entry was reached by the tool's own name (valid_tool_arguments,
 *     tool_choice);
 *   - its word that the tool only reads is not taken. That word stops a
 *     call counting as an action and makes a repeat count as a wasted
 *     read, and it is another tool's word when the server differs. Its
 *     word that the tool acts is taken (declaredEffect);
 *   - when two called names lead to one entry by their own name, it is the
 *     tool of at most one of them, and no call's arguments are judged by
 *     it (valid_tool_arguments).
 *
 * A deployment whose agent can reach two tools of one name lists each
 * under the name the agent calls it by, and every entry is then exact.
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
 * A tool's own name inside the name an agent calls it by. An agent that
 * reaches its tools through MCP can call them `mcp__<server>__<tool>`, and
 * the server part is the deployment's label for where the tool lives. The
 * first `__` after a server's part ends it, as Claude Code reads the names
 * it writes; a name of any other shape, one with no server's part among
 * them, is its own. So is a call that carries no name: an engine built in
 * code can be handed one, and the rules say what they make of it.
 */
export function ownToolName(name: string): string {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return name;
  const at = name.indexOf('__', 'mcp__'.length);
  return at <= 'mcp__'.length || at + 2 >= name.length ? name : name.slice(at + 2);
}

/** An entry of the catalogue found for a called tool, and how: under the name the call was made by, or under the tool's own name. */
export interface CatalogueMatch {
  tool: ToolDescriptor;
  by: 'called' | 'own';
}

/**
 * The catalogue's entry for a called tool: under the name the call was made
 * by, and when there is none, under the tool's own name. The exact name
 * wins, so a catalogue that lists two servers' tools by their full names
 * gives each call its own entry. An entry found by the own name is the
 * weaker find (this file's header says why), and `by` is how a rule tells.
 */
export function catalogueMatch(index: ReadonlyMap<string, ToolDescriptor>, calledName: string): CatalogueMatch | undefined {
  const exact = index.get(calledName);
  if (exact !== undefined) return { tool: exact, by: 'called' };
  const own = ownToolName(calledName);
  if (own === calledName) return undefined;
  const entry = index.get(own);
  return entry === undefined ? undefined : { tool: entry, by: 'own' };
}

/**
 * What the catalogue says a called tool does, as far as its word is taken.
 * An entry under the called name speaks for the tool either way. One found
 * under the tool's own name may be another server's tool, so its word is
 * taken only where it makes the call count: `readOnlyHint: false`, or
 * `destructiveHint: true` on a tool it does not call read-only. Null when
 * the catalogue says nothing that is taken.
 */
export function declaredEffect(match: CatalogueMatch | undefined): 'reads' | 'acts' | null {
  const annotations = match?.tool.annotations;
  if (match === undefined || annotations === undefined) return null;
  if (annotations.readOnlyHint === true) return match.by === 'called' ? 'reads' : null;
  if (annotations.readOnlyHint === false || annotations.destructiveHint === true) return 'acts';
  return null;
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
  const match = catalogueMatch(new Map((tools ?? []).map((tool) => [tool.name, tool] as const)), step.name);
  const declared = match?.tool.annotations?.readOnlyHint;
  // The word of an entry reached by the tool's own name is taken only where it says the tool does more than read (declaredEffect).
  if (declared === true && match?.by === 'called') return 'read';
  if (declared === false) return 'not_read';
  // The name's own words: a server's label says nothing of what its tool does.
  const tokens = ownToolName(step.name).toLowerCase().split(/[-_. ]+/);
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
