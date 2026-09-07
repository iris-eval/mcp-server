import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import { requireTenant } from '../../middleware/tenant.js';
import { evalStatsPeriodSchema, evalStatsFailuresSchema, evalStatsTrendSchema, driftSchema } from '../validation.js';
import { newcombeDifference, smallestDetectableDifference } from '../../eval/stats.js';

/*
 * Below this many evaluations on a side, the comparison is reported as
 * "not enough evidence" rather than as a direction.
 *
 * Not a statistical constant — the interval already handles the statistics,
 * and it would correctly refuse to call a 3-vs-4 comparison significant.
 * This is about what a number does to a reader before they read the
 * interval: "pass rate down 33 points" printed above a chart lands as a
 * finding no matter what the caveat beside it says, and at n = 3 it is one
 * trace. So the small case is presented as a count of what is missing
 * instead, and the direction is withheld.
 */
const MIN_WINDOW_FOR_DIRECTION = 10;

/** Days in each drift window, matching the trend periods. */
const PERIOD_DAYS: Record<string, number> = {
  '24h': 1, '2d': 2, '7d': 7, '14d': 14, '30d': 30, '60d': 60, '90d': 90, '180d': 180,
};

export function registerEvalStatsRoutes(router: Router, storage: IStorageAdapter): void {
  /**
   * GET /eval-stats
   * Aggregate eval statistics for dashboard hero cards.
   */
  router.get('/eval-stats', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const { period } = evalStatsPeriodSchema.parse(req.query);
      const stats = await storage.getEvalStats(tenantId, period);
      res.json(stats);
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid query parameters', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });

  /**
   * GET /eval-stats/trend
   * Eval scores bucketed over time for the trend chart.
   */
  router.get('/eval-stats/trend', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      // `?cohort=run` splits the line per run. Ungrouped by default, so
      // every existing caller sees exactly the response it saw before.
      const { period, cohort } = evalStatsTrendSchema.parse(req.query);
      const trend = await storage.getEvalStatsTrend(tenantId, period, cohort);
      res.json(trend);
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid query parameters', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });

  /**
   * GET /eval-stats/drift
   * This window against the one before it, with both denominators and a
   * 95% interval on the difference — so the Drift view can show whether a
   * change is a finding or a coin. The interval comes from the same
   * newcombeDifference the proof harness and compare_runs use.
   */
  router.get('/eval-stats/drift', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const { period, run } = driftSchema.parse(req.query);
      const days = PERIOD_DAYS[period];
      const now = Date.now();
      const currentSince = new Date(now - days * 86_400_000).toISOString();
      const priorSince = new Date(now - days * 2 * 86_400_000).toISOString();

      const [current, prior] = await Promise.all([
        storage.getDriftWindow(tenantId, currentSince, null, run),
        storage.getDriftWindow(tenantId, priorSince, currentSince, run),
      ]);

      const enough = current.evaluated >= MIN_WINDOW_FOR_DIRECTION && prior.evaluated >= MIN_WINDOW_FOR_DIRECTION;
      const difference = enough
        ? newcombeDifference(current.passed, current.evaluated, prior.passed, prior.evaluated)
        : null;
      const smallestDetectable =
        difference !== null && !difference.significant
          ? smallestDetectableDifference(current.evaluated, prior.evaluated)
          : null;

      res.json({
        period,
        run: run ?? null,
        current,
        prior,
        difference,
        /*
         * Reported so the view never has to guess why it got no direction,
         * and so the reason it shows a reader is the real one: too few
         * evaluations, or enough of them and no detectable change.
         */
        enoughEvidence: enough,
        minimumPerWindow: MIN_WINDOW_FOR_DIRECTION,
        smallestDetectable,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid query parameters', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });

  /**
   * GET /eval-stats/rules
   * Per-rule pass rates for the rule breakdown chart.
   * Sorted by passRate ASC (worst rules first).
   */
  router.get('/eval-stats/rules', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const { period } = evalStatsPeriodSchema.parse(req.query);
      const rules = await storage.getEvalStatsRules(tenantId, period);
      res.json(rules);
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid query parameters', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });

  /**
   * GET /eval-stats/failures
   * Recent failing evaluations for the failures table.
   */
  router.get('/eval-stats/failures', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const query = evalStatsFailuresSchema.parse(req.query);
      const failures = await storage.getEvalStatsFailures(tenantId, query.period, query.limit);
      res.json(failures);
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid query parameters', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });
}
