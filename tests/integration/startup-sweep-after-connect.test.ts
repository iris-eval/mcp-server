/*
 * The boot retention sweep starts after the MCP connection opens.
 *
 * A stdio client waits for the server's answer to `initialize`. The sweep
 * used to run before the transport connected, as one transaction, so a
 * store with a day's traces past the window kept every client waiting for
 * the whole sweep (12 s at 100,000 agent-loop traces with 3% due, measured
 * on the machine in the changelog). It now starts once the transport is
 * connected and runs in steps (src/storage/search-index.ts). This starts
 * the real server over stdio on a store with traces past the window, and
 * requires the log to say the transport connected before the sweep
 * reported, and the swept traces to be gone. And the work that now runs
 * after the start (the sweep, the checkpoint worker) must never keep the
 * process alive once its client has gone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';

const KEPT = 40;
const DUE = 20;

describe('the boot sweep runs after the transport connects', () => {
  let irisHome: string;

  beforeAll(async () => {
    irisHome = mkdtempSync(join(tmpdir(), 'iris-sweep-after-connect-'));
    const store = new SqliteAdapter(join(irisHome, 'iris.db'));
    await store.initialize();
    const day = 86_400_000;
    await store.insertTraces(
      LOCAL_TENANT,
      Array.from({ length: KEPT + DUE }, (_, i) => ({
        trace_id: `t-${i}`,
        agent_name: 'support-bot',
        output: `reply ${i}`,
        // The default window is 30 days.
        timestamp: new Date(Date.now() - (i < DUE ? 45 : 1) * day).toISOString(),
      })),
    );
    await store.close();
  }, 60_000);

  afterAll(() => {
    rmSync(irisHome, { recursive: true, force: true });
  });

  it('logs "Stdio transport connected" before the sweep reports, and the swept traces are gone', async () => {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', resolve(import.meta.dirname, '../../src/index.ts')],
      env: { ...getDefaultEnvironment(), IRIS_HOME: irisHome, IRIS_DB_PATH: join(irisHome, 'iris.db'), IRIS_LOG_LEVEL: 'info' },
      stderr: 'pipe',
    });
    let log = '';
    transport.stderr?.on('data', (b: Buffer) => (log += b.toString('utf8')));
    const client = new Client({ name: 'sweep-after-connect', version: '0.1.0' });
    try {
      await client.connect(transport);
      const deadline = Date.now() + 60_000;
      while (!log.includes('Retention cleanup') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      const connected = log.indexOf('Stdio transport connected');
      const swept = log.indexOf(`Retention cleanup: deleted ${DUE} trace(s)`);
      expect(connected, log).toBeGreaterThan(-1);
      expect(swept, log).toBeGreaterThan(-1);
      expect(connected).toBeLessThan(swept);
      const page = JSON.parse(((await client.callTool({ name: 'get_traces', arguments: { limit: 1 } })) as { content: Array<{ text: string }> }).content[0].text) as { total: number };
      expect(page.total).toBe(KEPT);
    } finally {
      await client.close();
    }
  }, 120_000);

  it('exits by itself when its client closes stdin: nothing in the background holds the process open', async () => {
    // node itself, not npx, so the process that must exit is the one watched.
    const child = spawn(process.execPath, ['--import', 'tsx', resolve(import.meta.dirname, '../../src/index.ts')], {
      env: { ...process.env, IRIS_HOME: irisHome, IRIS_DB_PATH: join(irisHome, 'iris.db') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.resume();
    const answered = new Promise<void>((resolveAnswer) => child.stdout.once('data', () => resolveAnswer()));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'exit', version: '0' } } })}\n`);
    await answered;
    // Long enough for the checkpoint worker to be up and the boot sweep to have run.
    await new Promise((r) => setTimeout(r, 1500));
    const exited = new Promise<number | null>((resolveExit) => child.once('exit', (code) => resolveExit(code)));
    child.stdin.end();
    const code = await Promise.race([exited, new Promise<'still running'>((r) => setTimeout(() => r('still running'), 10_000))]);
    if (code === 'still running') child.kill();
    expect(code).toBe(0);
  }, 60_000);
});
