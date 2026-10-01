/*
 * Compressed responses for the dashboard (0.20.0).
 *
 * Until 0.20.0 the dashboard sent every file and every API response as-is.
 * On loopback that costs nothing; with --dashboard-host on a LAN or a
 * remote host the first load moved 329 KB of JavaScript that compresses to
 * about 100 KB, and a page of search results is ~76 KB of JSON.
 *
 * Two mechanisms, because the two kinds of response differ:
 *
 *   Static files are fixed at build time, so they are compressed once, at
 *   the smallest size brotli and gzip reach, by the dashboard's build
 *   (dashboard/vite.config.ts writes a `.br` and a `.gz` beside every file
 *   it emits). The server serves the variant the client accepts, and
 *   spends no CPU on it.
 *
 *   API responses are built per request, so they are compressed per
 *   request, at a fast setting, on libuv's thread pool rather than the
 *   event loop, and only when they are big enough for it to pay, and only
 *   for a client on another machine (below).
 *
 * What is never compressed, and why:
 *
 *   - An API response to a client on this machine (a loopback address).
 *     There is no network to save: compressing and decoding a 50-trace page
 *     cost about 2.2 ms, and took `GET /api/v1/traces?limit=50` from 6.3 ms
 *     to 8.5 ms at 100,000 traces (#761). A reverse proxy on the same host
 *     also connects over loopback, and compresses for its own clients.
 *   - The answer to a write (POST, PUT, PATCH, DELETE): an acknowledgement,
 *     where compressing costs the writer time and saves nothing that
 *     matters (READS below).
 *   - Anything streamed. Only a whole body handed to res.send / res.json is
 *     compressed; res.write and pipe pass through byte for byte, so a
 *     server-sent-event stream or a streamed export keeps flushing as it is
 *     written. Only JSON types are compressed at all, so
 *     text/event-stream never is.
 *   - A response that already has a Content-Encoding, or says
 *     `Cache-Control: no-transform`.
 *   - A response to a request a browser made from another site
 *     (`Sec-Fetch-Site: cross-site` or `same-site`). This is the BREACH
 *     guard. Compression leaks, through the response's length, how much of
 *     an attacker's text matches a secret in the same body, and that needs
 *     the attacker to make the victim's browser send authenticated requests
 *     carrying text of their choosing. The session cookie is SameSite=Lax,
 *     so the only cross-site requests that carry it are top-level
 *     navigations, and those arrive marked cross-site. So compression only
 *     happens where the page itself, or a client that is not a browser
 *     (which sends no Sec-Fetch-Site), asked. No API response carries the
 *     API key or the session token.
 */
import { brotliCompress, constants, gzip } from 'node:zlib';
import { readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { Request, RequestHandler, Response } from 'express';

/** Bodies smaller than this go out as they are: the headers and the CPU cost more than the bytes saved. */
export const COMPRESS_MIN_BYTES = 1024;

/*
 * Brotli quality 4 for dynamic responses. Measured on a 36.6 KB page of 50
 * traces: quality 4 makes it 14.1 KB in 0.8 ms; quality 5 saves another 4%
 * in twice the time, and quality 11 (what the build uses for static files)
 * takes 60 ms. gzip level 6 makes it 14.0 KB in 0.9 ms.
 */
const BROTLI_DYNAMIC_QUALITY = 4;
const GZIP_DYNAMIC_LEVEL = 6;

type Coding = 'br' | 'gzip';

/** Whether an address is this machine: 127.0.0.0/8, ::1, or an IPv4 loopback address mapped into IPv6. */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return v4.startsWith('127.') || address === '::1';
}

/** A browser request from another site, which must not get a compressed body (the BREACH guard above). */
function crossSite(req: Request): boolean {
  const site = req.headers['sec-fetch-site'];
  return site === 'cross-site' || site === 'same-site';
}

/** The coding to use for this request, brotli first; null when the client accepts neither. */
function negotiate(req: Request, available: { br: boolean; gzip: boolean }): Coding | null {
  // req.acceptsEncodings honours q-values, so `br;q=0` is a refusal, not a preference.
  if (available.br && req.acceptsEncodings('br') === 'br') return 'br';
  if (available.gzip && req.acceptsEncodings('gzip') === 'gzip') return 'gzip';
  return null;
}

/*
 * Only reads. The bodies worth compressing are the pages the dashboard and
 * API clients read: lists, searches, a trace with its spans. A write's
 * answer is an acknowledgement (the stored trace's id, its verdict), and
 * compressing it on the thread pool keeps the request waiting for bytes no
 * one needed saved: 1 ms of an 8 ms `POST /api/v1/traces` with evaluate.
 */
const READS = new Set(['GET', 'HEAD']);

const COMPRESSIBLE_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

