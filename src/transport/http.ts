import express from 'express';
import type { Server } from 'node:http';
import helmet from 'helmet';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IrisConfig } from '../types/config.js';
import type { Logger } from '../utils/logger.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { createErrorHandler } from '../middleware/error-handler.js';
import { createMcpRateLimiter } from '../middleware/rate-limit.js';

export interface HttpTransportResult {
  transport: StreamableHTTPServerTransport;
  httpServer: Server;
}

export async function createHttpTransport(
  mcpServer: McpServer,
  config: IrisConfig,
  logger: Logger,
): Promise<HttpTransportResult> {
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

  // Body parser with size limit
  app.use(express.json({ limit: config.security.requestSizeLimit }));

  // Health endpoint (no auth, no rate limit)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'iris-eval', timestamp: new Date().toISOString() });
  });

  // Authentication
  app.use(createAuthMiddleware(config));

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

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableDnsRebindingProtection: true,
    allowedOrigins,
    ...(allowedHosts ? { allowedHosts } : {}),
  });

  // Rate limiter for MCP POST/DELETE (not GET — SSE streaming)
  const mcpLimiter = createMcpRateLimiter(config);

  app.post('/mcp', mcpLimiter, async (req, res) => {
    await transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', async (req, res) => {
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', mcpLimiter, async (req, res) => {
    await transport.handleRequest(req, res);
  });

  // Error handler (must be last)
  app.use(createErrorHandler(logger));

  return { transport, httpServer };
}
