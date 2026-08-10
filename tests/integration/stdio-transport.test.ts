import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('Stdio Transport Integration', () => {
  /*
   * IRIS_HOME confines the spawned server to a scratch directory.
   * Without it this test booted the server against the developer's real
   * ~/.iris — opening (and, on a branch with newer migrations,
   * silently UPGRADING) their live iris.db, and loading whatever custom
   * rules they had deployed. getDefaultEnvironment() keeps PATH etc. so
   * npx still resolves; env fully REPLACES the child environment, so
   * both must be passed together.
   */
  let irisHome: string;

  beforeAll(() => {
    irisHome = mkdtempSync(join(tmpdir(), 'iris-stdio-test-'));
  });

  afterAll(() => {
    rmSync(irisHome, { recursive: true, force: true });
  });

  it('should connect to server via stdio and list tools', async () => {
    const serverPath = resolve(import.meta.dirname, '../../src/index.ts');

    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', serverPath],
      env: { ...getDefaultEnvironment(), IRIS_HOME: irisHome },
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

      // The spawned process (not this one) must have honoured IRIS_HOME:
      // storage init creates iris.db under it at boot. This asserts the
      // isolation through the real child-env path rather than trusting
      // the in-process unit test for iris-home.
      expect(existsSync(join(irisHome, 'iris.db'))).toBe(true);
    } finally {
      await client.close();
    }
  }, 30000);
});
