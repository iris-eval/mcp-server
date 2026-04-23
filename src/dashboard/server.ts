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
import { registerTraceRoutes } from './routes/traces.js';
import { registerSummaryRoutes } from './routes/summary.js';
import { registerEvaluationRoutes } from './routes/evaluations.js';
import { registerFilterRoutes } from './routes/filters.js';
import { registerEvalStatsRoutes } from './routes/eval-stats.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMomentRoutes } from './routes/moments.js';
import { registerRuleRoutes } from './routes/rules.js';
import type { CustomRuleStore } from '../custom-rule-store.js';
import type { EvalEngine } from '../eval/engine.js';

export interface DashboardServer {
  app: express.Application;
  start(): Server;
}

export interface DashboardServerOptions {
  customRuleStore?: CustomRuleStore;
  evalEngine?: EvalEngine;
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
        styleSrc: ["'self'", "'unsafe-inline'"],
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
      return app.listen(config.dashboard.port, () => {
        logger.info(`Dashboard available at http://localhost:${config.dashboard.port}`);
      });
    },
  };
}
