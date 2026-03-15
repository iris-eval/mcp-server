import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { registerGetTracesTool } from '../../../src/tools/get-traces.js';
import { allSampleTraces } from '../../fixtures/sample-traces.js';

describe('get_traces tool', () => {
  let server: McpServer;
  let storage: SqliteAdapter;

  beforeEach(async () => {
    server = new McpServer({ name: 'test', version: '0.1.0' });
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    registerGetTracesTool(server, storage);

    for (const trace of allSampleTraces) {
      await storage.insertTrace(trace);
    }
  });

  afterEach(async () => {
    await storage.close();
  });

  it('should register the get_traces tool', () => {
    expect(server).toBeDefined();
  });

  it('should query traces with filters', async () => {
    const result = await storage.queryTraces({
      filter: { agent_name: 'test-agent' },
    });
    expect(result.total).toBe(1);
    expect(result.traces[0].agent_name).toBe('test-agent');
  });

  it('should support pagination', async () => {
    const result = await storage.queryTraces({ limit: 2, offset: 0 });
    expect(result.traces.length).toBe(2);
    expect(result.total).toBe(allSampleTraces.length);
  });

  it('should return summary stats', async () => {
    const summary = await storage.getDashboardSummary(24 * 365 * 10);
    expect(summary.total_traces).toBe(allSampleTraces.length);
    expect(summary.top_agents.length).toBeGreaterThan(0);
  });
});
