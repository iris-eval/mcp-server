// Citation source resolver — fetches URLs and DOIs so the verifier can
// feed them to the LLM judge. This is the security-sensitive piece: we
// are fetching URLs that appeared in model-generated output, which is
// effectively user-controlled input.
//
// Defense layers (in order):
//   1. Scheme allowlist — http/https only; refuse file:/javascript:/etc.
//   2. SSRF host check — refuse localhost, link-local, private ranges,
//      and cloud metadata (AWS/GCP/Azure/DigitalOcean) IP literals.
//   3. DNS pre-resolve — every public hostname is resolved via
//      dns.lookup({all:true}) and EVERY returned IP is re-checked against
//      the IP blocklist. Defeats DNS-rebinding via public records pointing
//      at private space (e.g. `*.localtest.me` resolving to 127.0.0.1).
//      Residual TOCTOU window between this lookup and the socket connect
//      is acknowledged — closing it requires a custom undici dispatcher;
//      queued for follow-up if exploitation is observed.
//   4. Optional domain allowlist — IRIS_CITATION_DOMAINS=doi.org,arxiv.org
//      restricts to a curated set; empty/unset = open web (still SSRF-guarded).
//   5. Timeout + size cap — 10s default, 5MB cap on response body.
//   6. Redirect chase cap — follow max 3 redirects, each re-checked.
//   7. Cache — in-process LRU (100 entries) so retries don't re-fetch.
//
// This is opt-in: calls require passing {allowFetch: true} so an agent
// can't trick Iris into fetching random URLs without operator consent
// (consent granted via tool param or env IRIS_CITATION_ALLOW_FETCH=1).
import { lookup as dnsLookupCb } from 'node:dns';
import { promisify } from 'node:util';

const dnsLookupAll = promisify(dnsLookupCb) as (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export interface ResolveOptions {
  allowFetch: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  domainAllowlist?: readonly string[];
  maxRedirects?: number;
}

export interface ResolvedSource {
  url: string;             // final URL after redirects
  requestedUrl: string;    // URL as passed in
  status: number;
  contentType: string;
  text: string;            // truncated to maxBytes
  truncated: boolean;
  fetchedAt: string;       // ISO
  bytesFetched: number;
  fromCache: boolean;
}

export class CitationResolveError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | 'bad_scheme'
      | 'ssrf'
      | 'not_allowed_domain'
      | 'timeout'
      | 'too_large'
      | 'bad_status'
      | 'redirect_loop'
      | 'not_text'
      | 'fetch_disabled',
    public readonly details?: string,
  ) {
    super(message);
    this.name = 'CitationResolveError';
  }
}

// Private IP ranges + localhost + link-local + cloud metadata.
const BLOCKED_IPV4 = [
  // Localhost
  /^127\./,
  // Link-local
  /^169\.254\./,
  // Private RFC 1918
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  // Cloud metadata
  /^169\.254\.169\.254$/,
  // Broadcast
  /^255\.255\.255\.255$/,
  // This-network
  /^0\./,
];

const BLOCKED_IPV6 = [
  /^::1$/, // localhost
  /^fc|^fd/i, // unique local
  /^fe80/i, // link-local
  /^::ffff:127\./i, // IPv4-mapped localhost
];

const BLOCKED_HOST_SUBSTRINGS = ['localhost', 'internal', '.local', 'metadata.google', 'metadata.azure'];

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isIpv6(host: string): boolean {
  return host.includes(':');
}

export function isSafeHost(host: string): boolean {
  const hostLower = host.toLowerCase();
  for (const sub of BLOCKED_HOST_SUBSTRINGS) {
    if (hostLower === sub || hostLower.endsWith(sub)) return false;
  }
  if (isIpv4(host)) {
    for (const re of BLOCKED_IPV4) {
      if (re.test(host)) return false;
    }
  }
  if (isIpv6(host)) {
    for (const re of BLOCKED_IPV6) {
      if (re.test(host)) return false;
    }
  }
  return true;
}

