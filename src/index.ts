#!/usr/bin/env node

import type { Server } from 'node:http';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from './config/index.js';
import { createStorage } from './storage/index.js';
import { createIrisServer } from './server.js';
import { createStdioTransport } from './transport/stdio.js';
import { createHttpTransport } from './transport/http.js';
import { createDashboardServer } from './dashboard/server.js';
import { createLogger } from './utils/logger.js';
import { loadOrInitPreferences, shouldAutoLaunchDashboard, createPreferenceStore } from './preferences.js';
import { openBrowser } from './utils/open-browser.js';
import { createCustomRuleStore } from './custom-rule-store.js';
import { createCustomRule } from './eval/rules/custom.js';
import { LOCAL_TENANT } from './types/tenant.js';
import { validatePortConfig } from './utils/validate-port-config.js';

const PortSchema = z
  .string()
  .regex(/^\d+$/, 'must be a positive integer')
  .transform((s) => parseInt(s, 10))
  .refine((n) => Number.isFinite(n) && n >= 1 && n <= 65535, 'must be between 1 and 65535');

const CliSchema = z
  .object({
    transport: z.enum(['stdio', 'http']).optional(),
    port: PortSchema.optional(),
    config: z.string().min(1).optional(),
    'db-path': z.string().min(1).optional(),
    'api-key': z.string().min(1).optional(),
    dashboard: z.boolean().optional(),
    'dashboard-port': PortSchema.optional(),
    help: z.boolean().optional(),
  })
  .strict();

