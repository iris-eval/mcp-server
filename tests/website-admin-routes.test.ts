/*
 * The waitlist size is an operator's number, not page copy. The count route
 * answers only with the admin key, and a missing store is reported as 503
 * instead of read as an empty list, so the release checklist's probe tells the
 * truth. The site itself never fetches or prints the count.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAdmin, timingSafeEqual } from '../website/src/lib/admin-auth.js';
import { GET as countRoute } from '../website/src/app/api/waitlist-count/route.js';

const root = resolve(__dirname, '..');
const saved = { key: process.env.WAITLIST_ADMIN_KEY, url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN };
const req = (auth?: string) => new Request('https://iris-eval.com/api/waitlist-count', { headers: auth ? { authorization: auth } : {} });

afterEach(() => {
  for (const [k, v] of [['WAITLIST_ADMIN_KEY', saved.key], ['KV_REST_API_URL', saved.url], ['KV_REST_API_TOKEN', saved.token]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('admin check', () => {
  it('accepts only the exact bearer key, and reports an unconfigured key as 503', () => {
    expect(checkAdmin(req('Bearer k-123'), undefined)).toEqual({ ok: false, status: 503, error: 'Admin endpoint not configured' });
    expect(checkAdmin(req(), 'k-123')).toMatchObject({ ok: false, status: 401 });
    expect(checkAdmin(req('Bearer k-124'), 'k-123')).toMatchObject({ ok: false, status: 401 });
    expect(checkAdmin(req('k-123'), 'k-123')).toMatchObject({ ok: false, status: 401 });
    expect(checkAdmin(req('Bearer k-123'), 'k-123')).toEqual({ ok: true });
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });
});

describe('the waitlist count route', () => {
  it('refuses a caller without the key', async () => {
    process.env.WAITLIST_ADMIN_KEY = 'k-123';
    const res = await countRoute(req());
    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty('count');
  });

  it('reports a missing store as 503 with the key, never as a count of 0', async () => {
    process.env.WAITLIST_ADMIN_KEY = 'k-123';
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    const res = await countRoute(req('Bearer k-123'));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('is not fetched or printed by the site', () => {
    const cloud = readFileSync(join(root, 'website', 'src', 'components', 'cloud.tsx'), 'utf8');
    expect(cloud).not.toContain('waitlist-count');
    expect(cloud).not.toMatch(/on the waitlist/);
  });
});
