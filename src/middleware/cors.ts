import type { RequestHandler } from 'express';

// Wildcard `*` in an origin pattern matches a SINGLE label only — no dots,
// colons, or slashes. Previously substituted `.*`, which let
// `http://localhost:*` match `http://localhost:8080.evil.com` (the `.*`
// happily consumed `8080.evil.com`). Single-label match prevents the
// label-crossing bypass while still supporting `*.example.com` for
// per-subdomain allowlists and `localhost:*` for ephemeral dev ports.
function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  for (const pattern of allowedOrigins) {
    if (pattern === '*') return true;
    if (pattern === origin) return true;
    const regex = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.:/]+') + '$');
    if (regex.test(origin)) return true;
  }
  return false;
}

export function createCorsMiddleware(allowedOrigins: string[]): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isOriginAllowed(origin, allowedOrigins)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '86400');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
