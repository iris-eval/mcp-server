import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { IrisConfig } from '../types/config.js';

export function createAuthMiddleware(config: Pick<IrisConfig, 'security'>): RequestHandler {
  const apiKey = config.security.apiKey;

  if (!apiKey) {
    return (_req, _res, next) => next();
  }

  const keyBuffer = Buffer.from(apiKey);

  return (req, res, next) => {
    if (req.path === '/health' || req.path === '/api/v1/health') {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const tokenBuffer = Buffer.from(authHeader.slice(7));
    if (tokenBuffer.length !== keyBuffer.length || !timingSafeEqual(tokenBuffer, keyBuffer)) {
      res.status(403).json({ error: 'Invalid API key' });
      return;
    }

    next();
  };
}
