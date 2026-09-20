/*
 * Labels on the user's own traffic (arc 7, D-8; plan §4.13).
 *
 *   POST /labels                         — label one rule's FIRE on one evaluation right or wrong
 *   GET  /labels?eval_id=                — the labels on one evaluation
 *   GET  /labels/stats                   — per rule: labels, local precision, whether it is in force; the estimated prior; what to label next
 *   GET  /issues                         — fires grouped by (rule, evidence signature) over the recent window
 *   POST /evaluations/:id/reevaluate     — score a stored evaluation's trace again under the engine as it stands now
 *
 * A label is written on a fire and nothing else: a rule that did not fire
 * on an evaluation has no fire to be right or wrong about, and a label on
 * a quiet rule would be a claim about recall that nothing here can check.
 * That is why every surface says "local precision".
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { IStorageAdapter } from '../../types/query.js';
import type { EvalType } from '../../types/eval.js';
import type { TenantId } from '../../types/tenant.js';
import type { EvalEngine } from '../../eval/engine.js';
import { requireTenant } from '../../middleware/tenant.js';
import { strictBody } from '../validation.js';
import { LOCAL_LABEL_MIN, LOCAL_LABEL_WINDOW, localPrecision } from '../../eval/labels.js';
import { buildLocalLabelSource, builtInKindOf, refreshLocalLabels, type LocalLabelSource } from '../../eval/local-labels.js';
import { publishedAccuracyFor } from '../../eval/accuracy.js';
import { builtInRules } from '../../eval/criticality.js';
import { costHistoryFor } from '../../eval/ingest.js';
import { toEvaluationResponse } from '../../eval/response.js';
import { insertLinkedEvalResult } from '../../tools/trace-link.js';

const LabelBody = strictBody({
  eval_id: z.string().min(1).max(200),
  rule: z.string().min(1).max(80),
  label: z.enum(['right', 'wrong']),
  note: z.string().max(500).optional(),
});

const LabelsQuery = z.object({ eval_id: z.string().min(1).max(200) });
const IssuesQuery = z.object({
  rule: z.string().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export interface LabelStatsRow {
  rule: string;
  kind: string | null;
  /** Whether this rule's fires enter the risk estimate, so its labels can move a verdict. */
  entersRisk: boolean;
  n: number;
  right: number;
  wrong: number;
  precision: { point: number; lo: number; hi: number } | null;
  /** True at LOCAL_LABEL_MIN labels: the rule's number on this deployment is its own. */
  local: boolean;
  publishedPrecision: number | null;
  fireRate: number | null;
}

export interface LabelStats {
  rules: LabelStatsRow[];
  min: number;
  window: number;
  estimatedPrior: LocalLabelSource['estimatedPrior'];
  suggestion: LocalLabelSource['suggestion'];
  refreshedAt: string;
}

function statsOf(source: LocalLabelSource): LabelStats {
  const names = new Set<string>([...builtInRules().map((r) => r.name), ...source.precision.keys(), ...source.fireRates.keys()]);
  const rules: LabelStatsRow[] = [...names].sort().map((rule) => {
    const p = source.precision.get(rule) ?? localPrecision({ ruleName: rule, right: 0, wrong: 0 });
    const kind = builtInKindOf(rule) ?? null;
    return {
      rule,
      kind,
      entersRisk: kind === 'detection' || kind === 'inference',
      n: p.n,
      right: p.right,
      wrong: p.wrong,
      precision: p.precision,
      local: p.local,
      publishedPrecision: publishedAccuracyFor(rule)?.precision ?? null,
      fireRate: source.fireRates.get(rule) ?? null,
    };
  });
  return { rules, min: LOCAL_LABEL_MIN, window: LOCAL_LABEL_WINDOW, estimatedPrior: source.estimatedPrior, suggestion: source.suggestion, refreshedAt: source.refreshedAt };
}

