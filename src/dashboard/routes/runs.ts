import { Router } from 'express';
import { z } from 'zod';
import type { IStorageAdapter } from '../../types/query.js';
import { requireTenant } from '../../middleware/tenant.js';
import { runsQuerySchema, caseQuerySchema } from '../validation.js';
import { compareStoredRuns } from '../../tools/compare-runs.js';
import { IrisError } from '../../tools/errors.js';

/** The body of POST /compare: the compare_runs tool's input, and nothing the tool would not take. */
const compareBodySchema = z
  .object({
    /** Omitted: the run pinned as the baseline. */
    before: z.string().min(1).optional(),
    after: z.string().min(1),
    force: z.boolean().optional(),
    equivalence_margin: z.number().gt(0).lte(1).optional(),
    dataset: z.string().min(1).optional(),
  })
  .strict();

/** The body of PATCH /runs/:id: the one flag a run carries that is not derived. */
const baselineBodySchema = z.object({ baseline: z.boolean() }).strict();

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
   * PATCH /runs/:id
   * Pin a run as the baseline every later run is compared against, or
   * unpin it. One baseline per tenant: pinning another unpins the old one.
   * The one write on this router, and a flag rather than a run: a run is
   * still created by tagging traces with it.
   */
  router.patch('/runs/:id', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const body = baselineBodySchema.parse(req.body);
      const run = await storage.getRun(tenantId, req.params.id);
      if (!run) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      await storage.setRunBaseline(tenantId, req.params.id, body.baseline);
      res.json({ run_id: req.params.id, baseline: body.baseline });
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid request body', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });

  /**
   * GET /cases/:key
   * Every attempt at one case, across runs. Not collapsed: the repetition
   * IS the measurement here, which is the whole difference between this
   * route and the one above.
   */
  /*
   * POST /compare — the compare_runs tool's handler over HTTP,
   * for the dashboard's compare action and for a script that would rather
   * not speak MCP. One implementation, one shape: the body is the tool's
   * input, the answer is the tool's output.
   */
  router.post('/compare', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const body = compareBodySchema.parse(req.body);
      res.json(await compareStoredRuns(storage, tenantId, body));
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid request body', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      // An unknown dataset is the caller's argument, not a server fault.
      if (err instanceof IrisError && err.envelope.field === 'dataset') {
        res.status(404).json({ error: err.envelope.message });
        return;
      }
      // `before` omitted with no baseline pinned: the same, as a 400 that says how to pin one.
      if (err instanceof IrisError && err.envelope.field === 'before') {
        res.status(400).json({ error: err.envelope.message, recovery: err.envelope.recovery });
        return;
      }
      throw err;
    }
  });

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
