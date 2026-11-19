/*
 * The nesting limit on a tool call (security.maxInputDepth, #1040) stands in
 * front of the one handler the MCP SDK answers every tool call from, which
 * the SDK sets on the server when the first tool is registered. If the SDK
 * set that handler some other way, the limit would stand in front of
 * nothing, and nothing would say so: a tool call nested thousands of levels
 * deep would reach the tool's schema and the rules again.
 *
 * Held here: such a server does not start. The SDK's request schema is
 * replaced, for src/server.ts only, by a copy of itself, so the handler the
 * SDK sets is never the one the server is looking for.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/types.js', async (original) => {
  const real = await original<typeof import('@modelcontextprotocol/sdk/types.js')>();
  return { ...real, CallToolRequestSchema: Object.create(real.CallToolRequestSchema) as typeof real.CallToolRequestSchema };
});

import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../src/server.js';
import { defaultConfig } from '../../src/config/defaults.js';

describe('the nesting limit and the handler it stands in front of', () => {
  it('a server that could not put the limit in front of its tool calls does not start', async () => {
    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    try {
      expect(() => createIrisServer(defaultConfig, storage, undefined, { warn: () => {} })).toThrow(
        'The nesting limit (security.maxInputDepth) could not be put in front of tool calls: the MCP SDK did not set its tools/call handler where the limit stands.',
      );
    } finally {
      await storage.close();
    }
  });
});
