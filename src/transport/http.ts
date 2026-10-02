import express from 'express';
import type { Server } from 'node:http';
import helmet from 'helmet';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { IrisConfig } from '../types/config.js';
import type { Logger } from '../utils/logger.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { createErrorHandler } from '../middleware/error-handler.js';
import { createMcpRateLimiter } from '../middleware/rate-limit.js';
import { createRebindingGuard } from '../middleware/rebinding-guard.js';
import { assertAuthenticatedBind } from '../utils/bind-policy.js';
import { buildKeyRing, hasAnyApiKey, type KeyRing } from '../security/keys.js';
import { buildHealth, type HealthDeps } from '../health.js';
import { requestSizeLimitBytes } from '../utils/size-limit.js';

export interface HttpTransportResult {
  httpServer: Server;
  /** How many MCP sessions are open now. */
  sessionCount: () => number;
  /** End every session (their event streams close), for shutdown. */
  closeSessions: () => Promise<void>;
}

/**
 * One MCP server for one session. A function is called once per session, so
 * any number of clients connect; a single instance can speak to one client
 * at a time, and is handed to the next once the first is gone.
 */
export type McpServerSource = McpServer | (() => McpServer | Promise<McpServer>);

/*
 * Sessions.
 *
 * One `StreamableHTTPServerTransport` is one session, and an MCP server
 * speaks through one transport. This endpoint used to create a single
 * transport for the life of the process: the first client to `initialize`
 * owned it, a second got `400 Server already initialized`, and once the
 * first ended its session every later client got `404 Session not found`
 * until the server was restarted. Each `initialize` now gets a transport
 * and an MCP server of its own, over the same engine and store.
 *
 * Clients often leave without `DELETE /mcp`, so sessions are bounded
 * rather than trusted to end: at MAX_SESSIONS a new client takes the place
 * of the session used least recently, provided that session has no event
 * stream open (a connected client keeps one) and has been quiet for
 * SESSION_IDLE_MS; when every session is in use the new client is told so
 * (503, Retry-After) and nothing is dropped. A client
 * whose session was given away gets `404 Session not found`, which the
 * protocol answers by initializing again.
 */
const MAX_SESSIONS = 256;
const SESSION_IDLE_MS = 60_000;

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
  /** Event streams this session holds open (GET /mcp). */
  streams: number;
}

const jsonRpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

/** What `/health` on this port reports on; the version comes from `config.server`. */
export type HttpTransportHealthDeps = Omit<HealthDeps, 'version'>;

