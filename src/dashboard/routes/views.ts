/*
 * Views — five named questions over an allowlist (arc 8, R-9).
 *
 *   GET /api/v1/views                 the five names and what each answers
 *   GET /api/v1/views/:name           one view, parameterised
 *
 * An org reader's questions are few and the same every week: which rules
 * fail most, what each agent costs, which cases answer both ways, which
 * questions the rules could not judge, where a stream crossed its line.
 * Each is one read over the existing storage methods and the existing
 * statistics — nothing here computes a number the tools do not, and no
 * caller text reaches a SQL expression: the name is matched against a
 * closed list, every parameter is a closed enum or a bounded number, and
 * an unknown name is 404 while a parameter outside its range is 400.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { IStorageAdapter, EvalStatsPeriod } from '../../types/query.js';
import type { TenantId } from '../../types/tenant.js';
import { requireTenant } from '../../middleware/tenant.js';
import { regressionAlarms, describeRegressionAlarm } from '../../eval/cusum.js';
import { deriveCoverage } from '../../eval/verdict.js';

export const VIEW_NAMES = ['failures_by_rule', 'cost_by_agent', 'flaky_cases', 'unjudged_questions', 'regression_alarms'] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

export const VIEW_DESCRIPTIONS: Record<ViewName, string> = {
  failures_by_rule: 'Which rules fail most in the period — failed, evaluated and pass rate per rule, worst first.',
  cost_by_agent: 'What each agent cost in the period — traces, costed traces, total, average and maximum cost, most expensive first.',
  flaky_cases: 'Cases answered both ways — attempts, passes, rate and the runs involved, least reliable first; min_attempts hides one-offs.',
  unjudged_questions: 'Per question, how many evaluations in the period the rules could not judge, and the reasons named most.',
  regression_alarms: 'Where an agent’s stream crossed its CUSUM line — the rule, the run, the trace, the baseline and the monitored counts.',
};

const PERIODS = ['24h', '2d', '7d', '14d', '30d', '60d', '90d', '180d', 'all'] as const;
const PERIOD_DAYS: Record<(typeof PERIODS)[number], number | null> = { '24h': 1, '2d': 2, '7d': 7, '14d': 14, '30d': 30, '60d': 60, '90d': 90, '180d': 180, all: null };

/** How many evaluations unjudged_questions scans in one read; the response says when the period held more. */
export const UNJUDGED_SCAN_CAP = 2000;
/** How many agents regression_alarms walks when none is named. */
export const ALARM_AGENT_CAP = 200;

const viewQuerySchema = z
  .object({
    period: z.enum(PERIODS).default('7d'),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    run: z.string().trim().min(1).max(200).optional(),
    agent: z.string().trim().min(1).max(200).optional(),
    min_attempts: z.coerce.number().int().min(1).max(1000).default(2),
  })
  .strict();
export type ViewQuery = z.infer<typeof viewQuerySchema>;

function sinceOf(period: ViewQuery['period'], now = Date.now()): string | null {
  const days = PERIOD_DAYS[period];
  return days === null ? null : new Date(now - days * 86_400_000).toISOString();
}

export interface ViewResult {
  rows: Array<Record<string, unknown>>;
  /** What the view could say about its own reach — a scan cap reached, agents walked. */
  note?: string;
}

type View = (storage: IStorageAdapter, tenantId: TenantId, q: ViewQuery) => Promise<ViewResult>;

const failuresByRule: View = async (storage, tenantId, q) => {
  const rows = await storage.getEvalStatsRules(tenantId, q.period as EvalStatsPeriod);
  return {
    rows: rows
      .filter((r) => r.failCount > 0)
      .sort((a, b) => b.failCount - a.failCount || a.rule.localeCompare(b.rule))
      .slice(0, q.limit)
      .map((r) => ({ rule: r.rule, failed: r.failCount, evaluated: r.totalRun, passRate: r.passRate })),
  };
};

const costByAgent: View = async (storage, tenantId, q) => {
  const rows = await storage.costByAgent(tenantId, sinceOf(q.period), q.limit);
  return { rows: rows.map((r) => ({ ...r })) };
};

const flakyCases: View = async (storage, tenantId, q) => {
  const results = await storage.getCaseResults(tenantId, q.run ? { run: q.run } : undefined);
  const grouped = new Map<string, { attempts: number; passed: number; runs: Set<string> }>();
  for (const r of results) {
    if (r.caseKey === null) continue;
    const g = grouped.get(r.caseKey) ?? { attempts: 0, passed: 0, runs: new Set<string>() };
    g.attempts += 1;
    if (r.passed) g.passed += 1;
    if (r.runId) g.runs.add(r.runId);
    grouped.set(r.caseKey, g);
  }
  const rows = [...grouped.entries()]
    .filter(([, g]) => g.attempts >= q.min_attempts && g.passed > 0 && g.passed < g.attempts)
    .map(([caseKey, g]) => ({ caseKey, attempts: g.attempts, passed: g.passed, rate: g.passed / g.attempts, runs: [...g.runs].sort() }))
    .sort((a, b) => a.rate - b.rate || a.caseKey.localeCompare(b.caseKey))
    .slice(0, q.limit);
  return { rows };
};