// Resolve `host` via DNS and verify EVERY returned address against the
// IP blocklists. Refuses on any private/link-local/loopback resolution,
// closing the DNS-rebinding bypass where a public hostname (e.g.
// `*.localtest.me`) resolves to 127.0.0.1.
//
// Override hook for tests: `__setDnsLookupForTests` swaps the resolver.
type DnsLookupAll = (host: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
let dnsLookupImpl: DnsLookupAll = (host) => dnsLookupAll(host, { all: true });

export function __setDnsLookupForTests(impl: DnsLookupAll | null): void {
  dnsLookupImpl = impl ?? ((host) => dnsLookupAll(host, { all: true }));
}

export async function resolveAndCheckHost(host: string): Promise<void> {
  if (!isSafeHost(host)) {
    throw new CitationResolveError(`Refusing SSRF-blocked host: ${host}`, 'ssrf', host);
  }
  // IP literals already passed isSafeHost — skip DNS (would just re-resolve to self).
  if (isIpv4(host) || isIpv6(host)) return;

  let addresses: Array<{ address: string; family: 4 | 6 }>;
  try {
    addresses = await dnsLookupImpl(host);
  } catch (err) {
    throw new CitationResolveError(
      `DNS resolution failed for ${host}: ${err instanceof Error ? err.message : String(err)}`,
      'ssrf',
      host,
    );
  }
  if (addresses.length === 0) {
    throw new CitationResolveError(`DNS returned no addresses for ${host}`, 'ssrf', host);
  }
  for (const { address } of addresses) {
    if (!isSafeHost(address)) {
      throw new CitationResolveError(
        `Refusing SSRF-blocked address ${address} (resolved from ${host})`,
        'ssrf',
        host,
      );
    }
  }
}

function matchesAllowlist(host: string, allowlist: readonly string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const hostLower = host.toLowerCase();
  for (const allowed of allowlist) {
    const a = allowed.toLowerCase();
    if (hostLower === a || hostLower.endsWith('.' + a)) return true;
  }
  return false;
}

// Tiny LRU — short-circuits duplicate fetches in a single batch of
// citations (e.g. 5 citations in one output all pointing to the same
// source). Not durable; every process start is fresh.
const CACHE_MAX = 100;
const cache = new Map<string, ResolvedSource>();

function cacheGet(key: string): ResolvedSource | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  // Re-insert to bump LRU order
  cache.delete(key);
  cache.set(key, hit);
  return { ...hit, fromCache: true };
}

function cacheSet(key: string, value: ResolvedSource): void {
  if (cache.size >= CACHE_MAX) {
    const firstKey = cache.keys().next().value as string | undefined;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, value);
}

export function __clearCitationCacheForTests(): void {
  cache.clear();
}

function normalizeDoiToUrl(doiOrUrl: string): string {
  const trimmed = doiOrUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^10\.\d{4,9}\//.test(trimmed)) return `https://doi.org/${trimmed}`;
  return trimmed;
}

async function doFetch(url: string, opts: ResolveOptions, redirectsLeft: number): Promise<ResolvedSource> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;

  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new CitationResolveError(
      `Refusing non-http(s) scheme: ${parsed.protocol}`,
      'bad_scheme',
      parsed.protocol,
    );
  }
  await resolveAndCheckHost(parsed.hostname);
  if (!matchesAllowlist(parsed.hostname, opts.domainAllowlist)) {
    throw new CitationResolveError(
      `Host ${parsed.hostname} not in IRIS_CITATION_DOMAINS allowlist`,
      'not_allowed_domain',
      parsed.hostname,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        'user-agent': 'iris-mcp-citation-verifier/0.4 (+https://iris-eval.com)',
        accept: 'text/html, text/plain, application/pdf, application/xhtml+xml, */*;q=0.1',
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new CitationResolveError(`Fetch timed out after ${timeoutMs}ms`, 'timeout');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // Manual redirect chase — we re-check each target against SSRF rules.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc) {
      throw new CitationResolveError(`Redirect with no Location header (${res.status})`, 'bad_status');
    }
    if (redirectsLeft <= 0) {
      throw new CitationResolveError(`Exceeded max redirects (${opts.maxRedirects ?? 3})`, 'redirect_loop');
    }
    const next = new URL(loc, url).toString();
    return doFetch(next, opts, redirectsLeft - 1);
  }

  if (res.status < 200 || res.status >= 300) {
    throw new CitationResolveError(`Bad status ${res.status}`, 'bad_status', String(res.status));
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  // We only extract text. PDFs could be supported later with pdf-parse
  // but that's an opt-in + heavy dep. For now we refuse non-text.
  const textLike =
    contentType.includes('text/') ||
    contentType.includes('xml') ||
    contentType.includes('json') ||
    contentType === '';
  if (!textLike) {
    throw new CitationResolveError(
      `Refusing non-text content-type: ${contentType}`,
      'not_text',
      contentType,
    );
  }

  // Stream with a byte cap so we don't DoS ourselves on a huge body.
  if (!res.body) {
    throw new CitationResolveError('Response had no body stream', 'bad_status');
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      truncated = true;
      chunks.push(value.slice(0, Math.max(0, maxBytes - (total - value.byteLength))));
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }

  // Concat + decode. UTF-8 is good enough for this use case — any weird
  // encoding will surface as mojibake for the LLM judge, still safe.
  const buf = new Uint8Array(total > maxBytes ? maxBytes : total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);

  return {
    url: res.url || url,
    requestedUrl: url,
    status: res.status,
    contentType,
    text,
    truncated,
    fetchedAt: new Date().toISOString(),
    bytesFetched: Math.min(total, maxBytes),
    fromCache: false,
  };
}

export async function resolveSource(
  identifier: string,
  opts: ResolveOptions,
): Promise<ResolvedSource> {
  if (!opts.allowFetch) {
    throw new CitationResolveError(
      'Citation fetch is disabled. Pass allowFetch:true or set IRIS_CITATION_ALLOW_FETCH=1.',
      'fetch_disabled',
    );
  }

  const url = normalizeDoiToUrl(identifier);
  const cacheKey = url;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const fetched = await doFetch(url, opts, opts.maxRedirects ?? 3);
  cacheSet(cacheKey, fetched);
  return fetched;
}
