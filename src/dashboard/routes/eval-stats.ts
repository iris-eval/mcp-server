import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import { evalStatsPeriodSchema, evalStatsFailuresSchema } from '../validation.js';

export function registerEvalStatsRoutes(router: Router, storage: IStorageAdapter): void {
  /**
   * GET /eval-stats
   * Aggregate eval statistics for dashboard hero cards.
   */
  router.get('/eval-stats', async (req, res) => {
    try {
      const { period } = evalStatsPeriodSchema.parse(req.query);
      const stats = await storage.getEvalStats(period);
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
      const { period } = evalStatsPeriodSchema.parse(req.query);
      const trend = await storage.getEvalStatsTrend(period);
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
   * GET /eval-stats/rules
   * Per-rule pass rates for the rule breakdown chart.
   * Sorted by passRate ASC (worst rules first).
   */
  router.get('/eval-stats/rules', async (req, res) => {
    try {
      const { period } = evalStatsPeriodSchema.parse(req.query);
      const rules = await storage.getEvalStatsRules(period);
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
      const query = evalStatsFailuresSchema.parse(req.query);
      const failures = await storage.getEvalStatsFailures(query.period, query.limit);
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
