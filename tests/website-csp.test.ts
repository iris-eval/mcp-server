/*
 * The site's Content Security Policy runs no script it did not issue.
 *
 * Pages allowed `script-src 'unsafe-inline'`, so an HTML-injection bug
 * would also have been a script-injection bug. Pages now get a per-request
 * nonce from website/src/proxy.ts (with 'strict-dynamic' for the chunks
 * those scripts load), the root layout renders per request so Next can
 * stamp the nonce, and everything the proxy skips gets a fixed policy that
 * runs no script. The other security headers stay in next.config.ts. This
 * reads the source, because the policy is assembled there; the built site
 * was checked with real responses when the change was made.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const proxy = read('website/src/proxy.ts');
const config = read('website/next.config.ts');
const layout = read('website/src/app/layout.tsx');

describe('the page policy (website/src/proxy.ts)', () => {
  const scriptSrc = /^\s*`script-src ([^`]*)`,$/m.exec(proxy)?.[1] ?? '';

  it('allows scripts by nonce and strict-dynamic, never unsafe-inline', () => {
    expect(scriptSrc).toContain("'nonce-${nonce}'");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain('unsafe-inline');
    // unsafe-eval only in development, where React needs it for its error overlay.
    expect(scriptSrc).toContain(`\${dev ? " 'unsafe-eval'" : ''}`);
  });

  it('makes a fresh nonce per request and sends the policy on the request and the response', () => {
    expect(proxy).toContain('crypto.randomUUID()');
    expect(proxy).toContain("requestHeaders.set('Content-Security-Policy', policy)");
    expect(proxy).toContain("response.headers.set('Content-Security-Policy', policy)");
  });

  it('keeps the framing, object and base restrictions', () => {
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "default-src 'self'"]) {
      expect(proxy).toContain(d);
    }
  });

  it('the root layout renders per request, so the nonce reaches every page', () => {
    expect(layout).toMatch(/await connection\(\);/);
  });
});

describe('next.config.ts', () => {
  it('no longer sets a page policy with unsafe-inline scripts', () => {
    expect(config).not.toMatch(/script-src[^"\n]*unsafe-inline/);
  });

  it('gives what the proxy skips a policy that runs no script', () => {
    const csp = /const STATIC_CSP = \[([\s\S]*?)\]/.exec(config)?.[1] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
    expect(csp).toContain("frame-ancestors 'none'");
    for (const source of ['"/api/:path*"', '"/_next/:path*"']) expect(config).toContain(source);
  });

  it('keeps the other security headers on every path', () => {
    for (const h of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Strict-Transport-Security', 'Permissions-Policy']) {
      expect(config).toContain(`key: "${h}"`);
    }
    expect(config).toContain('max-age=31536000; includeSubDomains; preload');
  });
});
