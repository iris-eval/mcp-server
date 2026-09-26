/*
 * The two things every end-to-end test here runs against: a real Iris
 * server (this checkout's build, keyed, in a scratch IRIS_HOME) and the
 * scripted provider the official SDKs are pointed at.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** build/test/helpers.js → packages/sdk → the repository. */
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
  trace(id: string): Promise<{ trace: Record<string, any>; spans: Array<Record<string, any>>; evals: Array<Record<string, any>> }>;
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

export interface Provider {
  url: string;
  port: number;
  requests: Array<{ path: string; body: Record<string, any>; headers: Record<string, unknown> }>;
  close(): Promise<void>;
}

export const REPLIES = {
  default: 'The capital of France is Paris.',
  ssn: 'Her SSN is 123-45-6789.',
  afterTool: 'It is 18 degrees and sunny in Paris.',
};

/** The scripted provider, in this process: tests/fixtures/scripted-provider/server.mjs. */
export async function startProvider(): Promise<Provider> {
  const module = (await import(pathToFileURL(join(REPO_ROOT, 'tests', 'fixtures', 'scripted-provider', 'server.mjs')).href)) as {
    startScriptedProvider: () => Promise<Provider>;
    REPLIES: typeof REPLIES;
  };
  if (JSON.stringify(module.REPLIES) !== JSON.stringify(REPLIES)) throw new Error('the scripted provider\'s replies changed; update test/helpers.ts');
  return module.startScriptedProvider();
}
