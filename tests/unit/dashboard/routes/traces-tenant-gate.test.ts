/*
 * Tenant gate regression test for POST /traces (HTTP ingest).
 *
 * Same rationale as rules-tenant-gate.test.ts: in OSS the tenant
 * middleware always sets req.tenantId = LOCAL_TENANT, so removing the
 * requireTenant() call from the ingest handler would break no other
 * test. This mounts the route WITHOUT tenant middleware and asserts it
 * fails closed — a write path that silently defaulted the tenant would
 * be a cross-tenant insert in Cloud.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import { registerTraceRoutes } from '../../../../src/dashboard/routes/traces.js';
import type { IStorageAdapter } from '../../../../src/types/query.js';

// The gate fires before storage is touched; insertTrace proves it if not.
let insertCalled = false;
const stubStorage = {
  insertTrace: async () => {
    insertCalled = true;
  },
} as unknown as IStorageAdapter;

function makeAppWithoutTenant() {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerTraceRoutes(router, stubStorage);
  app.use('/api/v1', router);
  // Express default error handler converts unhandled throws to 500.
  // No tenant middleware is mounted — every requireTenant() call must throw.
  return app;
}

describe('POST /traces — tenant gate', () => {
  it('refuses when tenant middleware is not mounted, without touching storage', async () => {
    const app = makeAppWithoutTenant();
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    try {
      const res = await fetch(`http://localhost:${addr.port}/api/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_name: 'gate-test' }),
      });
      expect(res.status).toBe(500);
      expect(insertCalled).toBe(false);
    } finally {
      server.close();
    }
  });
});
