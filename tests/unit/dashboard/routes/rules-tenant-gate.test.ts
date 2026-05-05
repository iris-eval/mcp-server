/*
 * Tenant gate regression test for /rules/custom routes.
 *
 * In OSS, the tenant middleware always sets req.tenantId = LOCAL_TENANT,
 * so removing requireTenant() from a route handler doesn't break any
 * existing test. This test mounts the routes WITHOUT tenant middleware
 * and asserts the routes fail-closed — proving the gate is in place.
 *
 * If a future change removes a `requireTenant(req)` call from one of
 * these handlers, this test catches it.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import { registerRuleRoutes } from '../../../../src/dashboard/routes/rules.js';
import type { CustomRuleStore } from '../../../../src/custom-rule-store.js';
import type { EvalEngine } from '../../../../src/eval/engine.js';
import type { IStorageAdapter } from '../../../../src/types/query.js';

// Minimal stubs — we never reach the store because the gate fires first.
const stubStore = {
  list: () => [],
  delete: () => true,
  deploy: () => ({}),
} as unknown as CustomRuleStore;
const stubEngine = { registerRule: () => {} } as unknown as EvalEngine;
const stubStorage = {} as unknown as IStorageAdapter;

function makeAppWithoutTenant() {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerRuleRoutes(router, stubStorage, {
    customRuleStore: stubStore,
    evalEngine: stubEngine,
  });
  app.use('/api/v1', router);
  // Express default error handler converts unhandled throws to 500.
  // No tenant middleware is mounted — every requireTenant() call must throw.
  return app;
}

async function request(
  app: express.Express,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number }> {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${addr.port}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status };
  } finally {
    server.close();
  }
}

describe('/rules/custom — tenant gate', () => {
  it('GET refuses when tenant middleware is not mounted', async () => {
    const app = makeAppWithoutTenant();
    const res = await request(app, 'GET', '/api/v1/rules/custom');
    expect(res.status).toBe(500);
  });

  it('POST refuses when tenant middleware is not mounted', async () => {
    const app = makeAppWithoutTenant();
    const res = await request(app, 'POST', '/api/v1/rules/custom', {
      name: 'gate-test',
      evalType: 'completeness',
      definition: { name: 'gate-test', type: 'min_length', config: { min: 1 } },
    });
    expect(res.status).toBe(500);
  });

  it('DELETE refuses when tenant middleware is not mounted', async () => {
    const app = makeAppWithoutTenant();
    const res = await request(app, 'DELETE', '/api/v1/rules/custom/anything');
    expect(res.status).toBe(500);
  });
});
