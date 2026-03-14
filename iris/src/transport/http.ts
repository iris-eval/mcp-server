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

  // Security headers (no CSP — API only, no HTML)
  app.use(helmet({ contentSecurityPolicy: false }));

  // Body parser with size limit
  app.use(express.json({ limit: config.security.requestSizeLimit }));

  // Health endpoint (no auth, no rate limit)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'iris-eval', timestamp: new Date().toISOString() });
  });

  // Authentication
  app.use(createAuthMiddleware(config));

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });

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

  const httpServer = await new Promise<Server>((resolve) => {
    const server = app.listen(config.transport.port, config.transport.host, () => resolve(server));
  });

  return { transport, httpServer };
}
