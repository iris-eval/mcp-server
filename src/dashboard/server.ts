import express from 'express';
import type { Server } from 'node:http';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { irisHome } from '../utils/iris-home.js';
import type { IStorageAdapter } from '../types/query.js';
import type { IrisConfig } from '../types/config.js';
import { buildCapabilities } from '../capabilities.js';
import { registerCapabilitiesRoutes } from './routes/capabilities.js';
import type { Logger } from '../utils/logger.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { createCorsMiddleware } from '../middleware/cors.js';
import { createErrorHandler } from '../middleware/error-handler.js';
import { createApiRateLimiter, createAuthGateRateLimiter } from '../middleware/rate-limit.js';
import { createTenantMiddleware } from '../middleware/tenant.js';
import { createRebindingGuard, isLoopbackHost } from '../middleware/rebinding-guard.js';
import { registerTraceRoutes } from './routes/traces.js';
import { registerSummaryRoutes } from './routes/summary.js';
import { registerEvaluationRoutes } from './routes/evaluations.js';
import { registerFilterRoutes } from './routes/filters.js';
import { registerEvalStatsRoutes } from './routes/eval-stats.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMomentRoutes } from './routes/moments.js';
import { registerFailureRoutes } from './routes/failures.js';
import { registerRuleRoutes } from './routes/rules.js';
import { registerPreferencesRoutes } from './routes/preferences.js';
import { registerAuditRoutes } from './routes/audit.js';
import { createSessionAuth } from './session-auth.js';
import type { CustomRuleStore } from '../custom-rule-store.js';
import type { EvalEngine } from '../eval/engine.js';
import type { PreferenceStore } from '../preferences.js';

export interface DashboardServer {
  app: express.Application;
  start(): Server;
}

export interface DashboardServerOptions {
  customRuleStore?: CustomRuleStore;
  evalEngine?: EvalEngine;
  preferenceStore?: PreferenceStore;
  /**  when serving the disposable demo database; reported on /api/v1/capabilities. */
  mode?: 'real' | 'demo';
}

