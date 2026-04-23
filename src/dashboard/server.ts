import express from 'express';
import type { Server } from 'node:http';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { IStorageAdapter } from '../types/query.js';
import type { IrisConfig } from '../types/config.js';
import type { Logger } from '../utils/logger.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { createCorsMiddleware } from '../middleware/cors.js';
import { createErrorHandler } from '../middleware/error-handler.js';
import { createApiRateLimiter } from '../middleware/rate-limit.js';
import { createTenantMiddleware } from '../middleware/tenant.js';
import { registerTraceRoutes } from './routes/traces.js';
import { registerSummaryRoutes } from './routes/summary.js';
import { registerEvaluationRoutes } from './routes/evaluations.js';
import { registerFilterRoutes } from './routes/filters.js';
import { registerEvalStatsRoutes } from './routes/eval-stats.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMomentRoutes } from './routes/moments.js';
import { registerRuleRoutes } from './routes/rules.js';
import { registerPreferencesRoutes } from './routes/preferences.js';
import { registerAuditRoutes } from './routes/audit.js';
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
        // 'self' covers our bundled CSS. fonts.googleapis.com hosts the
        // brand fonts (Space Grotesk + Manrope + JetBrains Mono) loaded
        // via @import in tokens.css. Without this, the @import gets
        // blocked and the entire stylesheet is dropped by the browser.
        // v0.4.1 will self-host these fonts and let us tighten this back
        // to 'self' only.
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        // The fontFaces in those stylesheets resolve to fonts.gstatic.com.
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        connectSrc: ["'self'"],
      },
    },
  }));

  // Body parser with size limit
  app.use(express.json({ limit: config.security.requestSizeLimit }));

  // CORS
  app.use(createCorsMiddleware(config.security.allowedOrigins));

  // Authentication
  app.use(createAuthMiddleware(config));

  // Tenant resolution — attaches req.tenantId to every request.
  // OSS: always resolves to LOCAL_TENANT. Cloud: swaps for an auth-aware
  // resolver that reads the authenticated session. See middleware/tenant.ts.
  app.use(createTenantMiddleware());

  // API routes with rate limiting
  const router = express.Router();
  router.use(createApiRateLimiter(config));
  registerTraceRoutes(router, storage);
  registerSummaryRoutes(router, storage);
  registerEvaluationRoutes(router, storage);
  registerEvalStatsRoutes(router, storage);
  registerFilterRoutes(router, storage);
  registerHealthRoutes(router, storage, config.server.version);
  registerMomentRoutes(router, storage);
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

  // Serve static dashboard files if built (rate limited)
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const staticDir = join(currentDir, '..', '..', 'dist', 'dashboard');
  if (existsSync(staticDir)) {
    app.use(createApiRateLimiter(config));
    app.use(express.static(staticDir));
    app.get('/{*path}', (_req, res) => {
      res.sendFile(join(staticDir, 'index.html'));
    });
  }

  // Error handler (must be last)
  app.use(createErrorHandler(logger));

  return {
    app,
    start() {
      const server = app.listen(config.dashboard.port, () => {
        logger.info(`Dashboard available at http://localhost:${config.dashboard.port}`);
      });
      /*
       * F-006: surface listen() errors instead of swallowing them.
       * Without this handler, EADDRINUSE (port already bound, typically
       * by the MCP HTTP transport) goes to the default Node 'error'
       * handler which emits a warning but doesn't crash — so the process
       * keeps running in a broken state. We log the specific cause then
       * exit(1) so the user sees the actual problem.
       */
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          logger.error(
            `Dashboard failed to start: port ${config.dashboard.port} is already in use. ` +
              `If running HTTP transport on the same port, use --dashboard-port <other>.`,
          );
        } else {
          logger.error(`Dashboard server error: ${err.message}`);
        }
        process.exit(1);
      });
      return server;
    },
  };
}
