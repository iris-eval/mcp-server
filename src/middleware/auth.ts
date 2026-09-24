import type { Request, RequestHandler } from 'express';
import type { IrisConfig } from '../types/config.js';
import { buildKeyRing, type KeyRing } from '../security/keys.js';

/** A request the Bearer middleware authenticated carries the id of the key it presented. */
export interface AuthedRequest extends Request {
  apiKeyId?: string;
}

/**
 * Bearer authentication over the key ring.
 *
 * With no key configured anywhere this is a pass-through — the loopback
 * bind is the exposure control, and a bind beyond loopback with no key is
 * refused at startup (src/utils/bind-policy.ts). With keys, every request
 * except health must carry `Authorization: Bearer <key>`; the ring hashes
 * the candidate and compares it to every configured key in constant time
 * (src/security/keys.ts), so the compare depends neither on the candidate's
 * length nor on which key matched. The id of the key that matched is set
 * on the request for the per-key rate limiter and for logs; the key itself
 * is never stored on it.
 *
 * `ring` is built from the config when not given, so an embedder that
 * calls this directly gets the same behaviour; the server builds it once
 * and shares it with the dashboard's session layer.
 */
export function createAuthMiddleware(config: Pick<IrisConfig, 'security'>, ring: KeyRing = buildKeyRing(config.security)): RequestHandler {
  if (ring.empty) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    if (req.path === '/health' || req.path === '/api/v1/health') {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const id = ring.match(authHeader.slice(7));
    if (id === null) {
      res.status(403).json({ error: 'Invalid API key' });
      return;
    }
    (req as AuthedRequest).apiKeyId = id;
    next();
  };
}
