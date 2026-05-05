import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveSource,
  resolveAndCheckHost,
  isSafeHost,
  CitationResolveError,
  __clearCitationCacheForTests,
  __setDnsLookupForTests,
} from '../../../../src/eval/citation-verify/resolve.js';

const originalFetch = global.fetch;

// Default permissive DNS mock so the resolveSource tests below don't hit
// real DNS for `example.com` / `doi.org` / etc. via the new pre-resolve
// guard. Tests that need DNS-rebinding behavior override per-case.
beforeEach(() => {
  __setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
});

afterEach(() => {
  global.fetch = originalFetch;
  __clearCitationCacheForTests();
  __setDnsLookupForTests(null);
});

function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...init,
  });
}

describe('isSafeHost (SSRF guard)', () => {
  it('blocks localhost variants', () => {
    expect(isSafeHost('localhost')).toBe(false);
    expect(isSafeHost('LOCALHOST')).toBe(false);
    expect(isSafeHost('127.0.0.1')).toBe(false);
    expect(isSafeHost('127.5.5.5')).toBe(false);
    expect(isSafeHost('::1')).toBe(false);
  });

  it('blocks private RFC 1918 ranges', () => {
    expect(isSafeHost('10.0.0.1')).toBe(false);
    expect(isSafeHost('192.168.1.1')).toBe(false);
    expect(isSafeHost('172.16.0.1')).toBe(false);
    expect(isSafeHost('172.31.255.255')).toBe(false);
  });

  it('blocks link-local 169.254.x.x (AWS IMDS)', () => {
    expect(isSafeHost('169.254.169.254')).toBe(false);
    expect(isSafeHost('169.254.1.1')).toBe(false);
  });

  it('blocks .local and .internal', () => {
    expect(isSafeHost('foo.local')).toBe(false);
    expect(isSafeHost('service.internal')).toBe(false);
  });

  it('blocks cloud metadata hostnames', () => {
    expect(isSafeHost('metadata.google.internal')).toBe(false);
  });

  it('allows public-looking hosts', () => {
    expect(isSafeHost('example.com')).toBe(true);
    expect(isSafeHost('doi.org')).toBe(true);
    expect(isSafeHost('arxiv.org')).toBe(true);
    // IPv4 public ranges
    expect(isSafeHost('8.8.8.8')).toBe(true);
    expect(isSafeHost('104.20.1.1')).toBe(true);
  });

  it('allows 172.15.x (just outside RFC 1918)', () => {
    expect(isSafeHost('172.15.0.1')).toBe(true);
    expect(isSafeHost('172.32.0.1')).toBe(true);
  });
});

describe('resolveAndCheckHost (DNS rebinding guard)', () => {
  it('passes when DNS returns only public IPs', async () => {
    __setDnsLookupForTests(async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ]);
    await expect(resolveAndCheckHost('example.com')).resolves.toBeUndefined();
  });

  it('rejects when DNS resolves to loopback (classic rebinding via *.localtest.me)', async () => {
    __setDnsLookupForTests(async () => [{ address: '127.0.0.1', family: 4 }]);
    await expect(resolveAndCheckHost('attacker.localtest.me')).rejects.toMatchObject({
      kind: 'ssrf',
    });
  });

  it('rejects when ANY of multiple resolved IPs is private (mixed-record bypass)', async () => {
    __setDnsLookupForTests(async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(resolveAndCheckHost('attacker.example.com')).rejects.toMatchObject({
      kind: 'ssrf',
    });
  });

  it('rejects when DNS returns no addresses', async () => {
    __setDnsLookupForTests(async () => []);
    await expect(resolveAndCheckHost('void.example.com')).rejects.toMatchObject({
      kind: 'ssrf',
    });
  });

  it('rejects when DNS lookup throws (resolution failure)', async () => {
    __setDnsLookupForTests(async () => {
      throw new Error('ENOTFOUND');
    });
    await expect(resolveAndCheckHost('nxdomain.example.com')).rejects.toMatchObject({
      kind: 'ssrf',
    });
  });

  it('rejects loopback IPv6 from DNS', async () => {
    __setDnsLookupForTests(async () => [{ address: '::1', family: 6 }]);
    await expect(resolveAndCheckHost('attacker.example.com')).rejects.toMatchObject({
      kind: 'ssrf',
    });
  });

  it('skips DNS for IP literals already validated by isSafeHost', async () => {
    let lookups = 0;
    __setDnsLookupForTests(async () => {
      lookups++;
      return [{ address: '127.0.0.1', family: 4 }];
    });
    await expect(resolveAndCheckHost('8.8.8.8')).resolves.toBeUndefined();
    expect(lookups).toBe(0);
  });

  it('rejects bad hostname before DNS call', async () => {
    let lookups = 0;
    __setDnsLookupForTests(async () => {
      lookups++;
      return [{ address: '8.8.8.8', family: 4 }];
    });
    await expect(resolveAndCheckHost('localhost')).rejects.toMatchObject({ kind: 'ssrf' });
    expect(lookups).toBe(0);
  });
});

