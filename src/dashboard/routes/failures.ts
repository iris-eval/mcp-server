import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import { requireTenant } from '../../middleware/tenant.js';
import type { FailureQueryResult, RankedFailure } from '../../types/decision-moment.js';
import { deriveMoment } from '../../eval/decision-moment.js';
import { isFailureMoment, rankFailureScore } from '../../eval/failure-rank.js';
import { failuresQuerySchema } from '../validation.js';

/*
 * How many recent traces to scan when building the failure list. On a
 * mostly-passing fleet failures are sparse, so the scan window must be
 * wider than the returned list — a hard cap of `limit` traces would miss
 * every failure older than the last `limit` runs. 500 is bounded work
 * for local SQLite (same hydration loop the moments route already runs
 * at 200) and reaches far enough back for a single-user install.
 */
const FAILURE_SCAN_CAP = 500;

export function registerFailureRoutes(router: Router, storage: IStorageAdapter): void {
  /**
   * GET /failures
   * Ranked failure list — the dashboard's landing surface. Recent
   * failed/flagged moments ranked by severity × recency decay
   * (see src/eval/failure-rank.ts). Unlike /moments this filters and
   * ranks server-side, so a failure buried behind hundreds of passing
   * traces still surfaces.
   */
  router.get('/failures', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const query = failuresQuerySchema.parse(req.query);

      const traceResult = await storage.queryTraces(tenantId, {
        filter: {
          agent_name: query.agent_name,
          since: query.since,
          until: query.until,
        },
        limit: FAILURE_SCAN_CAP,
        offset: 0,
        sort_by: 'timestamp',
        sort_order: 'desc',
      });

      // Hydrate + classify each scanned trace, keep only failures.
      // Sequential per-trace eval fetches match the moments route's
      // approach — acceptable at this cap; batching is a later
      // optimization once we have volume data.
      const nowMs = Date.now();
      const failures: RankedFailure[] = [];
      for (const trace of traceResult.traces) {
        const evals = await storage.getEvalsByTraceId(tenantId, trace.trace_id);
        const moment = deriveMoment(trace, evals);
        if (!isFailureMoment(moment)) continue;
        failures.push({ ...moment, rankScore: rankFailureScore(moment, nowMs) });
      }

      // Rank: severity × recency blend first, newest first on exact ties.
      failures.sort((a, b) => {
        if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      });

      const result: FailureQueryResult = {
        failures: failures.slice(0, query.limit),
        scanned: traceResult.traces.length,
        total: traceResult.total,
        limit: query.limit,
      };

      res.json(result);
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({
          error: 'Invalid query parameters',
          details: (err as unknown as { issues: unknown }).issues,
        });
        return;
      }
      throw err;
    }
  });
}
