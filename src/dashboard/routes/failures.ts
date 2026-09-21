import { Router } from 'express';
import type { AgentFailureLogEntry, IStorageAdapter } from '../../types/query.js';
import { requireTenant } from '../../middleware/tenant.js';
import type { FailureQueryResult, RankedFailure } from '../../types/decision-moment.js';
import { deriveMoment, historyBefore } from '../../eval/decision-moment.js';
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
      /*
       * One failure log per distinct agent on this page, as the moments
       * route reads it (arc 7, D-7a): a cost spike is judged against the
       * agent's own recent costs, and the novelty classes against its own
       * failures, so this page ranks what the moments page ranks.
       */
      const logs = new Map<string, AgentFailureLogEntry[]>();
      for (const agent of new Set(traceResult.traces.map((t) => t.agent_name))) {
        logs.set(agent, await storage.getAgentFailureLog(tenantId, agent));
      }

      // The page's evaluations in one read (arc 9, N-1), as the moments route does.
      const evalsByTrace = await storage.getEvalsByTraceIds(
        tenantId,
        traceResult.traces.map((t) => t.trace_id),
      );
      const nowMs = Date.now();
      const failures: RankedFailure[] = [];
      for (const trace of traceResult.traces) {
        const evals = evalsByTrace.get(trace.trace_id) ?? [];
        const history = historyBefore(logs.get(trace.agent_name) ?? [], trace.trace_id, trace.timestamp);
        const moment = deriveMoment(trace, evals, history);
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
