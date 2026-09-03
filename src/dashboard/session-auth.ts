/*
 * session-auth — a browser can sign in to an --api-key dashboard.
 *
 * The auth middleware (middleware/auth.ts) is Bearer-only, which is right
 * for MCP clients and capture SDKs and useless for a browser: with
 * `--api-key` set — the README's own "production deployment" command — the
 * dashboard UI 401'd every page load, because nothing lets a browser
 * present the key (#373 item 6).
 *
 * This layer sits in FRONT of the Bearer middleware and adds one thing: a
 * session cookie, obtained by presenting the key once.
 *
 *   GET  /?key=<api key>      exchange the key for a session, then redirect
 *                             to the same URL with the key stripped
 *   POST /session  key=<…>    same exchange from the sign-in form
 *   GET  <any page>           without a session → a 401 sign-in page
 *                             (HTML, only for requests that ask for HTML)
 *
 * A request carrying a valid session cookie skips the Bearer check. Every
 * other request — API calls without a cookie, wrong keys, non-browser
 * clients — falls through to the unchanged Bearer middleware, so nothing
 * that worked before behaves differently.
 *
 * What the cookie is NOT: it is not the API key. It is a random 256-bit
 * token that maps, in this process's memory, to "a request presented the
 * key". HttpOnly (no script can read it), SameSite=Lax (never sent on a
 * cross-site fetch, XHR or form POST — the CSRF vectors; still sent on a
 * plain link into the dashboard so a shared URL opens without re-signing
 * in), Path=/ (this origin only), Secure when the request arrived over
 * HTTPS. Sessions die with the process; there is no persistence to leak.
 *
 * Brute force: the key exchange is throttled per client address
 * independently of the API limiter, which the Bearer path — mounted before
 * the rate-limited router — never got.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';

export const SESSION_COOKIE = 'iris_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 256;
const SIGN_IN_ATTEMPTS_PER_MINUTE = 10;

export interface SessionAuthOptions {
  apiKey: string | undefined;
  /** The Bearer middleware every non-session request still goes through. */
  bearerAuth: RequestHandler;
}

