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
import { EvalEngine } from './eval/engine.js';
import { LOCAL_TENANT } from './types/tenant.js';
import { validatePortConfig } from './utils/validate-port-config.js';
import { irisHome } from './utils/iris-home.js';
import {
  seedDemoData,
  clearDemoData,
  demoDbPath,
  demoPreferencesPath,
  demoCustomRulesPath,
  demoAuditLogPath,
  type SeedDemoDataSummary,
} from './dashboard/seed-demo-data.js';

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
    'dashboard-host': z.string().min(1).optional(),
    demo: z.boolean().optional(),
    'demo-clear': z.boolean().optional(),
    'self-test': z.boolean().optional(),
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
      'dashboard-host': { type: 'string' },
      demo: { type: 'boolean', default: false },
      'demo-clear': { type: 'boolean', default: false },
      'self-test': { type: 'boolean', default: false },
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
  --dashboard-host <host>  Dashboard bind address (default: 127.0.0.1). The dashboard is
                           unauthenticated unless --api-key is set — binding it beyond
                           loopback exposes your full trace history to the network.
  --demo                   Seed a demo database and serve the dashboard against it —
                           see the dashboard working before wiring up your agent.
                           Demo data lives in its own files (demo.db) and never mixes
                           with your real traces. Serves the dashboard only (no MCP
                           transport). Idempotent: re-running reuses the seeded data.
  --demo-clear             Delete the demo database (and its sidecar files), then exit.
                           Your real traces are not touched.
  --self-test              Run the offline install diagnostic and exit: storage round-trip,
                           deterministic evals, dashboard + rebinding guard — all inside an
                           isolated temp home. Exit code 0 = healthy, 1 = a check failed.
  -h, --help               Show this help message