export async function createHttpTransport(
  mcpServer: McpServerSource,
  config: IrisConfig,
  logger: Logger,
  health: HttpTransportHealthDeps = {},
  /** The server's live key ring (security/live-key-ring.ts), shared with the dashboard; built from the config when absent. */
  keyRing?: KeyRing,
  /** The session bounds, for a test that needs to reach them with a handful of clients. */
  limits: { maxSessions?: number; sessionIdleMs?: number } = {},
): Promise<HttpTransportResult> {
  /*
   * Refuse, don't warn: a bind beyond loopback with no API key is
   * refused here — before the app is built, before any port is taken —
   * unless the operator set security.allowUnauthenticated on purpose. The
   * CLI pre-flight (validateBindPolicy) says the same sentence earlier;
   * this is the defence for embedders that call this function directly.
   */
  assertAuthenticatedBind({
    surface: 'HTTP transport',
    host: config.transport.host,
    hasApiKey: hasAnyApiKey(config.security),
    allowUnauthenticated: config.security.allowUnauthenticated,
  });
  // Every configured key: the server's live ring, or one read once for an embedder.
  const keys = keyRing ?? buildKeyRing(config.security);

  const app = express();

  // Security headers — API-only server, restrictive CSP
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  }));

  /*
   * DNS-rebinding guard BEFORE the body parser. The SDK transport
   * validates Origin and Host too (below), but it runs inside the /mcp
   * handler — after express.json() has read and parsed up to the request
   * size limit from a page the server is about to refuse. The rejection is
   * the cheapest response and it must come first; the same middleware the
   * dashboard uses, built from the port actually bound (see the resolver
   * note in rebinding-guard.ts — the configured port is 0 for tests and
   * embedders).
   */
  let boundPort: number | undefined;
  app.use(
    createRebindingGuard({
      port: () => boundPort ?? config.transport.port,
      host: config.transport.host,
      allowedOrigins: config.security.allowedOrigins,
    }),
  );

  // Body parser with size limit — the same byte count stdio enforces (src/utils/size-limit.ts).
  app.use(express.json({ limit: requestSizeLimitBytes(config.security.requestSizeLimit) }));

  /*
   * Health endpoint (no auth, no rate limit) — the same contract the
   * dashboard serves at /api/v1/health, built by src/health.ts.
   * Until 0.15.0 this port answered `{ status, server, timestamp }`
   * while the API reference called the two "the same contract".
   */
  app.get('/health', async (_req, res) => {
    const { status, body } = await buildHealth({ ...health, version: config.server.version });
    res.status(status).json(body);
  });

  // Authentication
  app.use(createAuthMiddleware(config, keys));

  /*
   * DNS-rebinding protection (MCP spec: servers MUST validate Origin on
   * HTTP transports; when local, SHOULD bind loopback).
   *
   * iris bound loopback but validated nothing, and `security.apiKey` is
   * undefined by default — so `createAuthMiddleware` is a pass-through. A
   * default `--transport http` server was therefore reachable from any web
   * page the operator visited: the page resolves an attacker-controlled
   * hostname to 127.0.0.1, the browser treats it as same-origin, and the
   * request carries no credentials to be missing. That exposes traces and
   * eval history and allows rule deployment.
   *
   * Origin validation is the fix, and it is safe to switch on by default
   * because the SDK only rejects when an Origin header is PRESENT (see
   * validateRequestHeaders). Real MCP clients — Claude Desktop, Cursor, the
   * CLI — send none, so they are unaffected; browsers always do.
   *
   * Host validation is applied only when bound to loopback. Binding
   * elsewhere is a deliberate network deployment that usually sits behind a
   * proxy rewriting Host, and an exact-match list would break it — the case
   * where the operator has already taken ownership of the boundary.
   */
  const isLoopbackBind =
    config.transport.host === '127.0.0.1' ||
    config.transport.host === 'localhost' ||
    config.transport.host === '::1';

  /*
   * Bind FIRST, then build the allowlists from the port actually bound.
   * `config.transport.port` is 0 when the caller wants an ephemeral port
   * (tests and embedders do this), and the OS then picks something else —
   * so allowlists derived from the configured value would contain
   * `127.0.0.1:0` and reject every real request with a 403 that looks
   * exactly like an attack. Routes are registered immediately after, and
   * the port is not discoverable by any client until this function returns.
   *
   * The callback MUST inspect its error argument. Express 5 wires the
   * listen callback as `server.once('error', done)` as well as the
   * listening callback — so on EADDRINUSE it is invoked WITH the error.
   * Ignoring that argument resolved this promise on a server that never
   * bound: the caller then logged "HTTP transport listening on <port>"
   * while another process owned the port, and the process idled forever.
   * A CI health poll got 200 from the OTHER instance and shipped
   * evaluations to a stranger's database. A bind failure must reject,
   * name the port, and take the process down nonzero.
   */
  const httpServer = await new Promise<Server>((resolve, reject) => {
    const server = app.listen(config.transport.port, config.transport.host, (err?: Error) => {
      if (err) {
        const bind = `${config.transport.host}:${config.transport.port}`;
        const code = (err as NodeJS.ErrnoException).code;
        reject(
          code === 'EADDRINUSE'
            ? new Error(
                `HTTP transport failed to start: port ${config.transport.port} is already in use ` +
                  `(EADDRINUSE on ${bind}). Another process — possibly another iris instance — owns it. ` +
                  `Pass --port <other> (or set IRIS_PORT) or stop the other process.`,
              )
            : new Error(`HTTP transport failed to bind ${bind}: ${err.message}`),
        );
        return;
      }
      resolve(server);
    });
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : config.transport.port;
  boundPort = port;

  const loopbackOrigins = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ];
  /*
   * The SDK matches origins EXACTLY (`allowedOrigins.includes(origin)`),
   * while iris's own CORS allowlist accepts glob patterns like the shipped
   * default `http://localhost:*`. A pattern entry can never match here, so
   * it is dropped rather than passed through to sit in the list looking
   * effective. The concrete loopback origins added above already express
   * what `http://localhost:*` means for this server's port.
   *
   * Note this rejection is what actually stops the attack. Emitting CORS
   * headers would not: the browser only withholds the RESPONSE, after the
   * server has already executed the request — so a rebound page could still
   * deploy rules or delete traces and simply not read the reply.
   */
  const configuredOrigins = (config.security.allowedOrigins ?? []).filter(
    (origin) => !origin.includes('*'),
  );
  const allowedOrigins = [...new Set([...loopbackOrigins, ...configuredOrigins])];
  const allowedHosts = isLoopbackBind
    ? [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
    : undefined;

  const sessions = new Map<string, Session>();
  const single = typeof mcpServer === 'function' ? null : mcpServer;
  const maxSessions = single ? 1 : (limits.maxSessions ?? MAX_SESSIONS);
  const idleMs = limits.sessionIdleMs ?? SESSION_IDLE_MS;
  const serverFor = async (): Promise<McpServer> => (typeof mcpServer === 'function' ? mcpServer() : mcpServer);

  const end = async (id: string): Promise<void> => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    // Closing the server closes its transport, which ends the session's streams.
    await session.server.close().catch(() => undefined);
  };

  /** Room for one more session: true when there is, after giving away the least recently used idle one if it had to. */
  const makeRoom = async (): Promise<boolean> => {
    if (sessions.size < maxSessions) return true;
    const now = Date.now();
    let idle: [string, Session] | undefined;
    for (const entry of sessions) {
      const [, s] = entry;
      if (s.streams > 0 || now - s.lastSeen < idleMs) continue;
      if (!idle || s.lastSeen < idle[1].lastSeen) idle = entry;
    }
    if (!idle) return false;
    await end(idle[0]);
    return true;
  };

  /** The session a request names, or the answer that says why there is none. Null when it answered. */
  const sessionOf = (req: express.Request, res: express.Response): Session | null => {
    const id = req.headers['mcp-session-id'];
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (session) {
      session.lastSeen = Date.now();
      return session;
    }
    if (typeof id === 'string') res.status(404).json(jsonRpcError(-32001, 'Session not found. It ended or the server restarted: send initialize again, without the session id.'));
    else res.status(400).json(jsonRpcError(-32000, 'Bad Request: no Mcp-Session-Id header. Send initialize first and repeat the id it returns.'));
    return null;
  };

  // Rate limiter for MCP POST/DELETE (not GET — SSE streaming)
  const mcpLimiter = createMcpRateLimiter(config);

  app.post('/mcp', mcpLimiter, async (req, res) => {
    if (req.headers['mcp-session-id'] === undefined && isInitializeRequest(req.body)) {
      if (!(await makeRoom())) {
        res
          .status(503)
          .set('Retry-After', String(Math.max(1, Math.ceil(idleMs / 1000))))
          .json(
            jsonRpcError(
              -32000,
              single
                ? 'This server speaks to one MCP client at a time and that client is connected. Try again when it has ended its session (DELETE /mcp) or gone quiet.'
                : `This server has ${maxSessions} MCP sessions open and every one is in use. Try again shortly, or end a session (DELETE /mcp).`,
            ),
          );
        return;
      }
      const server = await serverFor();
      const session: Session = {
        server,
        lastSeen: Date.now(),
        streams: 0,
        transport: new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableDnsRebindingProtection: true,
          allowedOrigins,
          ...(allowedHosts ? { allowedHosts } : {}),
          onsessioninitialized: (id) => {
            sessions.set(id, session);
          },
          // The client ended it (DELETE /mcp).
          onsessionclosed: (id) => end(id),
        }),
      };
      await server.connect(session.transport);
      await session.transport.handleRequest(req, res, req.body);
      // An initialize the transport refused (a rejected Origin, a malformed body) opened no session: let the pair go.
      if (session.transport.sessionId === undefined || !sessions.has(session.transport.sessionId)) await server.close().catch(() => undefined);
      return;
    }
    const session = sessionOf(req, res);
    if (session) await session.transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    session.streams += 1;
    res.on('close', () => {
      session.streams -= 1;
      session.lastSeen = Date.now();
    });
    await session.transport.handleRequest(req, res);
  });

  app.delete('/mcp', mcpLimiter, async (req, res) => {
    const session = sessionOf(req, res);
    if (session) await session.transport.handleRequest(req, res);
  });

  // Error handler (must be last)
  app.use(createErrorHandler(logger));

  return {
    httpServer,
    sessionCount: () => sessions.size,
    closeSessions: async () => {
      await Promise.all([...sessions.keys()].map((id) => end(id)));
    },
  };
}