let parsed;
try {
  parsed = parseArgs({
    options: {
      transport: { type: 'string' },
      port: { type: 'string' },
      config: { type: 'string' },
      'db-path': { type: 'string' },
      'api-key': { type: 'string' },
      dashboard: { type: 'boolean', default: false },
      'dashboard-port': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
} catch (err) {
  process.stderr.write(`iris-mcp: ${(err as Error).message}\nRun \`iris-mcp --help\` for usage.\n`);
  process.exit(2);
}

const validation = CliSchema.safeParse(parsed.values);
if (!validation.success) {
  const issues = validation.error.issues
    .map((i) => `  --${i.path.join('.')}: ${i.message}`)
    .join('\n');
  process.stderr.write(`iris-mcp: invalid argument(s):\n${issues}\nRun \`iris-mcp --help\` for usage.\n`);
  process.exit(2);
}
const values = validation.data;

if (values.help) {
  process.stderr.write(`
Iris — MCP-Native Agent Eval Server

Usage: iris-mcp [options]

Options:
  --transport <type>       Transport type: stdio (default) or http
  --port <number>          HTTP transport port 1-65535 (default: 3000)
  --config <path>          Config file path (default: ~/.iris/config.json)
  --db-path <path>         SQLite database path (default: ~/.iris/iris.db)
  --api-key <key>          API key for HTTP authentication
  --dashboard              Enable web dashboard
  --dashboard-port <port>  Dashboard port 1-65535 (default: 6920)
  -h, --help               Show this help message

Environment variables (CLI flags take precedence):
  IRIS_TRANSPORT           stdio | http
  IRIS_HOST                Bind address for HTTP transport (default: 127.0.0.1)
  IRIS_PORT                HTTP transport port (1-65535)
  IRIS_DB_PATH             SQLite database path
  IRIS_LOG_LEVEL           debug | info | warn | error
  IRIS_DASHBOARD           true to enable web dashboard
  IRIS_DASHBOARD_PORT      Dashboard port (1-65535, default: 6920)
  IRIS_API_KEY             API key for HTTP authentication
  IRIS_ALLOWED_ORIGINS     Comma-separated CORS origin allowlist
  IRIS_NO_AUTO_LAUNCH      Set to 1 to disable first-run dashboard auto-launch
  RATE_LIMIT_SALT          (waitlist API only — required when website is deployed)

Dashboard preferences (~/.iris/preferences.json):
  Edit autoLaunch: false to permanently disable first-run dashboard auto-launch.
`);
  process.exit(0);
}

const config = loadConfig({
  transport: values.transport,
  port: values.port,
  config: values.config,
  dbPath: values['db-path'],
  apiKey: values['api-key'],
  dashboard: values.dashboard,
  dashboardPort: values['dashboard-port'],
});

const logger = createLogger(config);

async function main(): Promise<void> {
  logger.info(`Starting Iris MCP server v${config.server.version}`);

  // F-006: fail fast on HTTP+dashboard port collision. See validatePortConfig.
  validatePortConfig(config);

  const storage = createStorage(config);
  await storage.initialize();
  logger.info(`Storage initialized (${config.storage.type}: ${config.storage.path})`);

  // Load the custom rule store first so it can be shared between the
  // MCP server (for deploy_rule / delete_rule / list_rules tools) and
  // the HTTP dashboard (Make-This-A-Rule composer). A rule deployed
  // via either surface is immediately visible from the other.
  const customRuleStore = createCustomRuleStore();

  const { mcpServer, evalEngine } = createIrisServer(config, storage, customRuleStore);

  // Load deployed custom rules from ~/.iris/custom-rules.json (B3 — workflow inversion).
  // Each enabled rule is registered with the engine under its evalType so it fires on
  // every evaluate_output call of that category. Persistence via custom-rule-store.
  const enabled = customRuleStore.enabledRules();
  for (const rule of enabled) {
    evalEngine.registerRule(rule.evalType, createCustomRule(rule.definition));
  }
  if (enabled.length > 0) {
    logger.info(
      `Loaded ${enabled.length} deployed custom rule(s) from ${customRuleStore.filePath}`,
    );
  }

  const httpServers: Server[] = [];

  // Run data retention cleanup on startup.
  //
  // For OSS single-tenant installs we explicitly scope cleanup to
  // LOCAL_TENANT. Cloud will enumerate all tenants (TenantRegistry) and
  // call this per-tenant so retention applies uniformly; the adapter
  // method already scopes DELETEs by tenant, so the behavior scales
  // cleanly.
  if (config.retention.days > 0) {
    try {
      const deleted = await storage.deleteTracesOlderThan(LOCAL_TENANT, config.retention.days);
      if (deleted > 0) {
        logger.info(`Retention cleanup: deleted ${deleted} trace(s) older than ${config.retention.days} days`);
      }
    } catch (err) {
      logger.warn(`Retention cleanup skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (config.transport.type === 'http') {
    const { transport, httpServer } = await createHttpTransport(mcpServer, config, logger);
    httpServers.push(httpServer);
    await mcpServer.connect(transport);
    const addr = httpServer.address();
    const portStr = typeof addr === 'object' && addr ? addr.port : config.transport.port;
    logger.info(`HTTP transport listening on ${config.transport.host}:${portStr}`);
  } else {
    const transport = createStdioTransport();
    await mcpServer.connect(transport);
    logger.info('Stdio transport connected');
    if (!config.dashboard.enabled) {
      logger.info(`Tip: run with --dashboard to open the web dashboard on port ${config.dashboard.port}`);
    }
  }

  if (config.dashboard.enabled || config.transport.type === 'http') {
    const preferenceStore = createPreferenceStore();
    const dashboardServer = createDashboardServer(storage, config, logger, {
      customRuleStore,
      evalEngine,
      preferenceStore,
    });
    const server = dashboardServer.start();
    httpServers.push(server);

    // First-run auto-launch (B7): on first dashboard launch, open the
    // dashboard in the user's default browser. Skipped in CI, when the
    // user has previously set autoLaunch=false in ~/.iris/preferences.json,
    // or when IRIS_NO_AUTO_LAUNCH=1 is set.
    if (config.dashboard.enabled) {
      const prefState = loadOrInitPreferences();
      if (prefState.isFirstRun && shouldAutoLaunchDashboard(prefState)) {
        const url = `http://localhost:${config.dashboard.port}`;
        logger.info(`First run detected — opening dashboard at ${url}`);
        logger.info(
          `(To disable auto-launch: set IRIS_NO_AUTO_LAUNCH=1 or edit ${prefState.path})`,
        );
        openBrowser(url);
      } else if (prefState.isFirstRun) {
        logger.info(
          `First run detected — skipping auto-launch (CI/IRIS_NO_AUTO_LAUNCH set). Dashboard at http://localhost:${config.dashboard.port}`,
        );
      }
    }
  }

  if (config.security.apiKey) {
    logger.info('API key authentication enabled');
  } else if (config.transport.type === 'http') {
    logger.warn('HTTP transport running without API key authentication — set IRIS_API_KEY for production');
  }

  const shutdown = async () => {
    logger.info('Shutting down gracefully...');

    const closePromises = httpServers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    );

    await Promise.race([
      Promise.all(closePromises),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);

    await storage.close();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error(`Fatal error: ${err instanceof Error ? err.message : err}`, {
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