Environment variables (CLI flags take precedence):
  IRIS_TRANSPORT                       stdio | http
  IRIS_HOST                            Bind address for HTTP transport (default: 127.0.0.1)
  IRIS_PORT                            HTTP transport port (1-65535)
  IRIS_HOME                            Directory for all per-user files: config.json, iris.db, custom-rules.json,
                                       audit.log, preferences.json (default: ~/.iris)
  IRIS_DB_PATH                         SQLite database path (overrides IRIS_HOME for the DB only)
  IRIS_LOG_LEVEL                       debug | info | warn | error
  IRIS_DASHBOARD                       true to enable web dashboard
  IRIS_DASHBOARD_PORT                  Dashboard port (1-65535, default: 6920)
  IRIS_DASHBOARD_HOST                  Dashboard bind address (default: 127.0.0.1)
  IRIS_API_KEY                         API key for HTTP authentication
  IRIS_ALLOWED_ORIGINS                 Comma-separated origin allowlist. Dashboard: CORS headers (supports globs, e.g. http://localhost:*).
                                       HTTP transport: exact-match Origin allowlist for DNS-rebinding protection (globs ignored;
                                       this server's own loopback origins are always allowed).
  IRIS_NO_AUTO_LAUNCH                  Set to 1 to disable first-run dashboard auto-launch
  IRIS_ANTHROPIC_API_KEY               Required by evaluate_with_llm_judge + verify_citations (provider=anthropic)
  IRIS_OPENAI_API_KEY                  Required by evaluate_with_llm_judge + verify_citations (provider=openai)
  IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL Hard cost cap per LLM judge call (default: 0.25)
  IRIS_CITATION_ALLOW_FETCH            Set to 1 to permit outbound HTTP in verify_citations (off by default)
  IRIS_CITATION_DOMAINS                Comma-separated hostname allowlist for verify_citations (suffix match)
  IRIS_OTEL_ENDPOINT                   Enable best-effort OTLP/HTTP JSON trace export to this collector URL
  IRIS_OTEL_SERVICE_NAME               service.name resource attribute for OTel export (default: iris-mcp)
  IRIS_OTEL_HEADERS                    Comma-separated k=v headers for OTel export (e.g. "authorization=Bearer abc")
  IRIS_OTEL_TIMEOUT_MS                 Per-export timeout (default: 15000)
  RATE_LIMIT_SALT                      (waitlist API only — required when website is deployed)

Dashboard preferences (~/.iris/preferences.json):
  Edit autoLaunch: false to permanently disable first-run dashboard auto-launch.
`);
  process.exit(0);
}

/*
 * --self-test exits BEFORE loadConfig() runs at module scope below —
 * deliberately. The diagnostic builds its own isolated IRIS_HOME and
 * scrubs the IRIS_* env layer (src/self-test.ts), so the normal boot
 * path's config (and the user's real ~/.iris) must never load first.
 */
if (values['self-test']) {
  const { runSelfTest } = await import('./self-test.js');
  process.exit(await runSelfTest());
}

/*
 * Demo-mode flag validation happens before loadConfig so a refused
 * combination exits without touching the filesystem.
 */
if (values.demo && values['demo-clear']) {
  process.stderr.write('iris-mcp: --demo and --demo-clear cannot be combined.\nRun `iris-mcp --help` for usage.\n');
  process.exit(2);
}
if (values.demo && values['db-path']) {
  process.stderr.write(
    'iris-mcp: --demo always serves its own database (demo.db under your iris home) and cannot be combined with --db-path.\n' +
      'Run `iris-mcp --demo` alone, or drop --demo to use your own database.\n',
  );
  process.exit(2);
}

if (values['demo-clear']) {
  const { removed } = clearDemoData();
  if (removed.length === 0) {
    process.stderr.write(`iris-mcp: no demo data found under "${irisHome()}" — nothing to remove.\n`);
  } else {
    for (const path of removed) {
      process.stderr.write(`iris-mcp: removed "${path}"\n`);
    }
    process.stderr.write('iris-mcp: demo data cleared. Your real traces were not touched.\n');
  }
  process.exit(0);
}

const config = loadConfig({
  transport: values.transport,
  port: values.port,
  config: values.config,
  // Demo mode serves the dashboard against the dedicated demo database —
  // never the real store — and always with the dashboard enabled.
  dbPath: values.demo ? demoDbPath() : values['db-path'],
  apiKey: values['api-key'],
  dashboard: values.demo ? true : values.dashboard,
  dashboardPort: values['dashboard-port'],
  dashboardHost: values['dashboard-host'],
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
  // OSS single-tenant: register rules under LOCAL_TENANT only. Cloud multi-tenant
  // engine wiring is a v0.5 architectural item (the engine is a process singleton
  // and would need per-tenant rule registration).
  const enabled = customRuleStore.enabledRules(LOCAL_TENANT);
  for (const rule of enabled) {
    // Severity rides along: high/critical deployed rules hard-fail the
    // evals they lose (createCustomRule sets EvalRule.critical from it).
    evalEngine.registerRule(rule.evalType, createCustomRule(rule.definition, rule.severity), rule.id);
  }
  if (enabled.length > 0) {
    logger.info(
      `Loaded ${enabled.length} deployed custom rule(s) from ${customRuleStore.pathFor(LOCAL_TENANT)}`,
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

function printDemoBanner(summary: SeedDemoDataSummary, url: string): void {
  const line = '='.repeat(60);
  const counts = summary.alreadySeeded
    ? `  Reusing the existing demo database (${summary.traceCount} traces, ${summary.evalCount} evaluations).`
    : `  Seeded ${summary.traceCount} traces / ${summary.evalCount} evaluations across the last 7 days.`;
  process.stderr.write(`
${line}
  IRIS DEMO MODE — everything on screen is demo data
${line}

${counts}
  Demo database: "${summary.dbPath}"
  Your real trace database is untouched — demo data never mixes with it.

  Worth clicking into:
    - a PII leak (a synthetic SSN in an agent reply) caught by the safety rules
    - a prompt-injection attempt flagged in summarized forum posts
    - a failed LLM-judge score, with the judge's rationale

  Dashboard: ${url}

  Remove the demo data with one command:
    npx @iris-eval/mcp-server --demo-clear

  Press Ctrl+C to stop.

`);
}

/*
 * Demo mode (--demo): seed the dedicated demo database (idempotent) and
 * serve the dashboard against it. No MCP transport is started — demo mode
 * exists to put something real on screen before an agent is wired up.
 *
 * Isolation: everything demo mode writes lives in demo-scoped files under
 * irisHome() (demo.db, demo-preferences.json, demo-custom-rules.json,
 * demo-audit.log). A rule deployed from the demo dashboard lands in the
 * demo rule store, and --demo-clear removes all of it. The real iris.db,
 * custom-rules.json, audit.log and preferences.json are never touched.
 */
async function runDemo(): Promise<void> {
  logger.info(`Starting Iris demo mode v${config.server.version}`);

  const seedSummary = await seedDemoData();
  if (seedSummary.alreadySeeded) {
    logger.info(`Demo database already seeded (${seedSummary.traceCount} traces) — reusing it`);
  } else {
    logger.info(`Seeded demo database with ${seedSummary.traceCount} traces at ${seedSummary.dbPath}`);
  }

  const storage = createStorage(config);
  await storage.initialize();

  const customRuleStore = createCustomRuleStore({
    pathFor: () => demoCustomRulesPath(),
    auditPath: demoAuditLogPath(),
  });
  const evalEngine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds);
  for (const rule of customRuleStore.enabledRules(LOCAL_TENANT)) {
    evalEngine.registerRule(rule.evalType, createCustomRule(rule.definition, rule.severity), rule.id);
  }
  const preferenceStore = createPreferenceStore(demoPreferencesPath());

  const dashboardServer = createDashboardServer(storage, config, logger, {
    customRuleStore,
    evalEngine,
    preferenceStore,
  });
  const server = dashboardServer.start();

  server.on('listening', () => {
    // Use the port actually bound (supports --dashboard-port 0 in tests).
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : config.dashboard.port;
    const url = `http://localhost:${port}`;
    printDemoBanner(seedSummary, url);
    const prefState = loadOrInitPreferences(demoPreferencesPath());
    if (shouldAutoLaunchDashboard(prefState)) {
      openBrowser(url);
    }
  });

  const shutdown = async () => {
    logger.info('Shutting down gracefully...');
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    await storage.close();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const run = values.demo ? runDemo : main;
run().catch((err) => {
  logger.error(`Fatal error: ${err instanceof Error ? err.message : err}`, {
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
