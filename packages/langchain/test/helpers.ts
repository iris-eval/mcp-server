/*
 * The real Iris server the end-to-end tests send to: this checkout's build,
 * keyed, in a scratch IRIS_HOME.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** build/test/helpers.js → packages/langchain → the repository. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

export interface Iris {
  url: string;
  apiKey: string;
  /** GET /api/v1/traces/:id — the trace, its spans and its evaluations, as the server stored them. */
  trace(id: string): Promise<{ trace: any; spans: any[]; evals: any[] }>;
  stop(): Promise<void>;
}

/** What the server printed while starting, for the error when it did not. */
let launchLog = '';

async function launch(entry: string, home: string, apiKey: string): Promise<{ child: ChildProcess; url: string } | undefined> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [entry, '--dashboard', '--dashboard-port', String(port), '--api-key', apiKey], {
    env: { ...process.env, IRIS_HOME: home, IRIS_NO_AUTO_LAUNCH: '1', IRIS_URL: '', IRIS_API_KEY: '' },
    // stdin stays open: the MCP transport is stdio, and it ends the process when stdin closes.
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => (launchLog += String(d)));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/api/v1/health`);
      if (res.status === 200 || res.status === 503) return { child, url };
    } catch {
      // not up yet
    }
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill();
      return undefined;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** This checkout's server (`npm run build:server` at the repository root first), keyed, on a free port, in a scratch home. */
export async function startIris(): Promise<Iris> {
  const entry = join(REPO_ROOT, 'dist', 'index.js');
  if (!existsSync(entry)) throw new Error(`No server build at ${entry}: run \`npm run build:server\` at the repository root first`);
  const home = mkdtempSync(join(tmpdir(), 'iris-sdk-test-'));
  const apiKey = 'sdk-test-key';
  // A free port can be taken between choosing it and binding it; another attempt picks another.
  let started: { child: ChildProcess; url: string } | undefined;
  for (let attempt = 0; attempt < 3 && !started; attempt += 1) started = await launch(entry, home, apiKey);
  if (!started) throw new Error(`Iris did not start:\n${launchLog}`);
  const { child, url } = started;
  return {
    url,
    apiKey,
    async trace(id) {
      const res = await fetch(`${url}/api/v1/traces/${id}`, { headers: { authorization: `Bearer ${apiKey}` } });
      if (!res.ok) throw new Error(`GET /api/v1/traces/${id} → ${res.status}: ${await res.text()}`);
      return (await res.json()) as Awaited<ReturnType<Iris['trace']>>;
    },
    async stop() {
      child.stdin?.end();
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r(undefined) : child.once('exit', r)));
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
