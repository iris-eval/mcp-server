import { Router } from 'express';
import { z } from 'zod';
import { strictQuery } from '../validation.js';
import type { IStorageAdapter } from '../../types/query.js';
import { requireTenant } from '../../middleware/tenant.js';
import type {
  DecisionMoment,
  MomentQueryResult,
  MomentSignificanceKind,
  MomentVerdict,
} from '../../types/decision-moment.js';
import { deriveMoment, deriveMomentDetail, historyBefore } from '../../eval/decision-moment.js';
import { MOMENT_SIGNIFICANCE_KINDS } from '../../types/decision-moment.js';
import type { AgentFailureLogEntry } from '../../types/query.js';
import type { Trace } from '../../types/trace.js';
import type { TenantId } from '../../types/tenant.js';
import {
  MOMENT_RANK_WINDOW_DEFAULT,
  MOMENT_RANK_WINDOW_MAX,
  rankBySignificance,
} from '../../eval/moment-rank.js';

const VERDICT_VALUES: MomentVerdict[] = ['pass', 'fail', 'partial', 'unevaluated'];
const SIGNIFICANCE_KINDS: readonly MomentSignificanceKind[] = MOMENT_SIGNIFICANCE_KINDS;

const momentQuerySchema = strictQuery({
  agent_name: z.string().min(1).max(200).optional(),
  verdict: z.enum(VERDICT_VALUES as [MomentVerdict, ...MomentVerdict[]]).optional(),
  min_significance: z.coerce.number().min(0).max(1).optional(),
  significance_kind: z
    .enum(SIGNIFICANCE_KINDS as [MomentSignificanceKind, ...MomentSignificanceKind[]])
    .optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  /*
   * `timestamp` (the default, and every caller before 0.20.0) pages through
   * traces newest first. `significance` ranks the moments of the most
   * recent `window` matching traces by significance.score, newest first
   * among equals, and pages within that ranking (#409).
   */
  sort_by: z.enum(['timestamp', 'significance']).default('timestamp'),
  sort_order: z.enum(['asc', 'desc']).optional(),
  window: z.coerce.number().int().min(1).max(MOMENT_RANK_WINDOW_MAX).optional(),
}).superRefine((q, ctx) => {
  // Refused rather than ignored: a parameter that silently does nothing
  // reads as though it had been applied.
  if (q.sort_by === 'timestamp' && q.window !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['window'], message: 'window applies only to sort_by=significance' });
  }
  if (q.sort_by === 'significance' && q.sort_order === 'asc') {
    ctx.addIssue({
      code: 'custom',
      path: ['sort_order'],
      message: 'sort_by=significance ranks the most significant first; sort_order=asc applies only to sort_by=timestamp',
    });
  }
});

type MomentQuery = z.infer<typeof momentQuerySchema>;

/** The verdict and significance filters, applied the same way by both orders. */
function keeps(moment: DecisionMoment, query: MomentQuery): boolean {
  if (query.verdict && moment.verdict !== query.verdict) return false;
  if (query.min_significance !== undefined && moment.significance.score < query.min_significance) return false;
  if (query.significance_kind && moment.significance.kind !== query.significance_kind) return false;
  return true;
}

