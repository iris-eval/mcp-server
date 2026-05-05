import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { IrisConfig } from '../types/config.js';

function hashToken(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function createAuthMiddleware(config: Pick<IrisConfig, 'security'>): RequestHandler {
  const apiKey = config.security.apiKey;

  if (!apiKey) {
    return (_req, _res, next) => next();
  }

  // Pre-hash so the per-request compare is fixed-width. The length-conditional
  // short-circuit this replaces leaked the configured key's length to a probing
  // attacker via timing.
  const keyHash = hashToken(apiKey);

  return (req, res, next) => {
    if (req.path === '/health' || req.path === '/api/v1/health') {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const tokenHash = hashToken(authHeader.slice(7));
    if (!timingSafeEqual(tokenHash, keyHash)) {
      res.status(403).json({ error: 'Invalid API key' });
      return;
    }

    next();
  };
}