/**
 * Compresses whole JSON bodies of COMPRESS_MIN_BYTES or more, sent with
 * res.send or res.json, in answer to a GET or HEAD from another machine.
 * Mount it before the routes it covers. `compressLoopback` compresses for
 * loopback clients too: the tests' clients are all on loopback.
 */
export function compressJsonResponses(options: { compressLoopback?: boolean } = {}): RequestHandler {
  return (req, res, next) => {
    if (!READS.has(req.method)) return next();
    if (!options.compressLoopback && isLoopback(req.socket.remoteAddress)) return next();
    const send = res.send.bind(res) as (body?: unknown) => Response;
    res.send = function compressedSend(body?: unknown): Response {
      if (!(typeof body === 'string' || Buffer.isBuffer(body))) return send(body);
      const type = String(res.getHeader('Content-Type') ?? '');
      if (!COMPRESSIBLE_TYPE.test(type)) return send(body);
      const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      if (bytes.length < COMPRESS_MIN_BYTES) return send(body);
      // From here the body could have been compressed, so caches must key on what decided it.
      res.vary('Accept-Encoding');
      res.vary('Sec-Fetch-Site');
      if (res.statusCode < 200 || res.statusCode === 204 || res.statusCode === 304) return send(body);
      if (res.getHeader('Content-Encoding') !== undefined) return send(body);
      if (/\bno-transform\b/i.test(String(res.getHeader('Cache-Control') ?? ''))) return send(body);
      if (crossSite(req)) return send(body);
      const coding = negotiate(req, { br: true, gzip: true });
      if (coding === null) return send(body);
      const done = (err: Error | null, out: Buffer): void => {
        if (err || res.headersSent) {
          if (!res.headersSent) send(body);
          return;
        }
        res.setHeader('Content-Encoding', coding);
        send(out);
      };
      if (coding === 'br') {
        brotliCompress(
          bytes,
          {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: BROTLI_DYNAMIC_QUALITY,
              [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
              [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
            },
          },
          done,
        );
      } else {
        gzip(bytes, { level: GZIP_DYNAMIC_LEVEL }, done);
      }
      return res;
    };
    next();
  };
}

export interface Variants {
  br: boolean;
  gzip: boolean;
}

/**
 * The precompressed variants under a directory, keyed by URL path
 * ("/assets/index-abc.js"). A variant counts only when the file it was made
 * from is still there and is not newer than it: the dashboard's output
 * directory is not emptied between builds, and a `.br` left behind by an
 * older build must never be served for a newer file.
 */
export function findPrecompressed(root: string): Map<string, Variants> {
  const found = new Map<string, Variants>();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // express.static does not serve dot-files (Vite's .vite/manifest.json), so neither is a variant of one.
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      const ext = extname(e.name);
      const coding: Coding | null = ext === '.br' ? 'br' : ext === '.gz' ? 'gzip' : null;
      if (coding === null) continue;
      const original = full.slice(0, -ext.length);
      try {
        if (statSync(original).mtimeMs > statSync(full).mtimeMs) continue;
      } catch {
        continue;
      }
      const url = `/${relative(root, original).split(sep).join('/')}`;
      const v = found.get(url) ?? { br: false, gzip: false };
      v[coding] = true;
      found.set(url, v);
    }
  };
  walk(root);
  return found;
}

/**
 * Serves a precompressed variant of a static file when the client accepts
 * one. Mount it at the root, directly in front of the express.static
 * handlers for the directory the variants were found in: it rewrites the
 * request to the variant's name and sets the headers, and express.static
 * does the rest (ranges, ETag, caching headers). The Content-Type is set
 * here from the original name, and express.static keeps a type that is
 * already set. `index` names the file a request for a directory serves, as
 * it does for express.static.
 */
export function servePrecompressed(variants: Map<string, Variants>, options: { index?: string } = {}): RequestHandler {
  return (req, res, next) => {
    if (variants.size === 0 || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
    let path: string;
    try {
      path = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    if (path.endsWith('/') && options.index) path += options.index;
    const available = variants.get(path);
    if (!available) return next();
    res.vary('Accept-Encoding');
    const coding = negotiate(req, available);
    if (coding === null) return next();
    res.type(extname(path));
    res.setHeader('Content-Encoding', coding);
    const query = req.url.indexOf('?');
    req.url = `${path.split('/').map(encodeURIComponent).join('/')}.${coding === 'br' ? 'br' : 'gz'}${query >= 0 ? req.url.slice(query) : ''}`;
    next();
  };
}

/** The file name to send for `file` under this request's Accept-Encoding, with the headers set; for a route that answers with res.sendFile. */
export function precompressedFile(req: Request, res: Response, file: string, available: Variants | undefined): string {
  if (!available) return file;
  res.vary('Accept-Encoding');
  const coding = negotiate(req, available);
  if (coding === null) return file;
  res.type(extname(file));
  res.setHeader('Content-Encoding', coding);
  return `${file}.${coding === 'br' ? 'br' : 'gz'}`;
}
