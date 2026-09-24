/*
 * What a stored evaluation says that is worth a message.
 *
 * One evaluation can be several moments — a vetoed verdict is also a failed
 * one, a cost outlier can also cross a CUSUM line — so this reads them all
 * and lets the subscription and the cooldown decide. Each moment carries
 * ids, the verdict, the rules and the numbers, and never the text: an
 * evaluation's output goes off-box only when the receiver fetches the trace
 * by id, through the same door and the same key as any other read. That is
 * the same stance the engine's log event takes ("never the text, never a
 * key"), and what the incumbents' payloads do.
 *
 * Two of the five are transitions the store must be asked about after the
 * row is written: a regression alarm is raised AT the evaluation that
 * crossed the line, over the agent's whole log; a flaky case is the first
 * attempt that disagreed with every earlier one.
 */
import type { EvalResult, EvalRuleResult } from '../types/eval.js';
import type { IStorageAdapter } from '../types/query.js';
import type { TenantId } from '../types/tenant.js';
import { describeRegressionAlarm, regressionAlarmsAt } from '../eval/cusum.js';
import type { WebhookEventName } from './event-names.js';

export interface WebhookMoment {
  event: WebhookEventName;
  /** The second half of the cooldown key: the rule that decided, the alarm's rule, the case. */
  subject: string;
  /** One sentence, the one a Slack line shows. */
  summary: string;
  evaluation_id: string;
  trace_id: string | null;
  agent_name: string | null;
  run_id: string | null;
  case_key: string | null;
  /** The conversation the trace belongs to, when it carries one. */
  session_id: string | null;
  /** When the evaluation was stored (ISO-8601). */
  evaluated_at: string;
  verdict: { state: 'pass' | 'fail' | 'unknown'; basis: string; by: string[] } | null;
  score: number;
  /** Rules that ran and failed, sorted; skips excluded. */
  failed_rules: string[];
  critical_failures: string[];
  /** The event's own numbers — the alarm, the anomaly, the case's tally. */
  detail: Record<string, unknown>;
}

/** The reads the detector needs; `IStorageAdapter` satisfies it. */
export type MomentSource = Pick<IStorageAdapter, 'getTrace' | 'getAgentFailureLog' | 'getCaseResults'>;

const fired = (r: EvalRuleResult): boolean => !r.passed && !r.skipped;

/**
 * Every moment this evaluation is, among `wanted`. Reads the trace once;
 * reads the agent's log only when a regression alarm is wanted, the case's
 * attempts only when a flaky case is.
 */
export async function momentsOf(storage: MomentSource, tenantId: TenantId, result: EvalResult, wanted: ReadonlySet<WebhookEventName>): Promise<WebhookMoment[]> {
  if (wanted.size === 0) return [];
  const trace = result.trace_id ? await storage.getTrace(tenantId, result.trace_id) : null;
  const agent = trace?.agent_name ?? null;
  const failed = result.rule_results
    .filter(fired)
    .map((r) => r.ruleName)
    .sort();
  const verdict = result.verdict ? { state: result.verdict.state, basis: result.verdict.basis, by: [...result.verdict.by] } : null;
  const base = {
    evaluation_id: result.id,
    trace_id: result.trace_id ?? null,
    agent_name: agent,
    run_id: result.run_id ?? trace?.run_id ?? null,
    case_key: trace?.case_key ?? null,
    session_id: trace?.session_id ?? null,
    evaluated_at: result.created_at ?? new Date().toISOString(),
    verdict,
    score: result.score,
    failed_rules: failed,
    critical_failures: [...(result.critical_failures ?? [])],
  };
  const who = agent ?? 'an agent';
  const out: WebhookMoment[] = [];

  const failedVerdict = verdict ? verdict.state === 'fail' : !result.passed;
  if (wanted.has('verdict_fail') && failedVerdict) {
    const by = verdict?.by ?? failed;
    out.push({
      ...base,
      event: 'verdict_fail',
      subject: by[0] ?? verdict?.basis ?? 'verdict',
      summary: `${who}: the verdict failed${verdict ? ` on ${verdict.basis.replace(/_/g, ' ')}` : ''}${by.length > 0 ? ` — ${by.join(', ')}` : ''}.`,
      detail: { basis: verdict?.basis ?? null, by, score: result.score },
    });
  }

  if (wanted.has('detector_veto') && verdict?.basis === 'detector_veto') {
    out.push({
      ...base,
      event: 'detector_veto',
      subject: verdict.by[0] ?? 'detector',
      summary: `${who}: a critical detection vetoed the verdict — ${verdict.by.join(', ')}.`,
      detail: { by: verdict.by, critical_failures: base.critical_failures },
    });
  }

  if (wanted.has('cost_anomaly')) {
    const anomaly = result.rule_results.find((r) => r.ruleName === 'cost_anomaly' && fired(r));
    if (anomaly) {
      const z = anomaly.evidence?.find((e) => e.type === 'count' && e.stat === 'modified_z');
      out.push({
        ...base,
        event: 'cost_anomaly',
        subject: 'cost_anomaly',
        summary: anomaly.message,
        detail: {
          cost_usd: anomaly.value?.value ?? trace?.cost_usd ?? null,
          modified_z: z && 'value' in z ? z.value : null,
          threshold: z && 'threshold' in z ? z.threshold : null,
        },
      });
    }
  }

  if (wanted.has('regression_alarm') && trace && agent) {
    const log = await storage.getAgentFailureLog(tenantId, agent);
    for (const alarm of regressionAlarmsAt(log, trace.trace_id, trace.timestamp)) {
      out.push({
        ...base,
        event: 'regression_alarm',
        subject: alarm.run === null ? alarm.rule : `${alarm.rule}@${alarm.run}`,
        summary: describeRegressionAlarm(alarm, agent),
        detail: { ...alarm },
      });
    }
  }

  if (wanted.has('flaky_case') && base.case_key) {
    const rows = await storage.getCaseResults(tenantId, { caseKey: base.case_key });
    const prior = rows.filter((r) => r.evalId !== result.id);
    const mine = rows.find((r) => r.evalId === result.id);
    const answer = mine ? mine.passed : result.passed;
    if (prior.length > 0 && prior.every((p) => p.passed === prior[0].passed) && prior[0].passed !== answer) {
      const attempts = prior.length + 1;
      const passed = prior.filter((p) => p.passed).length + (answer ? 1 : 0);
      const runs = [...new Set(rows.map((r) => r.runId).filter((r): r is string => r !== null))].sort();
      out.push({
        ...base,
        event: 'flaky_case',
        subject: base.case_key,
        summary: `${who}: case ${base.case_key} was answered both ways for the first time — ${passed} of ${attempts} attempts passed${runs.length > 0 ? ` across ${runs.join(', ')}` : ''}.`,
        detail: { case_key: base.case_key, attempts, passed, runs, this_attempt_passed: answer },
      });
    }
  }

  return out;
}
