import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import { LOCAL_TENANT } from '../../types/tenant.js';
import { judgeState } from '../../judge-enablement.js';

const startTime = Date.now();

export interface HealthOptions {
  /** `demo` when serving the disposable demo database. */
  mode?: 'real' | 'demo';
}

export function registerHealthRoutes(router: Router, storage?: IStorageAdapter, version?: string, options?: HealthOptions): void {
  const serverVersion = version ?? 'unknown';
  const mode = options?.mode ?? 'real';

  router.get('/health', async (_req, res) => {
    const uptime_seconds = Math.floor((Date.now() - startTime) / 1000);
    /*
     * The judge state, provider name only — never the key. Read per
     * request rather than at boot so a test (or an operator) that sets
     * the variable in this process sees it here; the process a client
     * spawns has a fixed environment anyway, so both reads agree there.
     */
    const judge = judgeState();
    const judgeField = { enabled: judge.enabled, provider: judge.provider };

    if (storage) {
      try {
        /* Health probes use LOCAL_TENANT directly — the health endpoint
         * is pre-tenant-resolution (runs for unauthenticated callers on
         * Cloud too) and reports server-level stats. This is the ONE
         * place storage is called with an explicit LOCAL_TENANT rather
         * than a resolved tenantId; deliberate, documented here so it
         * stays the only exception.
         *
         * trace_count is ALL-TIME. It used to read the dashboard
         * summary's 1-hour window, so /health said 0 while /api/v1/traces
         * said 253 on the same demo database (#373 item 1) — a liveness
         * field that disagrees with the data it fronts is worse than
         * none. queryTraces' `total` is the unfiltered COUNT(*) for the
         * tenant; limit 1 keeps the row fetch negligible. */
        const { total } = await storage.queryTraces(LOCAL_TENANT, { limit: 1, offset: 0 });
        res.json({
          status: 'ok',
          version: serverVersion,
          uptime_seconds,
          trace_count: total,
          storage: 'connected',
          judge: judgeField,
          mode,
        });
      } catch {
        res.status(503).json({ status: 'degraded', version: serverVersion, uptime_seconds, storage: 'disconnected', judge: judgeField, mode });
      }
    } else {
      res.json({ status: 'ok', version: serverVersion, uptime_seconds, judge: judgeField, mode });
    }
  });
}
