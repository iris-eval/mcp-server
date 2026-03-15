#!/usr/bin/env node

import type { Server } from 'node:http';
import { parseArgs } from 'node:util';
import { loadConfig } from './config/index.js';
import { createStorage } from './storage/index.js';
import { createIrisServer } from './server.js';
import { createStdioTransport } from './transport/stdio.js';
import { createHttpTransport } from './transport/http.js';
import { createDashboardServer } from './dashboard/server.js';
import { createLogger } from './utils/logger.js';

const { values } = parseArgs({
  options: {
    transport: { type: 'string', default: undefined },
    port: { type: 'string', default: undefined },
    config: { type: 'string', default: undefined },
    'db-path': { type: 'string', default: undefined },
    'api-key': { type: 'string', default: undefined },
    dashboard: { type: 'boolean', default: false },
    'dashboard-port': { type: 'string', default: undefined },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (values.help) {
  process.stderr.write(`
Iris — MCP-Native Agent Eval & Observability Server

Usage: iris-mcp [options]

Options:
  --transport <type>       Transport type: stdio (default) or http
  --port <number>          HTTP transport port (default: 3000)
  --config <path>          Config file path (default: ~/.iris/config.json)
  --db-path <path>         SQLite database path (default: ~/.iris/iris.db)
  --api-key <key>          API key for HTTP authentication
  --dashboard              Enable web dashboard
  --dashboard-port <port>  Dashboard port (default: 6920)
  -h, --help               Show this help message
`);
  process.exit(0);
}

const config = loadConfig({
  transport: values.transport as string | undefined,
  port: values.port ? parseInt(values.port as string) : undefined,
  config: values.config as string | undefined,
  dbPath: values['db-path'] as string | undefined,
  apiKey: values['api-key'] as string | undefined,
  dashboard: values.dashboard as boolean | undefined,
  dashboardPort: values['dashboard-port'] ? parseInt(values['dashboard-port'] as string) : undefined,
});

const logger = createLogger(config);

async function main(): Promise<void> {
  logger.info(`Starting Iris MCP server v${config.server.version}`);

  const storage = createStorage(config);
  await storage.initialize();
  logger.info(`Storage initialized (${config.storage.type}: ${config.storage.path})`);

  const { mcpServer } = createIrisServer(config, storage);
  const httpServers: Server[] = [];

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
  }

  if (config.dashboard.enabled || config.transport.type === 'http') {
    const dashboardServer = createDashboardServer(storage, config, logger);
    const server = dashboardServer.start();
    httpServers.push(server);
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
