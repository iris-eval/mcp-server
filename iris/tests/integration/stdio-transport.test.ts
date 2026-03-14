import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

describe('Stdio Transport Integration', () => {
  it('should connect to server via stdio and list tools', async () => {
    const serverPath = resolve(import.meta.dirname, '../../src/index.ts');

    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', serverPath],
    });

    const client = new Client({ name: 'stdio-test', version: '0.1.0' });

    try {
      await client.connect(transport);
      const result = await client.listTools();
      expect(result.tools.length).toBeGreaterThanOrEqual(3);
      const names = result.tools.map((t) => t.name);
      expect(names).toContain('log_trace');
      expect(names).toContain('evaluate_output');
      expect(names).toContain('get_traces');
    } finally {
      await client.close();
    }
  }, 30000);
});
