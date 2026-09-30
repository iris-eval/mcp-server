/*
 * The server started and stopped over stdio, again and again, ends every
 * session cleanly.
 *
 * Each cycle is a real server process: an MCP client connects, logs and
 * evaluates traces and searches them (statements prepared and freed while
 * V8 collects), then ends the session the way MCP clients do, by closing
 * the server's stdin. Every process must shut down in order ("Shutdown
 * complete", the store closed), exit 0 with no signal, and never print a
 * native assertion. The young generation is kept small so V8 collects
 * many times inside each short session: a statement freed in a session is
 * collected in that session, which is where a better-sqlite3 binary
 * compiled against Node 24.19+ headers aborts (nodejs/node#65446). On
 * that binary Iris must hold the store with Node's built-in SQLite; the
 * CI job that compiles better-sqlite3 from source runs this file there.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativeAbortsOnCollect, nativeBinaryPath } from '../../src/storage/driver.js';

const ENTRY = resolve(import.meta.dirname, '../../src/index.ts');
const CYCLES = 6;
const CALLS = 25;

interface Session {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

async function session(home: string): Promise<Session> {
  const child = spawn(process.execPath, ['--max-semi-space-size=1', '--import', 'tsx', ENTRY], {
    env: { ...process.env, IRIS_HOME: home, IRIS_DB_PATH: join(home, 'iris.db'), IRIS_NO_AUTO_LAUNCH: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<Session>((done) => child.on('exit', (code, signal) => done({ code, signal, stderr })));

  const pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
  let buffered = '';
  child.stdout.on('data', (d: Buffer) => {
    buffered += d.toString();
    for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    }
  });
  let nextId = 0;
  const request = (method: string, params: unknown) => {
    const id = ++nextId;
    const answered = new Promise<{ result?: unknown; error?: unknown }>((r) => pending.set(id, r));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    // A process that dies mid-session answers nothing: the exit settles the wait.
    return Promise.race([answered, exited.then(() => ({ error: 'the server exited' }))]);
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const msg = await request('tools/call', { name, arguments: args });
    expect(msg.error, `${name} answered; the server's stderr ends:\n${stderr.slice(-2000)}`).toBeUndefined();
  };

  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teardown', version: '1.0.0' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  for (let i = 0; i < CALLS; i++) {
    await call('log_trace', { agent_name: 'support-bot', input: `question ${i} about an order`, output: `Your order ${i} ships on Tuesday; the refund for order ${i - 1} was approved.` });
    await call('evaluate_output', { output: `Order ${i} ships Tuesday. Contact support@example.com for help.`, eval_type: 'completeness' });
    await call('get_traces', { q: 'refund approved', limit: 5 });
  }
  child.stdin.end();
  return exited;
}

describe('repeated start and stop over stdio', () => {
  it(`${CYCLES} sessions each end with the store closed, exit 0, and no native abort`, async () => {
    const chosen = process.env.IRIS_SQLITE_DRIVER === 'node' ? 'node' : nativeAbortsOnCollect(nativeBinaryPath()) ? 'node' : 'better-sqlite3';
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const home = mkdtempSync(join(tmpdir(), 'iris-teardown-'));
      try {
        const s = await session(home);
        expect(s.stderr, `cycle ${cycle}: no native assertion`).not.toMatch(/Assertion failed|Native stack trace/);
        expect({ cycle, code: s.code, signal: s.signal }).toEqual({ cycle, code: 0, signal: null });
        expect(s.stderr, `cycle ${cycle}: the end of stdin shut the server down in order`).toContain('Shutdown complete');
        expect(s.stderr, `cycle ${cycle}: the store was held by the driver Iris chose for this binary`).toContain(`driver ${chosen}:`);
      } finally {
        rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }
  }, 180_000);
});
