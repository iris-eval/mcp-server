import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { IrisConfig } from '../types/config.js';

export function createAuthMiddleware(config: Pick<IrisConfig, 'security'>): RequestHandler {
  const apiKey = config.security.apiKey;

  if (!apiKey) {
    return (_req, _res, next) => next();
  }

  const keyBuffer = Buffer.from(apiKey);
  const keyLen = keyBuffer.length;

  return (req, res, next) => {
    if (req.path === '/health' || req.path === '/api/v1/health') {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    // Pad the incoming token to the configured-key length and run
    // timingSafeEqual on same-size buffers. The byte-compare and the
    // length-equality check are computed independently before being
    // combined, so the request takes the same compare path regardless
    // of whether the token's length matches — eliminating the precise
    // length-equality fast-path the original code had.
    const tokenBuffer = Buffer.from(authHeader.slice(7));
    const candidate = Buffer.alloc(keyLen);
    tokenBuffer.copy(candidate, 0, 0, keyLen);
    const cmpEq = timingSafeEqual(candidate, keyBuffer);
    const lenEq = tokenBuffer.length === keyLen;
    if (!(cmpEq && lenEq)) {
      res.status(403).json({ error: 'Invalid API key' });
      return;
    }

    next();
  };
}
