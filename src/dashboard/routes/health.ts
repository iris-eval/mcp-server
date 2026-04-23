import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import { LOCAL_TENANT } from '../../types/tenant.js';

const startTime = Date.now();

export function registerHealthRoutes(router: Router, storage?: IStorageAdapter, version?: string): void {
  const serverVersion = version ?? 'unknown';

  router.get('/health', async (_req, res) => {
    const uptime_seconds = Math.floor((Date.now() - startTime) / 1000);

    if (storage) {
      try {
        /* Health probes use LOCAL_TENANT directly — the health endpoint
         * is pre-tenant-resolution (runs for unauthenticated callers on
         * Cloud too) and reports server-level stats. This is the ONE
         * place storage is called with an explicit LOCAL_TENANT rather
         * than a resolved tenantId; deliberate, documented here so it
         * stays the only exception. */
        const summary = await storage.getDashboardSummary(LOCAL_TENANT, 1);
        res.json({
          status: 'ok',
          version: serverVersion,
          uptime_seconds,
          trace_count: summary.total_traces,
          storage: 'connected',
        });
      } catch {
        res.status(503).json({ status: 'degraded', version: serverVersion, uptime_seconds, storage: 'disconnected' });
      }
    } else {
      res.json({ status: 'ok', version: serverVersion, uptime_seconds });
    }
  });
}
