/*
 * Reading what an MCP client got back, with the SDK's own types.
 *
 * `client.callTool` answers a union: the content form every Iris tool
 * returns, or the legacy `{ toolResult }` form an older server may send; a
 * resource read answers text or a blob. A test that pretends the union away
 * with a cast reads `undefined` the day the other branch comes back and
 * fails somewhere else. These narrow it, and throw naming what arrived.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export type ToolResult = Awaited<ReturnType<Client['callTool']>>;
export type ResourceResult = Awaited<ReturnType<Client['readResource']>>;

/** The content blocks of a tool result; throws on the legacy `toolResult` form. */
export function contentOf(r: ToolResult) {
  if (!('content' in r) || !Array.isArray(r.content)) throw new Error(`expected a content result, got keys: ${Object.keys(r).join(', ')}`);
  return r.content;
}

/** The text of the tool result's block at `index` (the first by default); throws when it is not a text block. */
export function textOf(r: ToolResult, index = 0): string {
  const block = contentOf(r)[index];
  if (block?.type !== 'text') throw new Error(`expected a text block at ${index}, got ${block?.type ?? 'nothing'}`);
  return block.text;
}

/** The text of a resource read's content at `index`; throws when it is a blob. */
export function resourceTextOf(r: ResourceResult, index = 0): string {
  const content = r.contents[index];
  if (content === undefined || !('text' in content) || typeof content.text !== 'string') throw new Error(`expected text content at ${index}, got ${content === undefined ? 'nothing' : Object.keys(content).join(', ')}`);
  return content.text;
}
