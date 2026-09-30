/*
 * Compressed dashboard responses (src/dashboard/compression.ts).
 *
 * Every request here is made with node:http, not fetch, because fetch
 * decompresses behind the test's back: these tests must see the bytes on
 * the wire, the headers that describe them, and then decode them by hand
 * to show they are the same content.
 *
 *   - Static files: the build's .br / .gz variant is served to a client that
 *     accepts it, with the original's type and a Vary header; a client that
 *     refuses it (q=0), or accepts nothing, gets the original; a variant
 *     older than its file, a dot-file, and a file with no variant are left
 *     to express.static; ranges and HEAD still work; the SPA fallback sends
 *     the variant too.
 *   - JSON: compressed at 1 KB and above, brotli preferred; not below it;
 *     never for a cross-site browser request (the BREACH guard), a
 *     no-transform response, one already encoded, text/event-stream or
 *     anything streamed with res.write; ETag revalidation still answers 304.
 *   - The real dashboard server compresses its own API responses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { compressJsonResponses, COMPRESS_MIN_BYTES, findPrecompressed, precompressedFile, servePrecompressed } from '../../../src/dashboard/compression.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../../src/dashboard/server.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { createLogger } from '../../../src/utils/logger.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { createApiRateLimiter } from '../../../src/middleware/rate-limit.js';

interface Raw {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function get(base: string, path: string, headers: Record<string, string> = {}, method = 'GET', body?: string): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

const decode = (r: Raw): Buffer =>
  r.headers['content-encoding'] === 'br' ? brotliDecompressSync(r.body) : r.headers['content-encoding'] === 'gzip' ? gunzipSync(r.body) : r.body;

const opened: Server[] = [];
async function listen(app: express.Application): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  opened.push(server);
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

afterAll(async () => {
  for (const s of opened.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

// ---- Static files ----

describe('precompressed static files', () => {
  let dir: string;
  let base: string;
  const js = Buffer.from(`export const words = ${JSON.stringify(Array.from({ length: 400 }, (_, i) => `word${i % 37}`))};\n`);
  const html = Buffer.from(`<!doctype html><html><head><title>t</title></head><body>${'<p>dashboard</p>'.repeat(200)}</body></html>`);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iris-compress-'));
    mkdirSync(join(dir, 'assets'));
    mkdirSync(join(dir, '.vite'));
    const write = (rel: string, bytes: Buffer, variants: boolean): void => {
      writeFileSync(join(dir, rel), bytes);
      if (variants) {
        writeFileSync(join(dir, `${rel}.br`), brotliCompressSync(bytes));
        writeFileSync(join(dir, `${rel}.gz`), gzipSync(bytes));
      }
    };
    write('assets/app-abc.js', js, true);
    write('assets/plain-abc.js', js, false);
    write('index.html', html, true);
    write('.vite/manifest.json', Buffer.from(JSON.stringify({ x: 'y'.repeat(2000) })), true);
    // A variant left by an older build: the file it was made from is newer.
    write('assets/stale.js', js, true);
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'assets/stale.js.br'), past, past);
    utimesSync(join(dir, 'assets/stale.js.gz'), past, past);

    // Mounted as src/dashboard/server.ts mounts it.
    const app = express();
    const variants = findPrecompressed(dir);
    app.use(createApiRateLimiter(defaultConfig));
    app.use(servePrecompressed(variants, { index: 'index.html' }));
    app.use('/assets', express.static(join(dir, 'assets'), { immutable: true, maxAge: '365d', fallthrough: false }));
    app.use(express.static(dir));
    app.get('/{*path}', (req, res) => {
      res.sendFile(precompressedFile(req, res, join(dir, 'index.html'), variants.get('/index.html')));
    });
    base = await listen(app);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  it('finds a variant only where it is current and servable', () => {
    const found = findPrecompressed(dir);
    expect([...found.keys()].sort()).toEqual(['/assets/app-abc.js', '/index.html']);
    expect(found.get('/assets/app-abc.js')).toEqual({ br: true, gzip: true });
  });

  it('sends brotli to a client that accepts it, with the original type and the immutable caching', async () => {
    const r = await get(base, '/assets/app-abc.js', { 'accept-encoding': 'gzip, deflate, br, zstd' });
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBe('br');
    expect(r.headers['content-type']).toMatch(/^text\/javascript|^application\/javascript/);
    expect(r.headers.vary).toMatch(/Accept-Encoding/i);
    expect(r.headers['cache-control']).toContain('immutable');
    expect(Number(r.headers['content-length'])).toBe(r.body.length);
    expect(r.body.length).toBeLessThan(js.length / 3);
    expect(decode(r).equals(js)).toBe(true);
  });

  it('sends gzip where brotli is not accepted (a browser on plain http to a LAN host advertises gzip only)', async () => {
    const r = await get(base, '/assets/app-abc.js', { 'accept-encoding': 'gzip, deflate' });
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(decode(r).equals(js)).toBe(true);
  });

  it('honours a refusal: br;q=0 gets gzip, and identity-only gets the original bytes', async () => {
    const refused = await get(base, '/assets/app-abc.js', { 'accept-encoding': 'br;q=0, gzip' });
    expect(refused.headers['content-encoding']).toBe('gzip');
    const none = await get(base, '/assets/app-abc.js', { 'accept-encoding': 'identity' });
    expect(none.headers['content-encoding']).toBeUndefined();
    expect(none.headers.vary).toMatch(/Accept-Encoding/i);
    expect(none.body.equals(js)).toBe(true);
    const absent = await get(base, '/assets/app-abc.js');
    expect(absent.headers['content-encoding']).toBeUndefined();
    expect(absent.body.equals(js)).toBe(true);
  });

  it('keeps each representation its own ETag, so a cache never swaps one for the other', async () => {
    const br = await get(base, '/assets/app-abc.js', { 'accept-encoding': 'br' });
    const plain = await get(base, '/assets/app-abc.js', { 'accept-encoding': 'identity' });
    expect(br.headers.etag).toBeTruthy();
    expect(br.headers.etag).not.toBe(plain.headers.etag);
    const again = await get(base, '/assets/app-abc.js', { 'accept-encoding': 'br', 'if-none-match': br.headers.etag as string });
    expect(again.status).toBe(304);
  });

  it('answers HEAD and a range on the encoded bytes', async () => {
    const head = await get(base, '/assets/app-abc.js', { 'accept-encoding': 'br' }, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['content-encoding']).toBe('br');
    expect(head.body.length).toBe(0);
    const full = await get(base, '/assets/app-abc.js', { 'accept-encoding': 'br' });
    const part = await get(base, '/assets/app-abc.js', { 'accept-encoding': 'br', range: 'bytes=0-9' });
    expect(part.status).toBe(206);
    expect(part.body.equals(full.body.subarray(0, 10))).toBe(true);
  });

  it('leaves files without a current variant to express.static, uncompressed', async () => {
    for (const path of ['/assets/plain-abc.js', '/assets/stale.js']) {
      const r = await get(base, path, { 'accept-encoding': 'br, gzip' });
      expect(r.status, path).toBe(200);
      expect(r.headers['content-encoding'], path).toBeUndefined();
      expect(r.body.equals(js), path).toBe(true);
    }
  });

  it('serves the compressed index for the root and for a deep link the SPA fallback answers', async () => {
    for (const path of ['/', '/index.html', '/traces/abc-123']) {
      const r = await get(base, path, { 'accept-encoding': 'br' });
      expect(r.status, path).toBe(200);
      expect(r.headers['content-encoding'], path).toBe('br');
      expect(r.headers['content-type'], path).toMatch(/^text\/html/);
      expect(decode(r).equals(html), path).toBe(true);
    }
  });

  it('a missing asset is still a 404, never the app', async () => {
    const r = await get(base, '/assets/missing-abc.js', { 'accept-encoding': 'br' });
    expect(r.status).toBe(404);
    expect(r.headers['content-encoding']).toBeUndefined();
  });
});

// ---- JSON ----

describe('compressed JSON responses', () => {
  let base: string;
  const big = { rows: Array.from({ length: 200 }, (_, i) => ({ id: `trace-${i}`, agent: 'support-bot', output: 'The order has shipped.' })) };
  const small = { ok: true };

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(compressJsonResponses());
    app.get('/big', (_req, res) => res.json(big));
    // The same body as the answer to each kind of write.
    for (const method of ['post', 'put', 'patch', 'delete'] as const) app[method]('/big', (_req, res) => res.status(method === 'post' ? 201 : 200).json(big));
    app.get('/small', (_req, res) => res.json(small));
    app.get('/no-transform', (_req, res) => res.set('Cache-Control', 'no-transform').json(big));
    app.get('/encoded', (_req, res) => {
      const bytes = gzipSync(Buffer.from(JSON.stringify(big)));
      res.set('Content-Encoding', 'gzip').type('json').send(bytes);
    });
    app.get('/text', (_req, res) => res.type('text').send('x'.repeat(5000)));
    app.get('/events', (_req, res) => {
      res.set('Content-Type', 'text/event-stream');
      res.write(`data: ${'x'.repeat(2000)}\n\n`);
      res.end();
    });
    app.get('/stream', (_req, res) => {
      res.type('application/x-ndjson');
      for (const row of big.rows) res.write(`${JSON.stringify(row)}\n`);
      res.end();
    });
    app.get('/stream-json', (_req, res) => {
      res.type('json');
      res.write(JSON.stringify(big));
      res.end();
    });
    app.get('/missing', (_req, res) => res.status(404).json({ error: 'x'.repeat(2000) }));
    base = await listen(app);
  });

  it('compresses a body of 1 KB or more with brotli when accepted, and it decodes to the same JSON', async () => {
    const plain = Buffer.from(JSON.stringify(big));
    expect(plain.length).toBeGreaterThan(COMPRESS_MIN_BYTES);
    const r = await get(base, '/big', { 'accept-encoding': 'gzip, deflate, br' });
    expect(r.headers['content-encoding']).toBe('br');
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect(r.headers.vary).toMatch(/Accept-Encoding/i);
    expect(r.headers.vary).toMatch(/Sec-Fetch-Site/i);
    expect(Number(r.headers['content-length'])).toBe(r.body.length);
    expect(r.body.length).toBeLessThan(plain.length / 5);
    expect(JSON.parse(decode(r).toString('utf8'))).toEqual(big);
  });

  it('uses gzip when that is all the client takes, and nothing when it takes neither', async () => {
    const gz = await get(base, '/big', { 'accept-encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(decode(gz).toString('utf8'))).toEqual(big);
    const none = await get(base, '/big');
    expect(none.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(none.body.toString('utf8'))).toEqual(big);
  });

  it('compresses an error body the same way', async () => {
    const r = await get(base, '/missing', { 'accept-encoding': 'br' });
    expect(r.status).toBe(404);
    expect(r.headers['content-encoding']).toBe('br');
  });

  it('compresses the answer to a read only: a write gets its acknowledgement as it is, with no Vary', async () => {
    const head = await get(base, '/big', { 'accept-encoding': 'br' }, 'HEAD');
    expect(head.headers['content-encoding']).toBe('br');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      // A DELETE carries no body, as the dashboard's own deletes do.
      const r = await get(base, '/big', { 'accept-encoding': 'br, gzip' }, method, method === 'DELETE' ? undefined : '{}');
      expect(r.status, method).toBe(method === 'POST' ? 201 : 200);
      expect(r.headers['content-encoding'], method).toBeUndefined();
      expect(r.headers.vary ?? '', method).not.toMatch(/Accept-Encoding/i);
      expect(JSON.parse(r.body.toString('utf8')), method).toEqual(big);
    }
  });

  it('leaves a small body alone', async () => {
    const r = await get(base, '/small', { 'accept-encoding': 'br, gzip' });
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(r.body.toString('utf8'))).toEqual(small);
  });

  it('never compresses for a browser request from another site, the BREACH precondition', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const r = await get(base, '/big', { 'accept-encoding': 'br, gzip', 'sec-fetch-site': site });
      expect(r.headers['content-encoding'], site).toBeUndefined();
      expect(r.headers.vary, site).toMatch(/Sec-Fetch-Site/i);
    }
    for (const site of ['same-origin', 'none']) {
      const r = await get(base, '/big', { 'accept-encoding': 'br', 'sec-fetch-site': site });
      expect(r.headers['content-encoding'], site).toBe('br');
    }
  });

  it('respects no-transform and an encoding the route already chose', async () => {
    const nt = await get(base, '/no-transform', { 'accept-encoding': 'br' });
    expect(nt.headers['content-encoding']).toBeUndefined();
    const enc = await get(base, '/encoded', { 'accept-encoding': 'br' });
    expect(enc.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(enc.body).toString('utf8'))).toEqual(big);
  });

  it('passes streamed and non-JSON responses through byte for byte', async () => {
    const events = await get(base, '/events', { 'accept-encoding': 'br, gzip' });
    expect(events.headers['content-encoding']).toBeUndefined();
    expect(events.body.toString('utf8')).toBe(`data: ${'x'.repeat(2000)}\n\n`);
    const stream = await get(base, '/stream', { 'accept-encoding': 'br, gzip' });
    expect(stream.headers['content-encoding']).toBeUndefined();
    expect(stream.body.toString('utf8').trim().split('\n')).toHaveLength(big.rows.length);
    const streamJson = await get(base, '/stream-json', { 'accept-encoding': 'br, gzip' });
    expect(streamJson.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(streamJson.body.toString('utf8'))).toEqual(big);
    const text = await get(base, '/text', { 'accept-encoding': 'br, gzip' });
    expect(text.headers['content-encoding']).toBeUndefined();
  });

  it('revalidates: the ETag of the compressed body answers 304', async () => {
    const first = await get(base, '/big', { 'accept-encoding': 'br' });
    expect(first.headers.etag).toBeTruthy();
    const again = await get(base, '/big', { 'accept-encoding': 'br', 'if-none-match': first.headers.etag as string });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
  });
});

// ---- The real server ----

describe('the dashboard server', () => {
  let storage: SqliteAdapter;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const config = structuredClone(defaultConfig);
    config.dashboard.port = 0;
    config.dashboard.host = '127.0.0.1';
    config.logging.level = 'error';
    const evalEngine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds, config.eval);
    server = createDashboardServer(storage, config, createLogger(config), { evalEngine }).start();
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage.close();
  });

  it('compresses its API responses, and they decode to what an uncompressed client gets', async () => {
    const plain = await get(base, '/api/v1/capabilities');
    expect(plain.status).toBe(200);
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.length).toBeGreaterThan(COMPRESS_MIN_BYTES);
    const br = await get(base, '/api/v1/capabilities', { 'accept-encoding': 'br' });
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.body.length).toBeLessThan(plain.body.length);
    expect(JSON.parse(decode(br).toString('utf8'))).toEqual(JSON.parse(plain.body.toString('utf8')));
  });

  it('answers an evaluated ingest uncompressed, and compresses the trace when it is read back', async () => {
    const trace = { agent_name: 'bot', input: 'Where is my order?', output: `The order shipped on Monday. ${'It is on its way. '.repeat(40)}`, evaluate: true };
    const posted = await get(base, '/api/v1/traces', { 'accept-encoding': 'br, gzip' }, 'POST', JSON.stringify(trace));
    expect(posted.status).toBe(201);
    // Big enough that a read of this size would be compressed: the method is what decides.
    expect(posted.body.length).toBeGreaterThan(COMPRESS_MIN_BYTES);
    expect(posted.headers['content-encoding']).toBeUndefined();
    const { trace_id } = JSON.parse(posted.body.toString('utf8')) as { trace_id: string };
    const read = await get(base, `/api/v1/traces/${trace_id}`, { 'accept-encoding': 'br, gzip' });
    expect(read.status).toBe(200);
    expect(read.headers['content-encoding']).toBe('br');
    expect((JSON.parse(decode(read).toString('utf8')) as { trace: { trace_id: string } }).trace.trace_id).toBe(trace_id);
  });
});
