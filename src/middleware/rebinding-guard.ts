import type { RequestHandler } from 'express';

/*
 * DNS-rebinding protection for the dashboard HTTP API.
 *
 * v0.4.5 closed this hole on the MCP transport (/mcp) by handing
 * allowedOrigins + allowedHosts to the SDK. The dashboard — same data,
 * plus every mutating endpoint — never got the equivalent, and it starts
 * implicitly alongside `--transport http`. So a browser on any page could
 * POST a rule deployment to http://localhost:6920 and the server would
 * execute it.
 *
 * CORS does not substitute, for the reason already written down in
 * transport/http.ts: the browser withholds the RESPONSE, but the write has
 * already happened. The request has to be REJECTED.
 *
 * Two checks, mirroring the SDK's semantics:
 *
 *   Origin — enforced whenever the header is present. Absent means a
 *   non-browser client (curl, an MCP client, a health probe), which is not
 *   the threat model here; browsers always send it on cross-origin
 *   requests. Exact match only — glob patterns from the CORS allowlist are
 *   meaningless against a single concrete Origin and are dropped rather
 *   than left in the list looking effective.
 *
 *   Host — enforced only when bound to loopback. A non-loopback bind is a
 *   deliberate network deployment, usually behind a proxy that rewrites
 *   Host, and an exact-match list would break it.
 */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** Concrete origins/hosts this server answers to on `port`. */
export function loopbackOriginsFor(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
}

export function loopbackHostsFor(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

export interface RebindingGuardOptions {
  /**
   * Port the server is actually bound to. Accepts a resolver because the
   * middleware is registered BEFORE listen() — and the configured port is
   * 0 whenever the caller wants an ephemeral one (tests and embedders do
   * this). Baking 0 into the allowlist would produce `http://localhost:0`
   * and reject every real request with a 403 that looks exactly like an
   * attack. Same trap the MCP transport documents at transport/http.ts.
   */
  port: number | (() => number);
  /** Bind address, used to decide whether Host validation applies. */
  host: string;
  /** Operator's configured origins; glob entries are ignored (see above). */
  allowedOrigins?: string[];
}

export function createRebindingGuard(options: RebindingGuardOptions): RequestHandler {
  const { port, host, allowedOrigins = [] } = options;
  const exactConfigured = allowedOrigins.filter((o) => !o.includes('*'));
  const enforceHost = isLoopbackHost(host);

  let cache: { port: number; origins: Set<string>; hosts: Set<string> } | undefined;

  function listsFor(resolvedPort: number) {
    if (cache?.port !== resolvedPort) {
      cache = {
        port: resolvedPort,
        origins: new Set([...loopbackOriginsFor(resolvedPort), ...exactConfigured]),
        /*
         * `[::1]:port` is the form Node actually puts in the Host header
         * for an IPv6 loopback request — brackets included. A guard
         * written against the bare '::1' would be inert, which is exactly
         * how the citation-fetch SSRF guard was silently dead before
         * v0.4.5 (URL.hostname returns '[::1]', never '::1').
         */
        hosts: new Set(loopbackHostsFor(resolvedPort)),
      };
    }
    return cache;
  }

  return (req, res, next) => {
    const resolvedPort = typeof port === 'function' ? port() : port;
    const { origins, hosts } = listsFor(resolvedPort);

    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) {
      res.status(403).json({ error: 'Forbidden: invalid Origin header' });
      return;
    }
    if (enforceHost) {
      const hostHeader = req.headers.host;
      if (hostHeader && !hosts.has(hostHeader)) {
        res.status(403).json({ error: 'Forbidden: invalid Host header' });
        return;
      }
    }
    next();
  };
}