export function registerLabelRoutes(router: Router, storage: IStorageAdapter, options: { evalEngine?: EvalEngine } = {}): void {
  const engine = options.evalEngine;
  const refresh = (tenantId: TenantId): Promise<LocalLabelSource> =>
    engine ? refreshLocalLabels(engine, storage, tenantId) : buildLocalLabelSource(storage, tenantId);

  router.post('/labels', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const body = LabelBody.parse(req.body);
      const evaluation = await storage.getEvalById(tenantId, body.eval_id);
      if (!evaluation) {
        res.status(404).json({ error: 'Evaluation not found' });
        return;
      }
      const row = evaluation.rule_results.find((r) => r.ruleName === body.rule);
      if (!row) {
        res.status(400).json({ error: `${body.rule} did not run on this evaluation, so there is no result to label.` });
        return;
      }
      if (row.skipped === true || row.passed !== false) {
        res.status(400).json({
          error: `${body.rule} did not fire on this evaluation. Labels are written on fires, so they measure precision only — a quiet rule has nothing here to be right or wrong about.`,
        });
        return;
      }
      const label = await storage.insertVerdictLabel(tenantId, {
        id: `label_${randomUUID()}`,
        evalId: body.eval_id,
        ruleName: body.rule,
        label: body.label,
        note: body.note ?? null,
      });
      const source = await refresh(tenantId);
      const stats = statsOf(source);
      res.status(201).json({ label, rule: stats.rules.find((r) => r.rule === body.rule) ?? null, min: LOCAL_LABEL_MIN, estimatedPrior: stats.estimatedPrior, suggestion: stats.suggestion });
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid request body', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });

  router.get('/labels', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const query = LabelsQuery.parse(req.query);
      const labels = await storage.getLabelsForEval(tenantId, query.eval_id);
      res.json({ labels });
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid query parameters', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });

  router.get('/labels/stats', async (req, res) => {
    const tenantId = requireTenant(req);
    // Rebuilt from storage on every read and installed on the engine, so the
    // panel and the verdicts read one source even after the store changed
    // underneath a running server (a reset, a restore).
    res.json(statsOf(await refresh(tenantId)));
  });

  router.get('/issues', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const query = IssuesQuery.parse(req.query);
      const issues = await storage.listIssues(tenantId, LOCAL_LABEL_WINDOW, { rule: query.rule, limit: query.limit });
      res.json({ issues, window: LOCAL_LABEL_WINDOW });
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid query parameters', details: (err as unknown as { issues: unknown }).issues });
        return;
      }
      throw err;
    }
  });

  /*
   * Re-score one stored evaluation's trace under the engine as it stands
   * now — the same rules, the deployment's own labels, the prior in force.
   * The earlier row is KEPT and the new one names it in
   * provenance.supersedes: the change between them is the finding, and a
   * row that overwrote its predecessor would have destroyed it. Every
   * newest-per-trace reader (a run's results, a comparison) sees the new
   * verdict from here on, which is what re-scoring is for.
   */
  router.post('/evaluations/:id/reevaluate', async (req, res) => {
    const tenantId = requireTenant(req);
    if (!engine) {
      res.status(503).json({ error: 'Re-evaluation needs the evaluation engine, which this dashboard was started without.' });
      return;
    }
    const before = await storage.getEvalById(tenantId, req.params.id);
    if (!before) {
      res.status(404).json({ error: 'Evaluation not found' });
      return;
    }
    if (!before.trace_id) {
      res.status(409).json({ error: 'This evaluation is not linked to a stored trace, so there is nothing to re-score. Evaluations made from a stored trace can be re-scored; one made from bare text cannot.' });
      return;
    }
    const trace = await storage.getTrace(tenantId, before.trace_id);
    if (!trace) {
      res.status(409).json({ error: 'The trace this evaluation scored has been deleted, so it cannot be re-scored.' });
      return;
    }
    if (trace.output === undefined || trace.output === null || trace.output === '') {
      res.status(409).json({ error: 'The trace recorded no output, so there is nothing to score.' });
      return;
    }
    // Spans only when the trace carried no tool_calls — the step layer's precedence is whole-source (evaluate_runs does the same).
    const spans = trace.tool_calls === undefined || trace.tool_calls.length === 0 ? await storage.getSpansByTraceId(tenantId, trace.trace_id) : undefined;
    const context = {
      output: trace.output,
      input: trace.input,
      expected: before.expected_text,
      costUsd: trace.cost_usd,
      costHistory: await costHistoryFor(storage, tenantId, trace),
      tokenUsage: trace.token_usage,
      toolCalls: trace.tool_calls,
      spans,
      tools: trace.tools,
    };
    const result = before.eval_type === 'all' ? await engine.evaluateAll(context) : await engine.evaluate(before.eval_type as EvalType, context);
    result.trace_id = trace.trace_id;
    if (result.provenance) result.provenance = { ...result.provenance, supersedes: before.id };
    await insertLinkedEvalResult(storage, tenantId, result);
    const verdictOf = (r: { verdict?: { state: string } | null; passed: boolean }): { verdict: string | null; passed: boolean } => ({ verdict: r.verdict?.state ?? null, passed: r.passed });
    const was = verdictOf(before);
    const now = verdictOf(result);
    res.status(201).json({
      evaluation: toEvaluationResponse(result, { traceId: trace.trace_id }),
      supersedes: before.id,
      before: was,
      after: now,
      changed: was.verdict !== now.verdict || was.passed !== now.passed,
    });
  });
}
