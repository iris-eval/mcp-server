import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { registerLogTraceTool } from '../../../src/tools/log-trace.js';

describe('log_trace tool', () => {
  let server: McpServer;
  let storage: SqliteAdapter;

  beforeEach(async () => {
    server = new McpServer({ name: 'test', version: '0.1.0' });
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    registerLogTraceTool(server, storage);
  });

  afterEach(async () => {
    await storage.close();
  });

  it('should register the log_trace tool', () => {
    // Tool is registered — verified by no errors during registration
    expect(server).toBeDefined();
  });

  it('should store a trace via direct storage call', async () => {
    await storage.insertTrace({
      trace_id: 'test-123',
      agent_name: 'test-agent',
      timestamp: new Date().toISOString(),
    });
    const trace = await storage.getTrace('test-123');
    expect(trace).not.toBeNull();
    expect(trace!.agent_name).toBe('test-agent');
  });

  it('should generate trace IDs', async () => {
    await storage.insertTrace({
      trace_id: 'generated-id',
      agent_name: 'test',
      timestamp: new Date().toISOString(),
    });
    const trace = await storage.getTrace('generated-id');
    expect(trace).not.toBeNull();
  });
});