function keyMatches(candidateRaw: string, apiKey: string): boolean {
  // Same shape as middleware/auth.ts: pad to the key length and compare
  // fixed-size buffers so the compare path does not depend on the
  // candidate's length.
  const keyBuffer = Buffer.from(apiKey);
  const tokenBuffer = Buffer.from(candidateRaw);
  const candidate = Buffer.alloc(keyBuffer.length);
  tokenBuffer.copy(candidate, 0, 0, keyBuffer.length);
  const cmpEq = timingSafeEqual(candidate, keyBuffer);
  const lenEq = tokenBuffer.length === keyBuffer.length;
  return cmpEq && lenEq;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function wantsHtml(req: Request): boolean {
  return req.method === 'GET' && !req.path.startsWith('/api/') && /text\/html/i.test(req.headers.accept ?? '');
}

const PAGE_STYLE = `
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0f14; color: #e6edf3;
         font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(92vw, 460px); padding: 32px; border: 1px solid #263140; border-radius: 12px; background: #111820; }
  h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: -0.01em; }
  .tagline { margin: 0 0 20px; color: #8b97a6; font-size: 13px; }
  p { margin: 0 0 14px; color: #c3ccd6; }
  code { font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: 13px; background: #1a2330; padding: 1px 5px; border-radius: 4px; }
  label { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #8b97a6; margin-bottom: 6px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #2c3949; border-radius: 8px; background: #0b0f14; color: #e6edf3; font: inherit; }
  button { margin-top: 14px; width: 100%; padding: 10px 12px; border: 0; border-radius: 8px; background: #2dd4bf; color: #04201c; font: inherit; font-weight: 600; cursor: pointer; }
  .error { color: #f87171; font-weight: 600; }
  .fine { margin-top: 18px; font-size: 12px; color: #8b97a6; }
`;

function signInPage(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Iris — sign in</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
  <h1>Iris dashboard</h1>
  <p class="tagline">This dashboard is protected by an API key.</p>
  ${error ? `<p class="error" role="alert">${error}</p>` : ''}
  <p>This server was started with <code>--api-key</code> (or <code>IRIS_API_KEY</code>), so the dashboard asks for that key once. Your browser then keeps an HttpOnly session cookie for this origin — the key itself is never stored in the browser.</p>
  <form method="post" action="/session">
    <label for="key">API key</label>
    <input id="key" name="key" type="password" autocomplete="off" autofocus required>
    <button type="submit">Open dashboard</button>
  </form>
  <p class="fine">Sharing a link with a teammate? Append <code>?key=&lt;api key&gt;</code> to any dashboard URL — it signs the browser in and redirects to the page with the key removed from the address bar. API clients keep using <code>Authorization: Bearer &lt;api key&gt;</code>.</p>
</main>
</body>
</html>`;
}

export function createSessionAuth(opts: SessionAuthOptions): RequestHandler {
  const { apiKey, bearerAuth } = opts;
  if (!apiKey) {
    // No key configured: the Bearer middleware is a pass-through and so is
    // this. A `?key=` on the URL is left alone — nothing to exchange.
    return bearerAuth;
  }

  /** token → expiry (epoch ms). Insertion order doubles as age order. */
  const sessions = new Map<string, number>();

  function createSession(): string {
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    return token;
  }

  function hasSession(req: Request): boolean {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return false;
    const expires = sessions.get(token);
    if (expires === undefined) return false;
    if (expires <= Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function setSessionCookie(req: Request, res: Response): void {
    const token = createSession();
    const attrs = [
      `${SESSION_COOKIE}=${token}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (req.protocol === 'https') attrs.push('Secure');
    res.append('Set-Cookie', attrs.join('; '));
  }

  function sendSignIn(res: Response, status: 401 | 403, error?: string): void {
    res.status(status).type('html').send(signInPage(error));
  }

  const signInLimiter = rateLimit({
    windowMs: 60_000,
    limit: SIGN_IN_ATTEMPTS_PER_MINUTE,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts, please try again later' },
  });

  const formBody = express.urlencoded({ extended: false, limit: '4kb' });

  const exchange: RequestHandler = (req, res, next) => {
    // 1. `?key=` on a page URL — the one-line team recipe.
    if (req.method === 'GET' && !req.path.startsWith('/api/') && typeof req.query.key === 'string') {
      if (!keyMatches(req.query.key, apiKey)) {
        sendSignIn(res, 403, 'That API key did not match.');
        return;
      }
      setSessionCookie(req, res);
      const url = new URL(req.originalUrl, 'http://localhost');
      url.searchParams.delete('key');
      res.redirect(302, `${url.pathname}${url.search}`);
      return;
    }

    // 2. The sign-in form (or a JSON body with the same shape).
    if (req.method === 'POST' && req.path === '/session') {
      formBody(req, res, (err?: unknown) => {
        if (err) {
          next(err);
          return;
        }
        const body = req.body as { key?: unknown } | undefined;
        const key = typeof body?.key === 'string' ? body.key : '';
        if (!key || !keyMatches(key, apiKey)) {
          sendSignIn(res, 403, 'That API key did not match.');
          return;
        }
        setSessionCookie(req, res);
        res.redirect(303, '/');
      });
      return;
    }

    next();
  };

  return (req, res, next) => {
    if (req.path === '/health' || req.path === '/api/v1/health') {
      next();
      return;
    }
    /*
     * The exchange runs BEFORE the session check on purpose: a browser
     * that already has a session and opens a shared `?key=` link must
     * still be redirected to the key-free URL, or the key sits in its
     * address bar (and history) for the rest of the visit.
     */
    const isExchange =
      (req.method === 'GET' && !req.path.startsWith('/api/') && typeof req.query.key === 'string') ||
      (req.method === 'POST' && req.path === '/session');
    if (isExchange) {
      signInLimiter(req, res, (err?: unknown) => (err ? next(err) : exchange(req, res, next)));
      return;
    }
    if (hasSession(req)) {
      next();
      return;
    }
    if (wantsHtml(req)) {
      sendSignIn(res, 401);
      return;
    }
    bearerAuth(req, res, next);
  };
}
