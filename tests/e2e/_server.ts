/*
 * A second Iris server for one test (arc 7, D-9): its own free port, its
 * own IRIS_HOME under the OS temp dir, the flags the state under test
 * needs, killed when the test ends. One definition — the demo state
 * (header.spec.ts), the empty database, the first run and the api-key
 * sign-in all start a server this way.
 *
 * A port the OS says is free, never a fixed number: a fixed port is
 * answered by whatever is already listening there, and a server left over
 * from an earlier run then passes or fails the test on its own behalf
 * (2026-09-07: a stale non-demo server on the fixed port hid the DEMO chip
 * twice).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SpawnedServer {
  port: number;
  baseUrl: string;
  home: string;
  stop(): Promise<void>;
}

export function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

function exited(child: ChildProcess, budgetMs = 10_000): Promise<void> {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null) return resolveExit();
    const timer = setTimeout(resolveExit, budgetMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

export async function waitForHealth(url: string, budgetMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no health answer at ${url} within ${budgetMs} ms`);
}

/**
 * Start `node dist/index.js --dashboard --dashboard-port <free>` with the
 * extra flags and environment given, under a fresh IRIS_HOME (so the
 * database, the rules file, the audit log and the preferences are all
 * this server's own), and wait for its health answer.
 */
export async function startServer(options: { args?: string[]; env?: Record<string, string>; prefix?: string } = {}): Promise<SpawnedServer> {
  const home = mkdtempSync(join(tmpdir(), options.prefix ?? 'iris-e2e-server-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['dist/index.js', '--dashboard', '--dashboard-port', String(port), ...(options.args ?? [])], {
    env: { ...process.env, IRIS_HOME: home, IRIS_NO_AUTO_LAUNCH: '1', ...(options.env ?? {}) },
    // stdin stays open: the MCP transport on stdio exits on EOF.
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(`${baseUrl}/api/v1/health`);
  } catch (err) {
    child.kill();
    await exited(child);
    throw err;
  }
  return {
    port,
    baseUrl,
    home,
    async stop() {
      child.kill();
      await exited(child);
    },
  };
}
