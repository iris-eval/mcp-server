import rateLimit from 'express-rate-limit';
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

export function createMcpRateLimiter(config: Pick<IrisConfig, 'security'>) {
  return rateLimit({
    windowMs: 60_000,
    limit: config.security.rateLimit.mcp,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  });
}