export function registerMomentRoutes(router: Router, storage: IStorageAdapter): void {
  /** Each trace's moment, classified against its agent's own history, in trace order. */
  async function momentsOf(tenantId: TenantId, traces: readonly Trace[]): Promise<DecisionMoment[]> {
    // Hydrate the page's evaluations in ONE read. Until 0.16.0 this was
    // one query per trace: a window of 200 moments took 2.4 s on a warm
    // local file and longer under the dashboard's own concurrent reads —
    // longer than the poll cadence, which is how the Drift and Health
    // prior windows came to never render.
    const evalsByTrace = await storage.getEvalsByTraceIds(
      tenantId,
      traces.map((t) => t.trace_id),
    );
    /*
     * One failure log per distinct agent on this page, not one per trace.
     * "Has this rule failed before" has to be answered as of each trace,
     * and asking SQL that question two hundred times is two hundred scans
     * on a page render. Read once, filter by timestamp in memory.
     */
    const logs = new Map<string, AgentFailureLogEntry[]>();
    for (const agent of new Set(traces.map((t) => t.agent_name))) {
      logs.set(agent, await storage.getAgentFailureLog(tenantId, agent));
    }
    return traces.map((trace) =>
      deriveMoment(
        trace,
        evalsByTrace.get(trace.trace_id) ?? [],
        historyBefore(logs.get(trace.agent_name) ?? [], trace.trace_id, trace.timestamp),
      ),
    );
  }

  router.get('/moments', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const query = momentQuerySchema.parse(req.query);

      /*
       * Ranked by significance within a stated window (#409).
       *
       * Every moment in the window is derived, filtered and ranked before
       * a page is cut, so `total` is exact within the window and page two
       * starts where page one ended. The window is the newest `window`
       * traces that match agent/since/until: bounded work on every read,
       * and stated in the response so a reader knows how far back the
       * ranking reaches. To page over a live stream without new traces
       * shifting the window, pass `until` = window.newest from the first page.
       */
      if (query.sort_by === 'significance') {
        const size = query.window ?? MOMENT_RANK_WINDOW_DEFAULT;
        const traceResult = await storage.queryTraces(tenantId, {
          filter: { agent_name: query.agent_name, since: query.since, until: query.until },
          limit: size,
          offset: 0,
          sort_by: 'timestamp',
          sort_order: 'desc',
        });
        const traces = traceResult.traces;
        const ranked = rankBySignificance((await momentsOf(tenantId, traces)).filter((m) => keeps(m, query)));
        const ranking: MomentQueryResult = {
          moments: ranked.slice(query.offset, query.offset + query.limit),
          total: ranked.length,
          limit: query.limit,
          offset: query.offset,
          sortBy: 'significance',
          window: {
            size,
            scanned: traces.length,
            tracesInRange: traceResult.total,
            ...(traces.length > 0 ? { newest: traces[0].timestamp, oldest: traces[traces.length - 1].timestamp } : {}),
          },
        };
        res.json(ranking);
        return;
      }

      // Pull the underlying traces. We over-fetch when post-filtering by
      // significance to give the moment classifier headroom, then trim.
      const wantsSignificanceFilter =
        query.min_significance !== undefined || query.significance_kind !== undefined;
      const fetchLimit = wantsSignificanceFilter
        ? Math.min(query.limit * 4, 200)
        : query.limit;

      const traceResult = await storage.queryTraces(tenantId, {
        filter: {
          agent_name: query.agent_name,
          since: query.since,
          until: query.until,
        },
        limit: fetchLimit,
        offset: query.offset,
        sort_by: 'timestamp',
        sort_order: query.sort_order ?? 'desc',
      });

      const moments: DecisionMoment[] = [];
      for (const moment of await momentsOf(tenantId, traceResult.traces)) {
        if (!keeps(moment, query)) continue;
        moments.push(moment);
        if (moments.length >= query.limit) break;
      }

      const result: MomentQueryResult = {
        moments,
        // total reflects the underlying trace count (pre-filter) — significance-
        // filtered totals would require materializing the full set, which we
        // avoid for now. Clients should treat this as "at least this many."
        total: traceResult.total,
        limit: query.limit,
        offset: query.offset,
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

  router.get('/moments/:id', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const trace = await storage.getTrace(tenantId, req.params.id);
      if (!trace) {
        res.status(404).json({ error: 'Decision moment not found' });
        return;
      }
      const [evals, spans, log] = await Promise.all([
        storage.getEvalsByTraceId(tenantId, req.params.id),
        storage.getSpansByTraceId(tenantId, req.params.id),
        storage.getAgentFailureLog(tenantId, trace.agent_name),
      ]);
      // The same history the list used, so a moment does not change class
      // between the row someone clicked and the page it opened.
      const detail = deriveMomentDetail(trace, evals, spans, historyBefore(log, trace.trace_id, trace.timestamp));
      res.json(detail);
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
