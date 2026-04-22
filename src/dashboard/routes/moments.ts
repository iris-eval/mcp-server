import { Router } from 'express';
import { z } from 'zod';
import type { IStorageAdapter } from '../../types/query.js';
import type {
  DecisionMoment,
  MomentQueryResult,
  MomentSignificanceKind,
  MomentVerdict,
} from '../../types/decision-moment.js';
import { deriveMoment, deriveMomentDetail } from '../../eval/decision-moment.js';

const VERDICT_VALUES: MomentVerdict[] = ['pass', 'fail', 'partial', 'unevaluated'];
const SIGNIFICANCE_KINDS: MomentSignificanceKind[] = [
  'safety-violation',
  'cost-spike',
  'first-failure',
  'novel-pattern',
  'rule-collision',
  'normal-pass',
  'normal-fail',
];

const momentQuerySchema = z.object({
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
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export function registerMomentRoutes(router: Router, storage: IStorageAdapter): void {
  router.get('/moments', async (req, res) => {
    try {
      const query = momentQuerySchema.parse(req.query);

      // Pull the underlying traces. We over-fetch when post-filtering by
      // significance to give the moment classifier headroom, then trim.
      const wantsSignificanceFilter =
        query.min_significance !== undefined || query.significance_kind !== undefined;
      const fetchLimit = wantsSignificanceFilter
        ? Math.min(query.limit * 4, 200)
        : query.limit;

      const traceResult = await storage.queryTraces({
        filter: {
          agent_name: query.agent_name,
          since: query.since,
          until: query.until,
        },
        limit: fetchLimit,
        offset: query.offset,
        sort_by: 'timestamp',
        sort_order: query.sort_order,
      });

      // Hydrate moments by fetching evals per trace. Acceptable for limit ≤ 200;
      // batching is a v0.4.1 optimization once we have moment-volume data.
      const moments: DecisionMoment[] = [];
      for (const trace of traceResult.traces) {
        const evals = await storage.getEvalsByTraceId(trace.trace_id);
        const moment = deriveMoment(trace, evals);

        if (query.verdict && moment.verdict !== query.verdict) continue;
        if (
          query.min_significance !== undefined &&
          moment.significance.score < query.min_significance
        )
          continue;
        if (
          query.significance_kind &&
          moment.significance.kind !== query.significance_kind
        )
          continue;

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
      const trace = await storage.getTrace(req.params.id);
      if (!trace) {
        res.status(404).json({ error: 'Decision moment not found' });
        return;
      }
      const [evals, spans] = await Promise.all([
        storage.getEvalsByTraceId(req.params.id),
        storage.getSpansByTraceId(req.params.id),
      ]);
      const detail = deriveMomentDetail(trace, evals, spans);
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
