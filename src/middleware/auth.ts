import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { IrisConfig } from '../types/config.js';

export function createAuthMiddleware(config: Pick<IrisConfig, 'security'>): RequestHandler {
  const apiKey = config.security.apiKey;

  if (!apiKey) {
    return (_req, _res, next) => next();
  }

  // Random per-process HMAC key. Never persisted; exists only so that
  // every incoming token is reduced to a 32-byte digest of the same
  // shape as the configured-key digest, letting timingSafeEqual compare
  // them on a fixed-width buffer. This eliminates the length-leak
  // side-channel of the original length-conditional short-circuit
  // without falling into "store a hashed credential" territory — the
  // ephemeral key + HMAC construction means an attacker who later
  // exfiltrates `keyDigest` cannot reuse it across processes or
  // brute-force apiKey offline (HMAC key is unknown).
  const hmacKey = randomBytes(32);
  const digest = (s: string): Buffer => createHmac('sha256', hmacKey).update(s).digest();
  const keyDigest = digest(apiKey);

  return (req, res, next) => {
    if (req.path === '/health' || req.path === '/api/v1/health') {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const tokenDigest = digest(authHeader.slice(7));
    if (!timingSafeEqual(tokenDigest, keyDigest)) {
      res.status(403).json({ error: 'Invalid API key' });
      return;
    }

    next();
  };
}
