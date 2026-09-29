/*
 * Revoking an API key while the server runs: the next request with it is
 * refused, and the browser sessions it opened end, with no restart.
 *
 * Through the REAL CLI entry point, on both of its HTTP servers: the MCP
 * transport (`--transport http`) and the dashboard. config.json holds two
 * keys by hash. With the server up, a browser signs in with the leaked key
 * and both keys pass the Bearer check on both ports. Then config.json is
 * rewritten without the leaked key, as an operator would, and the very
 * next requests are checked:
 *   - the leaked key on the Bearer path: 403 "Invalid API key" on both ports
 *     (the status a wrong key has always had; a missing key is 401);
 *   - its browser session: the page answers 401 with the sign-in form and
 *     the API answers 401;
 *   - the other key, and a session opened with it: unchanged.
 * Until 0.20.0 all of the leaked key's access survived until a restart.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sha256Hex } from '../../src/security/keys.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const entryPoint = join(repoRoot, 'src', 'index.ts');
const BOOT_MS = 50_000;
const HTML = { accept: 'text/html,application/xhtml+xml' };

let home: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'iris-key-revoke-'));
});

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
  child = undefined;
  // Windows keeps the SQLite file busy for a moment after the process dies.
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function freePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createServer());
  for (const s of servers) {
    s.listen(0, '127.0.0.1');
    await once(s, 'listening');
  }
  const ports = servers.map((s) => (s.address() as { port: number }).port);
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  return ports;
}

function waitForLog(proc: ChildProcess, pattern: RegExp): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let out = '';
    const timer = setTimeout(() => rejectPromise(new Error(`never logged ${pattern}:\n${out}`)), BOOT_MS);
    const onData = (chunk: Buffer) => {
      out += chunk.toString();
      if (pattern.test(out)) {
        clearTimeout(timer);
        resolvePromise();
      }
    };
    proc.stderr!.on('data', onData);
    proc.stdout!.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`CLI exited early with code ${code}:\n${out}`));
    });
  });
}

const LEAKED = 'leaked-key-4c1d9e';
const KEPT = 'kept-key-8a27f0';
const keys = (ids: Array<'leaked' | 'kept'>) =>
  JSON.stringify({
    security: {
      apiKeys: ids.map((id) => ({ id, keyHash: sha256Hex(id === 'leaked' ? LEAKED : KEPT) })),
    },
  });

describe('revoking a key on a running server', () => {
  it('the next request with a key removed from config.json is refused on both ports, and its browser sessions end', async () => {
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, keys(['leaked', 'kept']));
    const [mcpPort, dashPort] = await freePorts(2);
    child = spawn(
      process.execPath,
      ['--import', 'tsx', entryPoint, '--transport', 'http', '--port', String(mcpPort), '--dashboard', '--dashboard-port', String(dashPort)],
      {
        cwd: repoRoot,
        env: { ...process.env, IRIS_HOME: home, IRIS_NO_AUTO_LAUNCH: '1', IRIS_LOG_LEVEL: 'info', IRIS_API_KEY: '', IRIS_API_KEY_FILE: '', IRIS_ALLOW_UNAUTHENTICATED: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    await waitForLog(child, /Dashboard available at/);
    const dash = `http://127.0.0.1:${dashPort}`;
    const mcp = `http://127.0.0.1:${mcpPort}`;
    // The dashboard may log before it accepts; wait for its health.
    for (let i = 0; i < 100; i++) {
      if ((await fetch(`${dash}/api/v1/health`).catch(() => null))?.ok) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const bearer = (base: string, path: string, key: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}` } });
    const signIn = async (key: string): Promise<string> => {
      const res = await fetch(`${dash}/session`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: dash },
        body: new URLSearchParams({ key }).toString(),
      });
      expect(res.status).toBe(303);
      return (res.headers.get('set-cookie') ?? '').split(';')[0];
    };
    const page = (cookie: string) => fetch(`${dash}/traces`, { headers: { ...HTML, cookie }, redirect: 'manual' });
    const api = (cookie: string) => fetch(`${dash}/api/v1/summary`, { headers: { cookie } });
    // Any answer but 401/403 from /mcp means the key was accepted and the MCP layer answered.
    const mcpAccepts = async (key: string) => ![401, 403].includes((await bearer(mcp, '/mcp', key)).status);

    const leakedSession = await signIn(LEAKED);
    const keptSession = await signIn(KEPT);
    expect((await bearer(dash, '/api/v1/summary', LEAKED)).status).toBe(200);
    expect(await mcpAccepts(LEAKED)).toBe(true);
    expect((await api(leakedSession)).status).toBe(200);
    expect((await page(leakedSession)).status).not.toBe(401);

    // Revoke: the operator removes the leaked key from config.json. No restart, no signal.
    writeFileSync(configPath, keys(['kept']));

    const revokedDash = await bearer(dash, '/api/v1/summary', LEAKED);
    expect(revokedDash.status).toBe(403);
    expect(await revokedDash.json()).toEqual({ error: 'Invalid API key' });
    expect((await bearer(mcp, '/mcp', LEAKED)).status).toBe(403);
    expect((await api(leakedSession)).status).toBe(401);
    const signedOut = await page(leakedSession);
    expect(signedOut.status).toBe(401);
    expect(await signedOut.text()).toContain('<form');

    // The key that was not revoked, and its session, carry on.
    expect((await bearer(dash, '/api/v1/summary', KEPT)).status).toBe(200);
    expect(await mcpAccepts(KEPT)).toBe(true);
    expect((await api(keptSession)).status).toBe(200);
  }, 90_000);
});
