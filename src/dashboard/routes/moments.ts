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
   * `timestamp` (the default) orders by time, newest first unless
   * sort_order=asc. `significance` ranks the moments of the most recent
   * `window` matching traces by significance.score, newest first among
   * equals (#409). Either order reads a window when a verdict or
   * significance filter is set (#657).
   */
  sort_by: z.enum(['timestamp', 'significance']).default('timestamp'),
  sort_order: z.enum(['asc', 'desc']).optional(),
  window: z.coerce.number().int().min(1).max(MOMENT_RANK_WINDOW_MAX).optional(),
}).superRefine((q, ctx) => {
  // Refused rather than ignored: a parameter that silently does nothing
  // reads as though it had been applied.
  if (q.sort_by === 'timestamp' && q.window !== undefined && !hasFilter(q)) {
    ctx.addIssue({
      code: 'custom',
      path: ['window'],
      message: 'window applies to sort_by=significance, or with a verdict, min_significance or significance_kind filter',
    });
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

/** A filter on what the derived moment is, as opposed to which traces are read. */
function hasFilter(q: Pick<MomentQuery, 'verdict' | 'min_significance' | 'significance_kind'>): boolean {
  return q.verdict !== undefined || q.min_significance !== undefined || q.significance_kind !== undefined;
}

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
       * Two ways to read moments.
       *
       * Unfiltered and newest first (or oldest first), a page of moments is
       * a page of traces: `offset` counts traces and `total` counts them.
       *
       * Ranked by significance (#409), or with a verdict or significance
       * filter (#657), the route reads a stated window instead: the first
       * `window` traces that match agent/since/until, in the order asked
       * for (the newest when ranking). Every moment in it is derived and
       * filtered before a page is cut, so a page holds `limit` moments
       * whenever that many match, page two starts where page one ended, and
       * `total` is exact within the window. Until 0.20.0 a filtered page was
       * cut from `limit` traces (4 × limit with a significance filter), so
       * `?verdict=fail&limit=50` could return 3 moments with hundreds of
       * failures further back, `offset` skipped or repeated moments, and
       * `total` counted traces. The window is bounded work on every read
       * and stated in the response, so a reader knows how far it reaches.
       * To page newest first while traces arrive, pin `until` to the
       * first page's window.newest.
       */
      const filtered = hasFilter(query);
      if (query.sort_by === 'significance' || filtered) {
        const size = query.window ?? MOMENT_RANK_WINDOW_DEFAULT;
        const order = query.sort_by === 'significance' ? 'desc' : (query.sort_order ?? 'desc');
        const traceResult = await storage.queryTraces(tenantId, {
          filter: { agent_name: query.agent_name, since: query.since, until: query.until },
          limit: size,
          offset: 0,
          sort_by: 'timestamp',
          sort_order: order,
        });
        const traces = traceResult.traces;
        const kept = (await momentsOf(tenantId, traces)).filter((m) => keeps(m, query));
        const ordered = query.sort_by === 'significance' ? rankBySignificance(kept) : kept;
        const stamps = traces.map((t) => t.timestamp).sort();
        const windowed: MomentQueryResult = {
          moments: ordered.slice(query.offset, query.offset + query.limit),
          total: ordered.length,
          limit: query.limit,
          offset: query.offset,
          ...(query.sort_by === 'significance' ? { sortBy: 'significance' as const } : {}),
          window: {
            size,
            scanned: traces.length,
            tracesInRange: traceResult.total,
            ...(stamps.length > 0 ? { newest: stamps[stamps.length - 1], oldest: stamps[0] } : {}),
          },
        };
        res.json(windowed);
        return;
      }

      const traceResult = await storage.queryTraces(tenantId, {
        filter: {
          agent_name: query.agent_name,
          since: query.since,
          until: query.until,
        },
        limit: query.limit,
        offset: query.offset,
        sort_by: 'timestamp',
        sort_order: query.sort_order ?? 'desc',
      });

      const result: MomentQueryResult = {
        moments: await momentsOf(tenantId, traceResult.traces),
        // Unfiltered, one trace is one moment, so this is exact.
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