export function createDashboardServer(
  storage: IStorageAdapter,
  config: IrisConfig,
  logger: Logger,
  options?: DashboardServerOptions,
): DashboardServer {
  const app = express();

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // 'self' covers our bundled CSS. The brand fonts (Space Grotesk +
        // Manrope + JetBrains Mono) are self-hosted from /fonts as of
        // #334, so no Google Fonts origins are needed. 'unsafe-inline'
        // stays: the React components set style={} inline throughout.
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Self-hosted woff2 under /fonts resolves via 'self'.
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
      },
    },
  }));

  // Body parser with size limit
  app.use(express.json({ limit: config.security.requestSizeLimit }));

  /*
   * DNS-rebinding guard BEFORE anything that reads or writes state. CORS
   * runs after it and only decorates responses the guard already allowed —
   * on its own CORS cannot stop a rebound page, because the write executes
   * before the browser withholds the reply.
   */
  let boundPort: number | undefined;
  app.use(
    createRebindingGuard({
      port: () => boundPort ?? config.dashboard.port,
      host: config.dashboard.host,
      allowedOrigins: config.security.allowedOrigins,
    }),
  );

  // CORS
  app.use(createCorsMiddleware(config.security.allowedOrigins));

  /*
   * Authentication. The Bearer middleware is the contract for MCP clients
   * and capture SDKs; the session layer in front of it is what lets a
   * BROWSER present the same key once (`?key=` or the sign-in form) and
   * then ride an HttpOnly cookie — without it, `--api-key` made the
   * dashboard UI 401 on every page load (#373 item 6). With no key
   * configured both are pass-throughs. The limiter ahead of it is the
   * ceiling every authorization decision sits behind.
   */
  app.use(createAuthGateRateLimiter(config));
  app.use(createSessionAuth({ apiKey: config.security.apiKey, bearerAuth: createAuthMiddleware(config) }));

  // Tenant resolution — attaches req.tenantId to every request.
  // OSS: always resolves to LOCAL_TENANT. Cloud: swaps for an auth-aware
  // resolver that reads the authenticated session. See middleware/tenant.ts.
  app.use(createTenantMiddleware());

  // API routes with rate limiting
  const router = express.Router();
  router.use(createApiRateLimiter(config));
  registerTraceRoutes(router, storage, { evalEngine: options?.evalEngine });
  registerSummaryRoutes(router, storage);
  registerEvaluationRoutes(router, storage);
  registerEvalStatsRoutes(router, storage);
  registerFilterRoutes(router, storage);
  registerHealthRoutes(router, storage, config.server.version);
  // The same object iris://capabilities serves, for the HTTP path.
  registerCapabilitiesRoutes(router, () =>
    buildCapabilities({ config, evalEngine: options?.evalEngine, customRuleStore: options?.customRuleStore, mode: options?.mode }),
  );
  registerMomentRoutes(router, storage);
  registerFailureRoutes(router, storage);
  if (options?.customRuleStore && options?.evalEngine) {
    registerRuleRoutes(router, storage, {
      customRuleStore: options.customRuleStore,
      evalEngine: options.evalEngine,
    });
  }
  if (options?.preferenceStore) {
    registerPreferencesRoutes(router, options.preferenceStore);
  }
  // Audit always available — falls back to default ~/.iris/audit.log path
  // when no custom rule store is provided (read-only access).
  registerAuditRoutes(router, options?.customRuleStore);
  app.use('/api/v1', router);

  // Serve static dashboard files if built (rate limited).
  //
  // Gate on index.html, not on the directory: `npm run build` compiles the
  // dashboard SERVER into dist/dashboard (server.js, routes/) without the UI
  // bundle, which is built separately by `cd dashboard && npm run build`. The
  // directory therefore exists while index.html does not, so the SPA fallback
  // was registered and every unmatched route hit res.sendFile on a missing
  // file. The resulting ENOENT carries an absolute path, and the error
  // handler returned it verbatim to the client:
  //   {"error":"ENOENT: ... stat 'C:\\...\\dist\\dashboard\\index.html'"}
  // — leaking the install path (and the OS user) to anyone who can reach the
  // dashboard. Without the UI built there is nothing to fall back TO, so the
  // route simply should not exist, and unmatched paths get Express's own 404.
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const staticDir = join(currentDir, '..', '..', 'dist', 'dashboard');
  const indexHtml = join(staticDir, 'index.html');

  /*
   * An unmatched /api/ path must answer as an API, not as the app.
   *
   * The SPA fallback below is deliberately a blanket catch-all so deep links
   * like /traces/<id> survive a reload. Without this guard it also swallowed
   * mistyped API routes: `GET /api/v1/tracez` returned 200 with index.html,
   * so a client saw SUCCESS and then threw "Unexpected token '<'" from
   * res.json() — sending the developer to debug their payload instead of
   * their URL. A liveness check asserting only status === 200 would call a
   * nonexistent endpoint healthy. POST to an unknown /api/ route reached
   * Express's HTML error page, which is the same problem in a smaller hat.
   *
   * Mounted before the static handler so it wins regardless of method, and
   * scoped to /api/ so nothing else changes.
   */
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Unknown API route' });
  });

  if (existsSync(indexHtml)) {
    app.use(createApiRateLimiter(config));
    app.use(express.static(staticDir));
    app.get('/{*path}', (_req, res) => {
      res.sendFile(indexHtml);
    });
  } else {
    // Without this warning the server logs "Dashboard available at ..."
    // while every page request 404s — an npm install always ships the
    // bundle, so this only bites from-source runs, but when it bites the
    // failure is opaque (before this line existed, a UI-less checkout
    // failed the entire E2E suite with nothing but element-not-found
    // timeouts).
    logger.warn(
      `Dashboard UI bundle not found at ${indexHtml} — serving API only. ` +
        `Build it with: cd dashboard && npm run build`,
    );
  }

  // Error handler (must be last)
  app.use(createErrorHandler(logger));

  return {
    app,
    start() {
      /*
       * Bind to config.dashboard.host (loopback by default). Omitting the
       * host argument makes Node listen on 0.0.0.0 AND [::], which put an
       * unauthenticated API — full trace history plus rule deploy/delete —
       * on every interface. That happened silently whenever `--transport
       * http` started the dashboard implicitly, so binding the MCP
       * transport to loopback still left a wide-open second server.
       */
      // Distinguishes "never bound" from "failed after startup" so the
      // error handler below can say which one actually happened.
      let bound = false;
      const server = app.listen(config.dashboard.port, config.dashboard.host, (err?: Error) => {
        /*
         * Express 5 also invokes this callback on a bind ERROR (it wires it
         * via `server.once('error', done)`). Before this guard, a port
         * collision ran the success path anyway: it logged "Dashboard
         * available at http://localhost:<port>" — a URL owned by a DIFFERENT
         * process — and overwrote runtime.json to point capture clients at
         * that stranger. Failures belong to the 'error' handler below.
         */
        if (err) return;
        bound = true;

        // Record the port actually bound so the rebinding guard builds its
        // allowlist from it rather than from a configured 0.
        const addr = server.address();
        if (typeof addr === 'object' && addr) boundPort = addr.port;

        /*
         * Port-discovery handshake for capture clients (the
         * @iris-eval/capture design pins this contract): write the port
         * actually bound to ${IRIS_HOME}/runtime.json so an SDK can find
         * the ingest endpoint without configuration. Best-effort — a
         * failed write must never take the dashboard down. The file may
         * go stale after an unclean exit; clients are expected to verify
         * with GET /api/v1/health before trusting it.
         */
        try {
          mkdirSync(irisHome(), { recursive: true });
          writeFileSync(
            join(irisHome(), 'runtime.json'),
            JSON.stringify(
              {
                dashboardPort: boundPort ?? config.dashboard.port,
                pid: process.pid,
                startedAt: new Date().toISOString(),
              },
              null,
              2,
            ),
          );
        } catch (err) {
          logger.warn(`Could not write runtime.json: ${(err as Error).message}`);
        }

        const shown = isLoopbackHost(config.dashboard.host) ? 'localhost' : config.dashboard.host;
        logger.info(`Dashboard available at http://${shown}:${boundPort ?? config.dashboard.port}`);
        if (!isLoopbackHost(config.dashboard.host) && !config.security.apiKey) {
          logger.warn(
            `Dashboard is bound to ${config.dashboard.host} with NO api key — the full trace ` +
              `history and rule management are reachable by anyone who can route to this host. ` +
              `Set --api-key / IRIS_API_KEY, or bind to 127.0.0.1.`,
          );
        }
      });
      /*
       * F-006: surface listen() errors instead of swallowing them.
       * Without this handler, EADDRINUSE (port already bound, typically
       * by the MCP HTTP transport) goes to the default Node 'error'
       * handler which emits a warning but doesn't crash — so the process
       * keeps running in a broken state. We log the specific cause then
       * exit(1) so the user sees the actual problem.
       *
       * Exiting nonzero is correct here because the dashboard only starts
       * when EXPLICITLY requested (--dashboard / IRIS_DASHBOARD / --demo —
       * see src/index.ts): the user asked for a surface they will not get,
       * and running on while a health gate reports "ready" would send them
       * to a port owned by a different process.
       */
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          logger.error(
            `Dashboard failed to start: port ${config.dashboard.port} is already in use ` +
              `(EADDRINUSE on ${config.dashboard.host}:${config.dashboard.port}). The dashboard was ` +
              `explicitly requested, so iris is exiting. Pass --dashboard-port <other> (or set ` +
              `IRIS_DASHBOARD_PORT) or stop the process that owns the port.`,
          );
        } else if (!bound) {
          logger.error(
            `Dashboard failed to start on ${config.dashboard.host}:${config.dashboard.port}: ${err.message}`,
          );
        } else {
          // Post-bind failure (e.g. EMFILE on accept) — "failed to start"
          // would misdescribe a server that had been up and serving.
          logger.error(`Dashboard server error after startup: ${err.message}`);
        }
        process.exit(1);
      });
      return server;
    },
  };
}
