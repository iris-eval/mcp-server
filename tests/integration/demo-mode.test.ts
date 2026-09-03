/*
 * `iris-mcp --demo` / `--demo-clear` — through the REAL CLI entry point.
 *
 * These tests spawn src/index.ts the way a user runs it, so they cover the
 * flag parsing, the demo-vs-real isolation, and the served dashboard in one
 * pass. Every spawned process gets its own scratch IRIS_HOME (the same
 * isolation contract as the stdio transport test) and IRIS_NO_AUTO_LAUNCH=1
 * so CI never opens a browser.
 *
 * The forged-Host request uses node:http, not fetch: Host is a forbidden
 * header name, so fetch silently drops the override and the guard would
 * pass for the wrong reason (see http-transport.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');
const entryPoint = join(repoRoot, 'src', 'index.ts');

let home: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'iris-demo-cli-test-'));
});

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child!.once('exit', r));
  }
  child = undefined;
  rmSync(home, { recursive: true, force: true });
});

function spawnCli(args: string[]): ChildProcess {
  // node --import tsx runs the TypeScript entry directly, matching how the
  // rest of the integration suite boots the server from source.
  const proc = spawn(process.execPath, ['--import', 'tsx', entryPoint, ...args], {
    cwd: repoRoot,
    env: { ...process.env, IRIS_HOME: home, IRIS_NO_AUTO_LAUNCH: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = proc;
  return proc;
}

function collectUntilExit(proc: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stderr = '';
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', rejectPromise);
    proc.on('exit', (code) => resolvePromise({ code, stderr }));
  });
}

/*
 * The CLI (correctly) refuses --dashboard-port 0, so ask the OS for a free
 * port up front. Small TOCTOU window, but the port is handed straight to
 * the spawned server.
 */
function freePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.on('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

function get(port: number, path: string, hostHeader: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { host: hostHeader },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', rejectPromise);
    req.end();
  });
}

describe('--demo', () => {
  it('seeds the demo db and serves the dashboard against it, real store untouched', async () => {
    const dashboardPort = await freePort();
    const proc = spawnCli(['--demo', '--dashboard-port', String(dashboardPort)]);

    let stderr = '';
    const port = await new Promise<number>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error(`Dashboard never came up. stderr so far:\n${stderr}`)),
        50_000,
      );
      proc.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        const m = stderr.match(/Dashboard available at http:\/\/localhost:(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolvePromise(Number(m[1]));
        }
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        rejectPromise(new Error(`CLI exited early with code ${code}. stderr:\n${stderr}`));
      });
    });

    // The seeded data is served — this is the "first value moment".
    const summary = await get(port, '/api/v1/summary?hours=720', `127.0.0.1:${port}`);
    expect(summary.status).toBe(200);
    const data = JSON.parse(summary.body) as { total_traces: number };
    expect(data.total_traces).toBeGreaterThan(0);

    // The DNS-rebinding guard stays intact in demo mode.
    const forged = await get(port, '/api/v1/summary', 'evil.example.com');
    expect(forged.status).toBe(403);

    // Wait for the banner (printed right after the log line we matched).
    await new Promise<void>((resolvePromise) => {
      const check = () => {
        if (stderr.includes('--demo-clear')) resolvePromise();
        else setTimeout(check, 100);
      };
      check();
    });

    // The banner says what this is and how to remove it.
    expect(stderr).toContain('IRIS DEMO MODE');
    expect(stderr).toContain('npx @iris-eval/mcp-server --demo-clear');
    // The demo db path is printed quoted — an unquoted Windows path pasted
    // into bash mangles into a stray "C:Users..." file.
    expect(stderr).toContain(`"${join(home, 'demo.db')}"`);

    // Demo data landed in demo.db; no real store was created or touched.
    expect(existsSync(join(home, 'demo.db'))).toBe(true);
    expect(existsSync(join(home, 'iris.db'))).toBe(false);
  }, 60_000);

  it('refuses trace ingest into demo.db with a clear 403 — --demo-clear would have deleted it (#372 / backlog)', async () => {
    const dashboardPort = await freePort();
    const proc = spawnCli(['--demo', '--dashboard-port', String(dashboardPort)]);

    let stderr = '';
    const port = await new Promise<number>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error(`Dashboard never came up. stderr so far:\n${stderr}`)),
        50_000,
      );
      proc.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        const m = stderr.match(/Dashboard available at http:\/\/localhost:(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolvePromise(Number(m[1]));
        }
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        rejectPromise(new Error(`CLI exited early with code ${code}. stderr:\n${stderr}`));
      });
    });

    const before = JSON.parse((await get(port, '/api/v1/summary?hours=720', `127.0.0.1:${port}`)).body) as { total_traces: number };
    expect(before.total_traces).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_name: 'real-agent', output: 'a real trace that must not land in demo.db' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Demo mode does not accept trace ingest');
    expect(body.error).toContain('--demo-clear');
    expect(body.error).toContain('iris-mcp --dashboard');

    // Nothing landed: the demo database holds exactly what it held before.
    const after = JSON.parse((await get(port, '/api/v1/summary?hours=720', `127.0.0.1:${port}`)).body) as { total_traces: number };
    expect(after.total_traces).toBe(before.total_traces);
    const listed = JSON.parse((await get(port, '/api/v1/traces?agent_name=real-agent', `127.0.0.1:${port}`)).body) as { total: number };
    expect(listed.total).toBe(0);

    // The banner says so up front.
    await new Promise<void>((resolvePromise) => {
      const check = () => (stderr.includes('--demo-clear') ? resolvePromise() : setTimeout(check, 100));
      check();
    });
    expect(stderr).toContain('Trace ingest (POST /api/v1/traces) is refused in demo mode');
  }, 60_000);

  it('refuses --demo combined with --db-path', async () => {
    const proc = spawnCli(['--demo', '--db-path', join(home, 'other.db')]);
    const { code, stderr } = await collectUntilExit(proc);
    expect(code).toBe(2);
    expect(stderr).toContain('--db-path');
  }, 30_000);

  it('refuses --demo combined with --demo-clear', async () => {
    const proc = spawnCli(['--demo', '--demo-clear']);
    const { code, stderr } = await collectUntilExit(proc);
    expect(code).toBe(2);
    expect(stderr).toContain('cannot be combined');
  }, 30_000);
});

describe('--demo-clear', () => {
  it('deletes the demo db and confirms, leaving the real store alone', async () => {
    const demoDb = join(home, 'demo.db');
    const realDb = join(home, 'iris.db');
    writeFileSync(demoDb, 'demo-bytes', 'utf-8');
    writeFileSync(realDb, 'real-bytes', 'utf-8');

    const proc = spawnCli(['--demo-clear']);
    const { code, stderr } = await collectUntilExit(proc);

    expect(code).toBe(0);
    expect(stderr).toContain('removed');
    expect(stderr).toContain('demo data cleared');
    expect(existsSync(demoDb)).toBe(false);
    expect(existsSync(realDb)).toBe(true);
  }, 30_000);

  it('exits 0 with a clear message when there is nothing to remove', async () => {
    const proc = spawnCli(['--demo-clear']);
    const { code, stderr } = await collectUntilExit(proc);
    expect(code).toBe(0);
    expect(stderr).toContain('nothing to remove');
  }, 30_000);
});