const unjudgedQuestions: View = async (storage, tenantId, q) => {
  const since = sinceOf(q.period);
  const { results, total } = await storage.queryEvalResults(tenantId, { ...(since ? { since } : {}), limit: UNJUDGED_SCAN_CAP, offset: 0 });
  const tally = new Map<string, { unjudged: number; judged: number; notApplicable: number; reasons: Map<string, number> }>();
  for (const result of results) {
    const coverage = result.coverage ?? deriveCoverage(result.rule_results);
    for (const question of coverage.questions) {
      const t = tally.get(question.id) ?? { unjudged: 0, judged: 0, notApplicable: 0, reasons: new Map<string, number>() };
      if (question.status === 'unjudged') {
        t.unjudged += 1;
        if (question.why) t.reasons.set(question.why, (t.reasons.get(question.why) ?? 0) + 1);
      } else if (question.status === 'judged') t.judged += 1;
      else t.notApplicable += 1;
      tally.set(question.id, t);
    }
  }
  const rows = [...tally.entries()]
    .map(([question, t]) => ({
      question,
      unjudged: t.unjudged,
      judged: t.judged,
      notApplicable: t.notApplicable,
      reasons: [...t.reasons.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 3)
        .map(([why, count]) => ({ why, count })),
    }))
    .sort((a, b) => b.unjudged - a.unjudged || a.question.localeCompare(b.question))
    .slice(0, q.limit);
  return {
    rows,
    note:
      total > results.length
        ? `scanned the ${results.length} most recent of ${total} evaluations in the period; narrow the period to cover them all`
        : `scanned ${results.length} evaluations`,
  };
};

const regressionAlarmsView: View = async (storage, tenantId, q) => {
  const agents = q.agent ? [q.agent] : (await storage.getDistinctValues(tenantId, 'agent_name')).slice(0, ALARM_AGENT_CAP);
  const rows: Array<Record<string, unknown>> = [];
  for (const agent of agents) {
    const log = await storage.getAgentFailureLog(tenantId, agent);
    // The stream watcher reads in timestamp order; the log is newest-first or oldest-first depending on the reader.
    const ordered = [...log].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    for (const alarm of regressionAlarms(ordered)) {
      if (q.run !== undefined && alarm.run !== q.run) continue;
      rows.push({
        agent,
        rule: alarm.rule,
        run: alarm.run,
        traceId: alarm.traceId,
        p0: alarm.p0,
        baselineN: alarm.baselineN,
        monitoredN: alarm.monitoredN,
        monitoredFails: alarm.monitoredFails,
        sentence: describeRegressionAlarm(alarm, agent),
      });
    }
  }
  rows.sort((a, b) => String(a.agent).localeCompare(String(b.agent)) || String(a.rule).localeCompare(String(b.rule)) || String(a.run ?? '').localeCompare(String(b.run ?? '')));
  return { rows: rows.slice(0, q.limit), note: `${agents.length} agent${agents.length === 1 ? '' : 's'} walked` };
};

export const VIEWS: Record<ViewName, View> = {
  failures_by_rule: failuresByRule,
  cost_by_agent: costByAgent,
  flaky_cases: flakyCases,
  unjudged_questions: unjudgedQuestions,
  regression_alarms: regressionAlarmsView,
};

export function registerViewRoutes(router: Router, storage: IStorageAdapter): void {
  router.get('/views', (_req, res) => {
    res.json({ views: VIEW_NAMES.map((name) => ({ name, answers: VIEW_DESCRIPTIONS[name], path: `/api/v1/views/${name}` })), count: VIEW_NAMES.length });
  });

  router.get('/views/:name', async (req, res) => {
    const name = req.params.name;
    if (!(VIEW_NAMES as readonly string[]).includes(name)) {
      res.status(404).json({ error: `No view is called "${name}"`, views: VIEW_NAMES });
      return;
    }
    try {
      const tenantId = requireTenant(req);
      const q = viewQuerySchema.parse(req.query);
      const { rows, note } = await VIEWS[name as ViewName](storage, tenantId, q);
      res.json({
        view: name,
        answers: VIEW_DESCRIPTIONS[name as ViewName],
        period: q.period,
        since: sinceOf(q.period),
        params: { limit: q.limit, ...(q.run ? { run: q.run } : {}), ...(q.agent ? { agent: q.agent } : {}), ...(name === 'flaky_cases' ? { min_attempts: q.min_attempts } : {}) },
        rows,
        count: rows.length,
        ...(note ? { note } : {}),
        generated_at: new Date().toISOString(),
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
