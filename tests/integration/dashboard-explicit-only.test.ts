/*
 * The dashboard starts ONLY when it is asked for — through the REAL CLI.
 *
 * It used to start implicitly whenever `--transport http` was chosen. That
 * contradicted the README ("off by default"), silently put a second,
 * unauthenticated server on port 6920 next to a loopback-bound transport,
 * and — the failure a persona UAT actually hit — killed the whole process
 * when 6920 happened to be busy, AFTER the MCP transport had bound
 * successfully. An unrequested server must never be able to take down the
 * requested one.
 *
 * The other direction matters just as much, so it is asserted here too:
 * all three documented ways of asking for the dashboard have to work, or
 * "pass --dashboard instead" is advice that leads nowhere. `--dashboard`
 * carried a `default: false` that made its ABSENCE overwrite the env and
 * config-file layers, so IRIS_DASHBOARD=true and `dashboard.enabled` in
 * config.json were both dead letters.
 *
 * Every spawn gets its own scratch IRIS_HOME and IRIS_NO_AUTO_LAUNCH=1,
 * the same isolation contract as demo-mode.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect, type Server as NetServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');
const entryPoint = join(repoRoot, 'src', 'index.ts');
const BOOT_MS = 50_000;

let home: string;
let child: ChildProcess | undefined;
const held: NetServer[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'iris-dash-explicit-'));
});

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child!.once('exit', r));
  }
  child = undefined;
  for (const server of held.splice(0)) {
    await new Promise<void>((r) => server.close(() => r()));
  }
  rmSync(home, { recursive: true, force: true });
});

function spawnCli(args: string[], extraEnv: Record<string, string> = {}): ChildProcess {
  // stdin is piped, not ignored: with the default stdio transport an
  // immediately-EOF stdin closes the MCP session and the server exits
  // before any assertion runs.
  const proc = spawn(process.execPath, ['--import', 'tsx', entryPoint, ...args], {
    cwd: repoRoot,
    env: { ...process.env, IRIS_HOME: home, IRIS_NO_AUTO_LAUNCH: '1', ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child = proc;
  return proc;
}

/** Resolves with everything written to stderr up to and including `pattern`. */
function waitForLog(proc: ChildProcess, pattern: RegExp): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stderr = '';
    const timer = setTimeout(
      () => rejectPromise(new Error(`never logged ${pattern}. stderr so far:\n${stderr}`)),
      BOOT_MS,
    );
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (pattern.test(stderr)) {
        clearTimeout(timer);
        resolvePromise(stderr);
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`CLI exited early with code ${code}. stderr:\n${stderr}`));
    });
  });
}

/*
 * The CLI refuses port 0, so reserve a real one and hand it straight to
 * the spawned server. Small TOCTOU window, same trade as demo-mode.test.ts.
 */
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/** Bind a port for real, so a collision is genuine. */
async function occupyPort(): Promise<number> {
  const server = createServer();
  held.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (typeof addr !== 'object' || !addr) throw new Error('holder reported no bound address');
  return addr.port;
}

/*
 * A TCP connect, not an HTTP request: "no server here" has to be
 * distinguishable from "a server that answered 404", and only the
 * transport-level refusal proves nothing is bound.
 */
function isListening(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const done = (answer: boolean) => {
      socket.destroy();
      resolvePromise(answer);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(5_000, () => done(false));
  });
}

describe('--transport http without a dashboard flag', () => {
  it('starts no dashboard, and says how to get one', async () => {
    const transportPort = await freePort();
    const dashboardPort = await freePort();
    const proc = spawnCli([
      '--transport', 'http',
      '--port', String(transportPort),
      '--dashboard-port', String(dashboardPort),
    ]);

    const stderr = await waitForLog(proc, /Dashboard not started/);

    // The pointer names the port and both routes back to the endpoint the
    // user just lost — this line IS the migration path for anyone who was
    // relying on ingest riding along with the transport.
    expect(stderr).toContain(String(dashboardPort));
    expect(stderr).toContain('POST /api/v1/traces');
    expect(stderr).toMatch(/--dashboard\b/);
    expect(stderr).toContain('IRIS_DASHBOARD=true');

    // The transport itself is up...
    const health = await fetch(`http://127.0.0.1:${transportPort}/health`);
    expect(health.status).toBe(200);

    // ...and nothing at all is bound on the dashboard port.
    expect(await isListening(dashboardPort)).toBe(false);
  }, 90_000);

  it('survives a busy dashboard port — an unrequested server cannot kill the requested one', async () => {
    const transportPort = await freePort();
    // Exactly the UAT failure: something else already owns 6920's stand-in.
    const dashboardPort = await occupyPort();
    const proc = spawnCli([
      '--transport', 'http',
      '--port', String(transportPort),
      '--dashboard-port', String(dashboardPort),
    ]);

    await waitForLog(proc, /Dashboard not started/);

    const health = await fetch(`http://127.0.0.1:${transportPort}/health`);
    expect(health.status).toBe(200);
    // Previously: the implicit dashboard hit EADDRINUSE and exited(1),
    // taking a transport that had already bound successfully with it.
    expect(proc.exitCode).toBe(null);
  }, 90_000);
});

describe('the three documented ways to ask for the dashboard', () => {
  it('--dashboard starts it alongside the http transport', async () => {
    const transportPort = await freePort();
    const dashboardPort = await freePort();
    const proc = spawnCli([
      '--transport', 'http',
      '--port', String(transportPort),
      '--dashboard',
      '--dashboard-port', String(dashboardPort),
    ]);

    const stderr = await waitForLog(proc, /Dashboard available at/);
    expect(stderr).not.toContain('Dashboard not started');

    const health = await fetch(`http://127.0.0.1:${dashboardPort}/api/v1/health`);
    expect(health.status).toBe(200);
  }, 90_000);

  it('IRIS_DASHBOARD=true starts it', async () => {
    const dashboardPort = await freePort();
    const proc = spawnCli([], {
      IRIS_DASHBOARD: 'true',
      IRIS_DASHBOARD_PORT: String(dashboardPort),
    });

    await waitForLog(proc, /Dashboard available at/);
    const health = await fetch(`http://127.0.0.1:${dashboardPort}/api/v1/health`);
    expect(health.status).toBe(200);
  }, 90_000);

  it('dashboard.enabled in config.json starts it', async () => {
    const dashboardPort = await freePort();
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ dashboard: { enabled: true, port: dashboardPort } }),
      'utf-8',
    );
    const proc = spawnCli([]);

    await waitForLog(proc, /Dashboard available at/);
    const health = await fetch(`http://127.0.0.1:${dashboardPort}/api/v1/health`);
    expect(health.status).toBe(200);
  }, 90_000);
});
