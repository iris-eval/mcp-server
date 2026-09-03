/*
 * GET /health — trace_count must be the all-time count.
 *
 * It used to read the dashboard summary's ONE-HOUR window, so on the demo
 * database /api/v1/health said `trace_count: 0` while /api/v1/traces said
 * 253 (#373 item 1). A liveness field that contradicts the data it fronts
 * sends a capture client's sanity check the wrong way.
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
  it('reports the all-time trace count, not the last hour', async () => {
    const storage = {
      // What the old code read: nothing in the last hour.
      getDashboardSummary: async () => ({ total_traces: 0 }),
      // What the endpoint must report: the unfiltered COUNT(*).
      queryTraces: async (_tenant: unknown, opts: { limit?: number }) => {
        expect(opts.limit).toBe(1);
        return { traces: [{}], total: 253, limit: 1, offset: 0 };
      },
    } as unknown as IStorageAdapter;

    const { status, body } = await getHealth(storage);
    expect(status).toBe(200);
    expect(body.trace_count).toBe(253);
    expect(body.storage).toBe('connected');
    expect(body.version).toBe('9.9.9');
  });

  it('degrades to 503 when storage cannot be counted', async () => {
    const storage = {
      queryTraces: async () => {
        throw new Error('database is locked');
      },
    } as unknown as IStorageAdapter;
    const { status, body } = await getHealth(storage);
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
  });

  it('answers without a storage adapter at all', async () => {
    const { status, body } = await getHealth(undefined);
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('trace_count');
  });
});
