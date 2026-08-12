// Citation source resolver — fetches URLs and DOIs so the verifier can
// feed them to the LLM judge. This is the security-sensitive piece: we
// are fetching URLs that appeared in model-generated output, which is
// effectively user-controlled input.
//
// Defense layers (in order):
//   1. Scheme allowlist — http/https only; refuse file:/javascript:/etc.
//   2. SSRF host check — refuse localhost, link-local, private ranges,
//      and cloud metadata (AWS/GCP/Azure/DigitalOcean) IP literals. IPv6
//      literals are de-bracketed and canonicalized (incl. IPv4-mapped
//      forms) before classification so `[::1]`, `[fd00::1]`, and
//      `[::ffff:169.254.169.254]` cannot slip past the ^-anchored checks.
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
  // Carrier-grade NAT (RFC 6598). Routable inside an ISP or a corporate
  // overlay — Tailscale hands out 100.64/10 addresses, so this range reaches
  // real internal hosts on a very common setup.
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  // IETF protocol assignments (RFC 6890) incl. 192.0.0.0/24
  /^192\.0\.0\./,
  // Benchmarking (RFC 2544) — routed to internal test networks in practice
  /^198\.(1[89])\./,
  // Multicast and reserved/future space
  /^(22[4-9]|23\d)\./,
  /^(24\d|25[0-5])\./,
];

const BLOCKED_HOST_SUBSTRINGS = ['localhost', 'internal', '.local', 'metadata.google', 'metadata.azure'];

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isIpv6(host: string): boolean {
  return host.includes(':');
}

// WHATWG URL parsing leaves IPv6 literals bracketed:
// `new URL('http://[::1]/').hostname === '[::1]'`. Every historical
// BLOCKED_IPV6 entry was `^`-anchored (`/^::1$/`, `/^fe80/`, …), so the
// leading `[` made ALL of them silently fail to match — the entire IPv6
// SSRF guard was inert for direct address literals (loopback, link-local,
// unique-local, and IPv4-mapped metadata all passed as "safe"). Strip the
// brackets before any IPv6 classification.
function stripIpv6Brackets(host: string): string {
  return host.length > 1 && host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1)
    : host;
}

// Expand a compressed / embedded-IPv4 IPv6 literal to exactly 8 zero-padded
// hextets. Returns null when `addr` is not a syntactically valid IPv6 literal.
// Canonicalizing to full form makes prefix classification reliable regardless
// of how the address was serialized (`::1`, `0:0:...:1`, `::ffff:a9fe:a9fe`).
function expandIpv6(addr: string): string[] | null {
  let a = addr.toLowerCase();
  const zone = a.indexOf('%');
  if (zone !== -1) a = a.slice(0, zone); // drop scope/zone id
  // Fold a trailing embedded IPv4 (`::ffff:1.2.3.4`, `::1.2.3.4`) into two hextets.
  const v4 = a.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = [v4[2], v4[3], v4[4], v4[5]].map(Number);
    if (octets.some((n) => n > 255)) return null;
    const hi = octets[0] * 256 + octets[1];
    const lo = octets[2] * 256 + octets[3];
    a = `${v4[1]}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out: string[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(g.padStart(4, '0'));
  }
  return out;
}

function ipv4FromHextets(h6: string, h7: string): string {
  const hi = parseInt(h6, 16);
  const lo = parseInt(h7, 16);
  return `${Math.floor(hi / 256)}.${hi % 256}.${Math.floor(lo / 256)}.${lo % 256}`;
}

// True when an IPv6 literal resolves to a range we refuse: unspecified,
// loopback, link-local, unique-local, or an embedded IPv4 that itself hits
// the IPv4 blocklist (IPv4-mapped `::ffff:a.b.c.d` reaches the v4 endpoint on
// dual-stack hosts — e.g. `::ffff:169.254.169.254` == AWS IMDS). Fails closed
// on any colon-bearing host that does not parse as valid IPv6.
function isBlockedIpv6(addr: string): boolean {
  const g = expandIpv6(addr);
  if (!g) return true; // unparseable but IPv6-shaped (has a colon) — refuse
  if (g.every((h) => h === '0000')) return true; // ::   unspecified
  if (g.slice(0, 7).every((h) => h === '0000') && g[7] === '0001') return true; // ::1 loopback
  const first = g[0];
  // fe80::/10 link-local (fe80–febf)
  if (first === 'fe80' || /^fe[89ab]/.test(first)) return true;
  // fc00::/7 unique-local (fc.. / fd..)
  if (first.startsWith('fc') || first.startsWith('fd')) return true;
  /*
   * Transition mechanisms tunnel an IPv4 destination inside an IPv6 literal,
   * so the v4 blocklist has to be applied to the embedded address or the
   * whole v4 ruleset is bypassable by re-encoding the target.
   *
   * 6to4 (2002::/16, RFC 3056): the destination v4 is hextets 1-2, plain.
   * Teredo (2001:0000::/32, RFC 4380): the client v4 is hextets 6-7, stored
   * one's-complemented, so it must be un-obfuscated before classification.
   */
  if (first === '2002') {
    return BLOCKED_IPV4.some((re) => re.test(ipv4FromHextets(g[1], g[2])));
  }
  if (first === '2001' && g[1] === '0000') {
    const deobfuscate = (h: string): string =>
      (parseInt(h, 16) ^ 0xffff).toString(16).padStart(4, '0');
    const client = ipv4FromHextets(deobfuscate(g[6]), deobfuscate(g[7]));
    const server = ipv4FromHextets(g[2], g[3]);
    return BLOCKED_IPV4.some((re) => re.test(client) || re.test(server));
  }
  // IPv4-mapped ::ffff:a.b.c.d  and  IPv4-compatible ::a.b.c.d (deprecated)
  const mapped = g.slice(0, 5).every((h) => h === '0000') && g[5] === 'ffff';
  const compat = g.slice(0, 6).every((h) => h === '0000') && !(g[6] === '0000' && g[7] === '0000');
  if (mapped || compat) {
    const embedded = ipv4FromHextets(g[6], g[7]);
    return BLOCKED_IPV4.some((re) => re.test(embedded));
  }
  return false;
}

export function isSafeHost(host: string): boolean {
  const bare = stripIpv6Brackets(host);
  const hostLower = bare.toLowerCase();
  for (const sub of BLOCKED_HOST_SUBSTRINGS) {
    if (hostLower === sub || hostLower.endsWith(sub)) return false;
  }
  if (isIpv4(bare)) {
    for (const re of BLOCKED_IPV4) {
      if (re.test(bare)) return false;
    }
  }
  if (isIpv6(bare)) {
    if (isBlockedIpv6(bare)) return false;
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