describe('resolveSource', () => {
  it('refuses to fetch when allowFetch=false', async () => {
    global.fetch = vi.fn(async () => new Response()) as typeof fetch;
    await expect(
      resolveSource('https://example.com', { allowFetch: false }),
    ).rejects.toMatchObject({ kind: 'fetch_disabled' });
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('refuses file:// scheme', async () => {
    global.fetch = vi.fn(async () => textResponse('x')) as typeof fetch;
    await expect(
      resolveSource('file:///etc/passwd', { allowFetch: true }),
    ).rejects.toMatchObject({ kind: 'bad_scheme' });
  });

  it('refuses localhost SSRF target', async () => {
    global.fetch = vi.fn(async () => textResponse('x')) as typeof fetch;
    await expect(
      resolveSource('http://localhost:8080/secret', { allowFetch: true }),
    ).rejects.toMatchObject({ kind: 'ssrf' });
  });

  it('refuses AWS IMDS target', async () => {
    global.fetch = vi.fn(async () => textResponse('x')) as typeof fetch;
    await expect(
      resolveSource('http://169.254.169.254/latest/meta-data', { allowFetch: true }),
    ).rejects.toMatchObject({ kind: 'ssrf' });
  });

  it('refuses fetch when public hostname DNS-rebinds to a private IP', async () => {
    // Simulates the *.localtest.me / DNS-rebinding pattern where a
    // public hostname resolves to 127.0.0.1. Without the DNS pre-resolve,
    // isSafeHost(hostname) would pass (the name isn't in the substring
    // blocklist) and fetch would happily connect to localhost.
    let fetchCalls = 0;
    global.fetch = vi.fn(async () => {
      fetchCalls++;
      return textResponse('would-be-leaked-secret');
    }) as typeof fetch;
    __setDnsLookupForTests(async () => [{ address: '127.0.0.1', family: 4 }]);

    await expect(
      resolveSource('https://attacker.example.com/probe', { allowFetch: true }),
    ).rejects.toMatchObject({ kind: 'ssrf' });
    expect(fetchCalls).toBe(0);
  });

  it('refuses domain outside allowlist', async () => {
    global.fetch = vi.fn(async () => textResponse('x')) as typeof fetch;
    await expect(
      resolveSource('https://not-allowed.com/x', {
        allowFetch: true,
        domainAllowlist: ['doi.org', 'arxiv.org'],
      }),
    ).rejects.toMatchObject({ kind: 'not_allowed_domain' });
  });

  it('allows domain when on allowlist (suffix match)', async () => {
    global.fetch = vi.fn(async () => textResponse('doi content')) as typeof fetch;
    const res = await resolveSource('https://papers.doi.org/10.1/x', {
      allowFetch: true,
      domainAllowlist: ['doi.org'],
    });
    expect(res.text).toBe('doi content');
  });

  it('reads body + records status + content type', async () => {
    global.fetch = vi.fn(async () =>
      new Response('Hello world', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    ) as typeof fetch;

    const res = await resolveSource('https://example.com/x', { allowFetch: true });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/plain');
    expect(res.text).toBe('Hello world');
    expect(res.bytesFetched).toBe(11);
    expect(res.truncated).toBe(false);
    expect(res.fromCache).toBe(false);
  });

  it('truncates body beyond maxBytes', async () => {
    const body = 'A'.repeat(10_000);
    global.fetch = vi.fn(async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }),
    ) as typeof fetch;

    const res = await resolveSource('https://example.com/big', {
      allowFetch: true,
      maxBytes: 100,
    });
    expect(res.truncated).toBe(true);
    expect(res.text.length).toBeLessThanOrEqual(100);
  });

  it('throws bad_status on 4xx + 5xx', async () => {
    global.fetch = vi.fn(async () => new Response('not found', { status: 404 })) as typeof fetch;
    await expect(
      resolveSource('https://example.com/gone', { allowFetch: true }),
    ).rejects.toMatchObject({ kind: 'bad_status' });
  });

  it('refuses non-text content-types', async () => {
    global.fetch = vi.fn(async () =>
      new Response('binary', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    ) as typeof fetch;
    await expect(
      resolveSource('https://example.com/binary', { allowFetch: true }),
    ).rejects.toMatchObject({ kind: 'not_text' });
  });

  it('caches repeat fetches in one session', async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls++;
      return textResponse('cached content');
    }) as typeof fetch;

    const first = await resolveSource('https://example.com/a', { allowFetch: true });
    const second = await resolveSource('https://example.com/a', { allowFetch: true });

    expect(calls).toBe(1);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.text).toBe(first.text);
  });

  it('normalizes a bare DOI to doi.org URL', async () => {
    let requestedUrl = '';
    global.fetch = vi.fn(async (url: string) => {
      requestedUrl = url;
      return textResponse('paper content');
    }) as typeof fetch;

    const res = await resolveSource('10.1234/foo.bar', { allowFetch: true });
    expect(requestedUrl).toBe('https://doi.org/10.1234/foo.bar');
    expect(res.status).toBe(200);
  });

  it('follows redirects with SSRF re-check each hop', async () => {
    const targets: string[] = [];
    global.fetch = vi.fn(async (url: string) => {
      targets.push(url);
      if (targets.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://final.example.com/dest' },
        });
      }
      return textResponse('redirected content');
    }) as typeof fetch;

    const res = await resolveSource('https://start.example.com/begin', { allowFetch: true });
    expect(targets).toEqual([
      'https://start.example.com/begin',
      'https://final.example.com/dest',
    ]);
    expect(res.text).toBe('redirected content');
  });

  it('refuses redirects into SSRF-blocked hosts', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes('start')) {
        return new Response(null, {
          status: 301,
          headers: { location: 'http://localhost:3000/secret' },
        });
      }
      return textResponse('x');
    }) as typeof fetch;

    await expect(
      resolveSource('https://start.example.com/x', { allowFetch: true }),
    ).rejects.toMatchObject({ kind: 'ssrf' });
  });

  it('caps redirect chains', async () => {
    global.fetch = vi.fn(async (url: string) =>
      new Response(null, {
        status: 302,
        headers: { location: url + '/next' },
      }),
    ) as typeof fetch;

    await expect(
      resolveSource('https://example.com/loop', { allowFetch: true, maxRedirects: 2 }),
    ).rejects.toMatchObject({ kind: 'redirect_loop' });
  });
});

describe('CitationResolveError', () => {
  it('is instanceof Error', () => {
    const e = new CitationResolveError('msg', 'ssrf', '127.0.0.1');
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe('ssrf');
    expect(e.details).toBe('127.0.0.1');
  });
});
