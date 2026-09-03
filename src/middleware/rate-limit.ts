import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import type { IrisConfig } from '../types/config.js';

export function createApiRateLimiter(config: Pick<IrisConfig, 'security'>) {
  return rateLimit({
    windowMs: 60_000,
    limit: config.security.rateLimit.api,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  });
}

/**
 * JSON-RPC 2.0 application error code for "rate limited". The reserved
 * server range is -32000..-32099; the MCP SDK uses -32000/-32001 for
 * connection-closed and request-timeout, so this sits clear of both.
 * Mirrors HTTP 429 in the low digits so a log line reads at a glance.
 */
export const JSON_RPC_RATE_LIMITED = -32029;

/**
 * The MCP endpoint speaks JSON-RPC, so its 429 must too (#373). The stock
 * express-rate-limit body — `{ "error": "Too many requests" }` — is not a
 * JSON-RPC message: a strict client (the reference SDK included) fails to
 * parse the response and surfaces a PROTOCOL error, and the one thing the
 * caller needed to learn — wait, then retry — is exactly what got lost. The
 * envelope below echoes the request id when the body carried one, names
 * the limit and the wait, and points at the config key that raises it.
 */
export function createMcpRateLimiter(config: Pick<IrisConfig, 'security'>) {
  const limit = config.security.rateLimit.mcp;
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req: Request, res: Response) => {
      const body: unknown = req.body;
      const requestId =
        body !== null && typeof body === 'object' && !Array.isArray(body) && 'id' in body
          ? (body as { id: unknown }).id
          : null;
      const id = typeof requestId === 'string' || typeof requestId === 'number' ? requestId : null;
      const resetTime = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
      const retryAfterSeconds =
        resetTime instanceof Date ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000)) : 60;
      res.status(429).json({
        jsonrpc: '2.0',
        id,
        error: {
          code: JSON_RPC_RATE_LIMITED,
          message:
            `Rate limit exceeded: this MCP endpoint allows ${limit} requests per minute. ` +
            `Retry in ${retryAfterSeconds}s, or raise security.rateLimit.mcp in config.json for an interactive session.`,
          data: { limit, windowMs: 60_000, retryAfterSeconds },
        },
      });
    },
  });
}
