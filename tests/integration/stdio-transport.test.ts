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

  it('refuses a 2 MB output over stdio as HTTP does, and keeps serving', async () => {
    const serverPath = resolve(import.meta.dirname, '../../src/index.ts');
    /*
     * Its own home, not the suite's: on Windows the server started through
     * npx can outlive client.close() for a moment and keep its database
     * open, and a shared home then fails the suite's cleanup with EPERM.
     */
    const home = mkdtempSync(join(tmpdir(), 'iris-stdio-size-'));
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', serverPath],
      env: { ...getDefaultEnvironment(), IRIS_HOME: home },
    });
    const client = new Client({ name: 'stdio-size-test', version: '0.1.0' });
    try {
      await client.connect(transport);
      // The HTTP transport answers 413 to this body (tests/integration/http-ingest.test.ts).
      await expect(
        client.callTool({ name: 'evaluate_output', arguments: { output: 'x'.repeat(2 * 1024 * 1024) } }),
      ).rejects.toThrow(/Request too large: \d+ bytes, over the 1048576-byte limit \(security\.requestSizeLimit\)/);
      // The session survives the refusal.
      const ok = await client.callTool({ name: 'evaluate_output', arguments: { output: 'A short answer.' } });
      expect(ok.isError).toBeFalsy();
    } finally {
      await client.close();
      // A scratch directory under the OS temp dir: if the exiting server
      // still holds it, leaving it behind is harmless.
      try {
        rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        /* still held by the exiting child */
      }
    }
  }, 30000);
});
