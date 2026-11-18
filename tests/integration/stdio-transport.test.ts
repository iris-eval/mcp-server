import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
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
    rmSync(irisHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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

      /*
       * An error a tool answers reaches this client with its code. Having
       * listed the tools, the SDK's client checks the structured content of
       * every result against the tool's output schema: while the error
       * envelope went out as structured content, a client like this one
       * threw the whole result away.
       */
      const refused = (await client.callTool({ name: 'evaluate_output', arguments: { output: 'x', trace_id: 'f'.repeat(32) } })) as { isError?: boolean; structuredContent?: unknown; content: Array<{ type: string; text?: string }> };
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toBeUndefined();
      const envelope = JSON.parse(refused.content.find((c) => c.type === 'text')?.text ?? '{}') as { error?: { code?: string; recovery?: string[] } };
      expect(envelope.error?.code).toBe('IRIS_UNKNOWN_TRACE');
      expect(envelope.error?.recovery?.length).toBeGreaterThan(0);
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

  it('answers a tool call nested deeper than a message can be written out, with the limit named, and keeps serving', async () => {
    /*
     * The server as a client starts it, and each request written to its
     * stdin as the line of text a client writes: a client's own
     * JSON.stringify cannot write a value nested this deep, and the
     * server's size check wrote every message out the same way. From about
     * 4,800 levels that threw, and the request was never answered (#1040).
     */
    const serverPath = resolve(import.meta.dirname, '../../src/index.ts');
    const home = mkdtempSync(join(tmpdir(), 'iris-stdio-depth-'));
    const child = spawn(process.execPath, ['--import', 'tsx', serverPath], {
      cwd: resolve(import.meta.dirname, '../..'),
      env: { ...getDefaultEnvironment(), IRIS_HOME: home },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    type Answer = { id?: number; result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    const waiting = new Map<number, (answer: Answer) => void>();
    let buffered = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        if (line.trim() === '') continue;
        const message = JSON.parse(line) as Answer;
        if (typeof message.id === 'number') waiting.get(message.id)?.(message);
      }
    });
    const ask = (id: number, method: string, paramsText: string): Promise<Answer | 'no answer'> => {
      const answered = new Promise<Answer | 'no answer'>((done) => {
        waiting.set(id, done);
        setTimeout(() => done('no answer'), 20_000).unref();
      });
      child.stdin.write(`{"jsonrpc":"2.0","id":${id},"method":"${method}","params":${paramsText}}\n`);
      return answered;
    };
    const call = (input: string): string => `{"name":"evaluate_output","arguments":{"output":"The file was read.","tool_calls":[{"tool_name":"read_file","input":${input}}]}}`;
    try {
      expect(await ask(1, 'initialize', JSON.stringify({ protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'stdio-depth-test', version: '0.1.0' } }))).toHaveProperty('result');
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      for (const [id, levels] of [[2, 5_000], [3, 50_000]] as const) {
        const answer = await ask(id, 'tools/call', call(`${'['.repeat(levels)}1${']'.repeat(levels)}`));
        expect(answer, `${levels} arrays`).not.toBe('no answer');
        const result = (answer as Answer).result;
        expect(result?.isError, `${levels} arrays`).toBe(true);
        expect(result?.content?.[0]?.text, `${levels} arrays`).toContain("This call's arguments nest more than 256 levels deep, the limit (security.maxInputDepth, or IRIS_MAX_INPUT_DEPTH)");
      }
      // The session survives the refusals.
      const after = await ask(4, 'tools/call', call('{"path":"src/a.ts"}'));
      expect(after).not.toBe('no answer');
      expect((after as Answer).result?.isError ?? false).toBe(false);
    } finally {
      child.kill();
      try {
        rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        /* still held by the exiting child */
      }
    }
  }, 60000);
});
