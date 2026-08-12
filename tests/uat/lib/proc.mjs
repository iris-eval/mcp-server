/*
 * Process helpers: one-shot CLI runs and long-lived dashboard servers.
 *
 * Readiness is POLLED, never slept-on. A dashboard server is considered
 * up only when GET /api/v1/health answers 200 on the port it actually
 * bound — discovered from ${IRIS_HOME}/runtime.json (the port-discovery
 * handshake the server writes in its listen callback) with the startup
 * banner on stderr as a fallback. An early child exit aborts the wait
 * immediately with the captured stderr, so a crashed server surfaces as
 * a crash and not as a 30s timeout.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { IRIS_ENTRY, IRIS_REPO, baseChildEnv } from './env.mjs';
import { raw } from './http.mjs';

const NODE = process.execPath;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reserve an out-of-band port: bind :0, read what the OS handed out,
 * release it, hand the number to the child.
 *
 * `--dashboard-port 0` is NOT usable here — the CLI's PortSchema
 * enforces the documented 1-65535 range, so the server refuses to start
 * (exit 2) even though the internals support an ephemeral bind. Hence
 * OOB reservation plus an EADDRINUSE retry in startServer, which closes
 * the small window between release and re-bind.
 */
export function reservePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Run `node dist/index.js <args>` to completion.
 * Resolves with {code, signal, stdout, stderr, timedOut} — never rejects
 * on a non-zero exit, because exit codes are what we assert on.
 */
export function runCli(args, { irisHome, extraEnv = {}, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [IRIS_ENTRY, ...args], {
      cwd: IRIS_REPO,
      env: baseChildEnv(irisHome, extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  const done = new Promise((resolve) => child.once('close', resolve));
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  const settled = await Promise.race([done.then(() => true), sleep(4000).then(() => false)]);
  if (settled) return;
  // Windows: SIGTERM is best-effort. Force the whole tree down so no
  // stray listener survives into the next suite and steals a port.
  if (process.platform === 'win32' && pid) {
    await new Promise((resolve) => {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.once('close', resolve);
      k.once('error', resolve);
    });
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await Promise.race([done, sleep(4000)]);
}

/**
 * Start a long-lived iris process that serves the dashboard on a
 * reserved OOB port, and wait until it actually answers.
 *
 * `argsFor(port)` builds the argv; the port is reserved fresh on each
 * attempt so a lost race just retries instead of failing the suite.
 *
 * @returns {Promise<{child, port:number, stop:()=>Promise<void>, stderr:()=>string, stdout:()=>string}>}
 */
export async function startServer({ argsFor, args, irisHome, extraEnv = {}, timeoutMs = 60_000, label = 'server', attempts = 3 }) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const port = argsFor ? await reservePort() : undefined;
    try {
      return await startOnce({
        args: argsFor ? argsFor(port) : args,
        expectPort: port,
        irisHome,
        extraEnv,
        timeoutMs,
        label,
      });
    } catch (err) {
      lastErr = err;
      if (!/EADDRINUSE|already in use/i.test(err.message)) throw err;
      await sleep(250);
    }
  }
  throw lastErr;
}

async function startOnce({ args, expectPort, irisHome, extraEnv, timeoutMs, label }) {
  const runtimeJson = join(irisHome, 'runtime.json');
  // A stale handshake file from a previous boot would hand us a dead
  // port; the scratch home is fresh per suite, but be explicit.
  try {
    rmSync(runtimeJson, { force: true });
  } catch {
    /* nothing to remove */
  }

  const child = spawn(NODE, [IRIS_ENTRY, ...args], {
    cwd: IRIS_REPO,
    env: baseChildEnv(irisHome, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  let exited = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    stdout += d;
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  child.once('close', (code, signal) => {
    exited = { code, signal };
  });

  const deadline = Date.now() + timeoutMs;
  let port = expectPort;

  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `${label} exited before becoming ready (code=${exited.code} signal=${exited.signal}). stderr: ${stderr.slice(-800)}`,
      );
    }
    if (port === undefined && existsSync(runtimeJson)) {
      try {
        const parsed = JSON.parse(readFileSync(runtimeJson, 'utf8'));
        if (Number.isInteger(parsed.dashboardPort) && parsed.dashboardPort > 0) port = parsed.dashboardPort;
      } catch {
        /* half-written file; retry */
      }
    }
    if (port === undefined) {
      const m = (stderr + stdout).match(/http:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/);
      if (m) port = Number(m[1]);
    }
    if (port !== undefined) {
      try {
        const res = await raw({ port, path: '/api/v1/health', timeoutMs: 4000 });
        if (res.status === 200) {
          return {
            child,
            port,
            stderr: () => stderr,
            stdout: () => stdout,
            stop: () => killTree(child),
          };
        }
      } catch {
        /* not listening yet */
      }
    }
    await sleep(120);
  }

  await killTree(child);
  throw new Error(
    `${label} never became ready within ${timeoutMs}ms (port=${port ?? 'undiscovered'}). stderr: ${stderr.slice(-800)}`,
  );
}
