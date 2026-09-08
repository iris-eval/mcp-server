/*
 * A non-loopback bind without an API key is refused at boot (A6-7) — through
 * the REAL CLI entry point, the way `docker run` reaches it (the image sets
 * IRIS_HOST=0.0.0.0 and IRIS_DASHBOARD_HOST=0.0.0.0).
 *
 * What each test checks, precisely:
 *   - http transport on 0.0.0.0, no key → the process exits non-zero before
 *     any bind, and the sentence names IRIS_API_KEY and
 *     IRIS_ALLOW_UNAUTHENTICATED;
 *   - the dashboard alone on 0.0.0.0 under stdio, no key → same;
 *   - IRIS_ALLOW_UNAUTHENTICATED=1 → the refusal is lifted and the process
 *     boots (proven by its own "listening" line, then killed).
 *
 * A boot where a refusal was expected is caught by the race below: the
 * process is killed once it announces a bind, and that is the failure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

const repoRoot = resolve(import.meta.dirname, '../..');
const entryPoint = join(repoRoot, 'src', 'index.ts');

let home: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'iris-unauth-bind-'));
});

afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      c.kill('SIGKILL');
      await once(c, 'exit');
    }
  }
  // Windows keeps the SQLite file busy for a moment after the process dies.
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

interface Outcome {
  exited: boolean;
  code: number | null;
  output: string;
}

/**
 * Runs the CLI and resolves on exit, or — if the process announces a bound
 * port — kills it and resolves with `exited: false`. `listeningPattern` is
 * the line the server logs once it is serving; seeing it means the policy
 * did NOT refuse.
 */
function runCli(args: string[], env: Record<string, string>, listeningPattern: RegExp): Promise<Outcome> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entryPoint, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        IRIS_HOME: home,
        IRIS_NO_AUTO_LAUNCH: '1',
        IRIS_LOG_LEVEL: 'info',
        // Scrubbed so the ambient shell cannot decide this test's outcome.
        IRIS_API_KEY: '',
        IRIS_ALLOW_UNAUTHENTICATED: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.push(child);
    let output = '';
    let settled = false;
    const onData = (c: Buffer) => {
      output += c.toString();
      if (!settled && listeningPattern.test(output)) {
        settled = true;
        child.kill('SIGKILL');
        resolvePromise({ exited: false, code: null, output });
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      resolvePromise({ exited: true, code, output });
    });
  });
}

const LISTENING = /listening on|Dashboard available at/;

/** A high port for the one case that actually binds; the refusal cases never reach a bind. */
function freePort(): number {
  return 20_000 + Math.floor(Math.random() * 20_000);
}

describe('binding beyond loopback without an API key', () => {
  it('http transport on 0.0.0.0 with no key exits non-zero naming IRIS_API_KEY and IRIS_ALLOW_UNAUTHENTICATED, before any bind', async () => {
    const out = await runCli([], { IRIS_TRANSPORT: 'http', IRIS_HOST: '0.0.0.0', IRIS_PORT: String(freePort()), IRIS_DASHBOARD: 'false' }, LISTENING);
    expect(out.exited, `expected a refusal, got a running server:\n${out.output}`).toBe(true);
    expect(out.code).not.toBe(0);
    expect(out.output).toContain('IRIS_API_KEY');
    expect(out.output).toContain('IRIS_ALLOW_UNAUTHENTICATED');
    expect(out.output).toContain('0.0.0.0');
    expect(out.output).not.toMatch(LISTENING);
  }, 45_000);

  it('the dashboard alone on 0.0.0.0 under stdio with no key is refused the same way', async () => {
    const out = await runCli(
      ['--dashboard'],
      { IRIS_TRANSPORT: 'stdio', IRIS_DASHBOARD_HOST: '0.0.0.0', IRIS_DASHBOARD_PORT: String(freePort()) },
      LISTENING,
    );
    expect(out.exited, `expected a refusal, got a running server:\n${out.output}`).toBe(true);
    expect(out.code).not.toBe(0);
    expect(out.output).toContain('IRIS_API_KEY');
    expect(out.output).toContain('dashboard');
  }, 45_000);

  it('IRIS_ALLOW_UNAUTHENTICATED=1 lifts the refusal on purpose and the server boots', async () => {
    const out = await runCli(
      [],
      { IRIS_TRANSPORT: 'http', IRIS_HOST: '0.0.0.0', IRIS_PORT: String(freePort()), IRIS_DASHBOARD: 'false', IRIS_ALLOW_UNAUTHENTICATED: '1' },
      LISTENING,
    );
    expect(out.exited, `expected a running server, got an exit ${out.code}:\n${out.output}`).toBe(false);
    expect(out.output).toMatch(LISTENING);
  }, 45_000);
});
