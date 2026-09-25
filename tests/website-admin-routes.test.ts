/*
 * The waitlist size is an operator's number, not page copy. The count route
 * answers only with the admin key, and a missing store is reported as 503
 * instead of read as an empty list, so the release checklist's probe tells the
 * truth. The site itself never fetches or prints the count.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAdmin, timingSafeEqual } from '../website/src/lib/admin-auth.js';
import { waitlistCount } from '../website/src/lib/waitlist-count.js';

const root = resolve(__dirname, '..');
const req = (auth?: string) => new Request('https://iris-eval.com/api/waitlist-count', { headers: auth ? { authorization: auth } : {} });

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

describe('the waitlist count answer', () => {
  const env = (over: Partial<{ adminKey: string; storeConfigured: boolean }> = {}) => ({ adminKey: 'k-123', storeConfigured: true, ...over });

  it('refuses a caller without the key, and never reveals the count', async () => {
    let asked = false;
    const res = await waitlistCount(req(), env(), async () => { asked = true; return 7; });
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('count');
    expect(asked).toBe(false);
  });

  it('reports a missing or failing store as 503 with the key, never as a count of 0', async () => {
    expect((await waitlistCount(req('Bearer k-123'), env({ storeConfigured: false }), async () => 0)).status).toBe(503);
    expect((await waitlistCount(req('Bearer k-123'), env(), async () => { throw new Error('down'); })).status).toBe(503);
  });

  it('answers the count to the operator', async () => {
    expect(await waitlistCount(req('Bearer k-123'), env(), async () => 7)).toEqual({ status: 200, body: { count: 7 } });
  });

  it('the route serves the answer uncached, with the store behind the shared check', () => {
    const route = readFileSync(join(root, 'website', 'src', 'app', 'api', 'waitlist-count', 'route.ts'), 'utf8');
    expect(route).toContain('waitlistCount(');
    expect(route).toContain('"Cache-Control": "no-store"');
  });

  it('is not fetched or printed by the site', () => {
    const cloud = readFileSync(join(root, 'website', 'src', 'components', 'cloud.tsx'), 'utf8');
    expect(cloud).not.toContain('waitlist-count');
    expect(cloud).not.toMatch(/on the waitlist/);
  });
});
