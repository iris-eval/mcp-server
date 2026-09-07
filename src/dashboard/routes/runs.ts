import { Router } from 'express';
import type { IStorageAdapter } from '../../types/query.js';
import { requireTenant } from '../../middleware/tenant.js';
import { runsQuerySchema, caseQuerySchema } from '../validation.js';

/*
 * The read side of a comparison, over HTTP.
 *
 * These three routes answer the questions the two compare tools answer, for
 * a caller that is not an MCP client — a CI job asking "what runs do I have
 * and did the last one pass", a dashboard drawing a cohort. They are reads
 * only: nothing here creates a run, because a run is created by tagging
 * traces with it, and inventing one from a GET would produce a grouping
 * nobody asked for.
 */
export function registerRunRoutes(router: Router, storage: IStorageAdapter): void {
  /**
   * GET /runs
   * Every run, newest first. Registered runs and runs that exist only
   * because a trace carried the id — a caller who passed `run` on log_trace
   * and nothing else must still find their run here.
   */
  router.get('/runs', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const { limit } = runsQuerySchema.parse(req.query);
      const runs = await storage.listRuns(tenantId, limit);
      res.json({ runs, count: runs.length });
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid query parameters', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });

  /**
   * GET /runs/:id
   * One run with its counts and provenance, plus the evaluations in it —
   * collapsed to one per trace, exactly as a comparison counts them, so a
   * reader of this route and a reader of compare_runs see the same n.
   */
  router.get('/runs/:id', async (req, res) => {
    const tenantId = requireTenant(req);
    const run = await storage.getRun(tenantId, req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    const results = await storage.getRunResults(tenantId, req.params.id);
    res.json({ run, results });
  });

  /**
   * GET /cases/:key
   * Every attempt at one case, across runs. Not collapsed: the repetition
   * IS the measurement here, which is the whole difference between this
   * route and the one above.
   */
  router.get('/cases/:key', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const { run } = caseQuerySchema.parse(req.query);
      const attempts = await storage.getCaseResults(tenantId, { caseKey: req.params.key, run });
      if (attempts.length === 0) {
        res.status(404).json({ error: 'No evaluations carry that case key' });
        return;
      }
      const passed = attempts.filter((a) => a.passed).length;
      res.json({
        caseKey: req.params.key,
        attempts: attempts.length,
        passed,
        // Answered both ways across its attempts — the signal a single run
        // cannot produce, and the reason this route exists at all.
        flaky: passed > 0 && passed < attempts.length,
        runs: [...new Set(attempts.map((a) => a.runId).filter((v): v is string => v !== null))].sort(),
        results: attempts,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid query parameters', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });
}
