/*
 * The read routes refuse a misspelled filter (arc 9, N-4; #376).
 *
 * A bare z.object() on a query string stripped an unknown parameter, so
 * `GET /api/v1/moments?agent_nme=docs-qa` returned every agent's rows as
 * if the filter had applied — the silent-strip defect the bodies were cured
 * of in 0.5.x, one verb over. Every closed query shape is now strict: the
 * refusal is a 400 that names the unknown key and the valid ones, through
 * the real routes with the real tenant middleware.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import { registerMomentRoutes } from '../../../../src/dashboard/routes/moments.js';
import { registerAuditRoutes } from '../../../../src/dashboard/routes/audit.js';
import { registerEvalStatsRoutes } from '../../../../src/dashboard/routes/eval-stats.js';
import { createTenantMiddleware } from '../../../../src/middleware/tenant.js';
import type { IStorageAdapter } from '../../../../src/types/query.js';

const storage = {
  queryTraces: async () => ({ traces: [], total: 0, limit: 50, offset: 0 }),
  getEvalsByTraceIds: async () => new Map(),
  getAgentFailureLog: async () => [],
  getEvalStats: async () => ({}),
  getEvalStatsTrend: async () => [],
  getDriftWindow: async () => ({ evaluated: 0, passed: 0 }),
} as unknown as IStorageAdapter;

function makeApp() {
  const app = express();
  app.use(createTenantMiddleware());
  const router = express.Router();
  registerMomentRoutes(router, storage);
  registerAuditRoutes(router);
  registerEvalStatsRoutes(router, storage);
  app.use('/api/v1', router);
  return app;
}

async function request(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = makeApp().listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${addr.port}${path}`);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

const messageOf = (body: Record<string, unknown>): string => JSON.stringify(body);

describe('a misspelled query parameter is refused, not ignored', () => {
  it('GET /moments?agent_nme= is a 400 naming the key and the valid parameters', async () => {
    const { status, body } = await request('/api/v1/moments?agent_nme=docs-qa');
    expect(status).toBe(400);
    expect(messageOf(body)).toContain('"agent_nme"');
    expect(messageOf(body)).toContain('agent_name');
    expect(messageOf(body)).toContain('Unknown query parameter');
  });

  it('GET /audit?actoin= is a 400 naming the key', async () => {
    const { status, body } = await request('/api/v1/audit?actoin=rule.deploy');
    expect(status).toBe(400);
    expect(messageOf(body)).toContain('"actoin"');
  });

  it('GET /eval-stats/drift?perod= is a 400 naming the key', async () => {
    const { status, body } = await request('/api/v1/eval-stats/drift?perod=7d');
    expect(status).toBe(400);
    expect(messageOf(body)).toContain('"perod"');
  });

  it('the declared parameters still pass', async () => {
    expect((await request('/api/v1/moments?agent_name=docs-qa&limit=5')).status).toBe(200);
    expect((await request('/api/v1/audit?limit=5')).status).toBe(200);
    expect((await request('/api/v1/eval-stats/drift?period=7d')).status).toBe(200);
  });
});
