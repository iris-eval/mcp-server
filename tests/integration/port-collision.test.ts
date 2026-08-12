/*
 * A failed bind must look like a failure.
 *
 * Express 5 registers the `app.listen(port, host, cb)` callback as
 * `server.once('error', cb)` as well as the listening listener (see
 * express/lib/application.js), so on EADDRINUSE it runs WITH an error
 * argument. Both of iris's call sites ignored that argument, and each
 * therefore ran its success path over a server that never bound:
 *
 *   - the MCP transport RESOLVED its promise, so index.ts logged
 *     "HTTP transport listening on <port>" for a port owned by another
 *     process and then idled forever — no error, no exit, no clue;
 *   - the dashboard logged "Dashboard available at http://localhost:<port>"
 *     and overwrote ${IRIS_HOME}/runtime.json with that port, pointing
 *     capture clients (POST /api/v1/traces) at the stranger holding it.
 *
 * Every test binds a real throwaway socket first — the collision is
 * genuine, not simulated, because the bug lives in what the OS and
 * Express do with each other, not in our own branching.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server as NetServer } from 'node:net';
import type { Server } from 'node:http';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHttpTransport } from '../../src/transport/http.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { irisHome } from '../../src/utils/iris-home.js';

/*
 * Comfortably longer than a loopback bind, far shorter than vitest's
 * default timeout — see settleWithin for why this is not just left to
 * the runner.
 */
const SETTLE_MS = 5_000;

const held: NetServer[] = [];
const opened: Server[] = [];
let storage: SqliteAdapter | undefined;

/** Bind a real socket and return the port nobody else can have. */
async function occupyPort(): Promise<number> {
  const server = createServer();
  held.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (typeof addr !== 'object' || !addr) throw new Error('holder reported no bound address');
  return addr.port;
}

type Outcome<T> =
  | { kind: 'resolved'; value: T }
  | { kind: 'rejected'; error: Error }
  | { kind: 'hung' };

/*
 * The regression is a HANG, so "never settles" has to be an assertable
 * outcome rather than a runner timeout. A bare `rejects.toThrow()` on the
 * unpatched code fails with vitest's generic "test timed out", which reads
 * identically to a slow CI box and tells the next person nothing.
 */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<Outcome<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value): Outcome<T> => ({ kind: 'resolved', value }),
        (error: Error): Outcome<T> => ({ kind: 'rejected', error }),
      ),
      new Promise<Outcome<T>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'hung' }), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function collectingLogger() {
  const info: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  return {
    info,
    warn,
    error,
    logger: {
      debug: () => {},
      info: (msg: string) => void info.push(msg),
      warn: (msg: string) => void warn.push(msg),
      error: (msg: string) => void error.push(msg),
    },
  };
}

afterEach(async () => {
  for (const server of opened.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const server of held.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (storage) {
    await storage.close();
    storage = undefined;
  }
  vi.restoreAllMocks();
});

describe('MCP HTTP transport — occupied port', () => {
  it('rejects with a message naming the port, instead of hanging', async () => {
    const port = await occupyPort();
    const config = {
      ...defaultConfig,
      transport: { type: 'http' as const, host: '127.0.0.1', port },
    };

    const outcome = await settleWithin(
      createHttpTransport(new McpServer({ name: 'iris-eval-test', version: '0.0.0' }), config, collectingLogger().logger),
      SETTLE_MS,
    );
    // Close before asserting: on the unpatched code this resolves with a
    // real (unbound) server, and a failed assertion would leak it.
    if (outcome.kind === 'resolved') opened.push(outcome.value.httpServer);

    if (outcome.kind !== 'rejected') {
      throw new Error(
        outcome.kind === 'hung'
          ? `createHttpTransport never settled within ${SETTLE_MS}ms — this is the hang regression`
          : 'createHttpTransport resolved as if the bind had succeeded',
      );
    }
    expect(outcome.error.message).toContain('EADDRINUSE');
    expect(outcome.error.message).toContain(String(port));
    // The caller cannot act on "bind failed" alone — the message has to
    // carry the way out.
    expect(outcome.error.message).toMatch(/--port|IRIS_PORT/);
  });

  it('still resolves on a free port — the guard rejects collisions, not everything', async () => {
    const config = {
      ...defaultConfig,
      transport: { type: 'http' as const, host: '127.0.0.1', port: 0 },
    };

    const { httpServer } = await createHttpTransport(
      new McpServer({ name: 'iris-eval-test', version: '0.0.0' }),
      config,
      collectingLogger().logger,
    );
    opened.push(httpServer);

    const addr = httpServer.address();
    expect(typeof addr === 'object' && addr ? addr.port : 0).toBeGreaterThan(0);
  });
});

describe('Dashboard server — occupied port', () => {
  async function startAgainst(port: number) {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const log = collectingLogger();
    const config = {
      ...defaultConfig,
      dashboard: { enabled: true, port, host: '127.0.0.1' },
    };
    const server = createDashboardServer(storage, config, log.logger).start();
    return { server, log };
  }

  it('never runs the success path: no "Dashboard available", no runtime.json', async () => {
    const runtimeJson = join(irisHome(), 'runtime.json');
    rmSync(runtimeJson, { force: true });

    /*
     * The error handler exits(1) — correct in production now that the
     * dashboard only starts when explicitly requested, but it would take
     * the vitest worker with it. Stubbed so the assertions below can run,
     * and asserted on directly: the exit IS part of the contract.
     */
    const exits: (number | undefined)[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code);
    }) as never);

    const port = await occupyPort();
    const { server, log } = await startAgainst(port);

    // Listeners fire in registration order — Express's callback, then the
    // src error handler, then this one — so both have run by the time the
    // event arrives here.
    await once(server, 'error');

    expect(log.info.some((m) => m.includes('Dashboard available'))).toBe(false);
    expect(existsSync(runtimeJson)).toBe(false);

    expect(log.error.some((m) => m.includes('EADDRINUSE') && m.includes(String(port)))).toBe(true);
    expect(log.error.some((m) => /--dashboard-port|IRIS_DASHBOARD_PORT/.test(m))).toBe(true);
    expect(exits).toEqual([1]);
  });

  it('still runs the success path on a free port', async () => {
    const runtimeJson = join(irisHome(), 'runtime.json');
    rmSync(runtimeJson, { force: true });

    const { server, log } = await startAgainst(0);
    opened.push(server);
    await once(server, 'listening');

    expect(log.info.some((m) => m.includes('Dashboard available'))).toBe(true);
    expect(existsSync(runtimeJson)).toBe(true);
  });
});
