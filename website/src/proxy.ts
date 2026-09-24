/*
 * A per-request Content Security Policy with a script nonce.
 *
 * The policy used to allow `script-src 'unsafe-inline'`, so any bug that let
 * text reach the page as HTML would also have let it run as script. Now each
 * page response carries a fresh nonce: Next reads it from the request's
 * Content-Security-Policy header and stamps it on every script it renders
 * (the framework's own bootstrap and chunk tags), and `'strict-dynamic'`
 * lets those scripts load the chunks they import. An injected <script> has
 * no nonce and does not run.
 *
 * A nonce has to be new on every response, so pages render per request: the
 * root layout reads the nonce (app/layout.tsx), which opts every page out
 * of static prerendering. That costs server rendering on each page view in
 * exchange for a policy that blocks injected script.
 *
 * Styles keep 'unsafe-inline': React style attributes and the animation
 * library set inline styles, which a style nonce cannot cover, and CSS
 * cannot run script. The other security headers stay in next.config.ts.
 */
import { NextResponse, type NextRequest } from 'next/server';

export function contentSecurityPolicy(nonce: string, dev = false): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self' https://iris-eval.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const policy = contentSecurityPolicy(nonce, process.env.NODE_ENV === 'development');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not the API, not built assets, not files served from
      // public/ (anything with an extension). Those keep the static policy
      // in next.config.ts. Prefetches carry no HTML of their own.
      source: '/((?!api|_next/static|_next/image|.*\\.[a-zA-Z0-9]+$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
