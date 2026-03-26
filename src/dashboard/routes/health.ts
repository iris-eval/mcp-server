import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';

const startTime = Date.now();

export function registerHealthRoutes(router: Router, storage?: IStorageAdapter, version?: string): void {
  const serverVersion = version ?? 'unknown';

  router.get('/health', async (_req, res) => {
    const uptime_seconds = Math.floor((Date.now() - startTime) / 1000);

    if (storage) {
      try {
        const summary = await storage.getDashboardSummary(1);
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
