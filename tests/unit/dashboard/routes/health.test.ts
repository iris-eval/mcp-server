/*
 * GET /health — answers without a key, so it proves the store can count
 * traces and never says how many there are. It used to carry
 * `trace_count`, which told any unauthenticated caller how much data the
 * server held; the number is `total` on the authenticated GET /api/v1/traces.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import { registerHealthRoutes } from '../../../../src/dashboard/routes/health.js';
import type { IStorageAdapter } from '../../../../src/types/query.js';

async function getHealth(storage?: IStorageAdapter): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  const router = express.Router();
  registerHealthRoutes(router, storage, '9.9.9');
  app.use('/api/v1', router);
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${addr.port}/api/v1/health`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe('GET /health', () => {
  it('checks that the store counts, without disclosing the count', async () => {
    const storage = {
      queryTraces: async (_tenant: unknown, opts: { limit?: number }) => {
        expect(opts.limit).toBe(1);
        return { traces: [{}], total: 253, limit: 1, offset: 0 };
      },
      driver: 'better-sqlite3',
      migrations: async () => ({ applied: 11, known: 11, pending: [] }),
    } as unknown as IStorageAdapter;

    const { status, body } = await getHealth(storage);
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('trace_count');
    expect(JSON.stringify(body)).not.toContain('253');
    expect(body.storage).toBe('connected');
    expect(body.version).toBe('9.9.9');
    // The one contract: the route serves what src/health.ts builds.
    expect(body.driver).toBe('better-sqlite3');
    expect(body.checks).toEqual({ storage: 'ok', rules_store: 'absent', migrations: { status: 'ok', applied: 11, known: 11 } });
  });

  it('degrades to 503 when storage cannot be counted', async () => {
    const storage = {
      queryTraces: async () => {
        throw new Error('database is locked');
      },
      driver: 'better-sqlite3',
      migrations: async () => ({ applied: 11, known: 11, pending: [] }),
    } as unknown as IStorageAdapter;
    const { status, body } = await getHealth(storage);
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect((body.checks as { storage: string }).storage).toBe('fail');
  });

  it('answers without a storage adapter at all', async () => {
    const { status, body } = await getHealth(undefined);
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('trace_count');
    expect(body.driver).toBeNull();
  });
});
