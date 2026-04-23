/*
 * drillThrough — single source of truth for chart→Moments / chart→Audit URLs.
 *
 * Every BI chart that supports click-through MUST go through this module.
 * Ad-hoc URL building is forbidden — if a new destination is needed, add a
 * function here so the URL contract stays in one place.
 *
 * Why this exists: in BI dashboards, every visual is a question and every
 * click is the answer. The donut "show me the failures" only works if a
 * click on the fail slice lands on /moments?verdict=fail filtered correctly.
 * If each chart builds its own URL, drift creeps in (one uses ?agent, the
 * next uses ?agent_name) and the contract rots.
 *
 * Filter param naming follows MomentsTimelinePage URL conventions:
 *   - agent (NOT agent_name — front-end strips _name; server takes it)
 *   - verdict
 *   - kind   (NOT significance_kind — front-end short form)
 *   - since  (ISO 8601 with offset, e.g. 2026-04-01T00:00:00.000Z)
 *   - until  (same)
 *
 * The Moments API supports more params (min_significance, etc.) but charts
 * shouldn't need them — drill-through stays high-level.
 */
import type {
  MomentVerdict,
  MomentSignificanceKind,
} from '../api/types';

export interface DrillToMomentsParams {
  agent?: string;
  verdict?: MomentVerdict;
  /** Significance kind (e.g. "safety-violation"). */
  kind?: MomentSignificanceKind;
  /** Lower bound of time window, ISO 8601. */
  since?: string;
  /** Upper bound of time window, ISO 8601. */
  until?: string;
}

export interface DrillToAuditParams {
  /** Highlight a specific audit entry on landing. */
  focus?: string;
  /** Filter to a single rule's history. */
  ruleId?: string;
  /** Lower bound on entry timestamp. */
  since?: string;
}

/**
 * Build a /moments URL with query params from chart-click context.
 * Empty/undefined values are stripped so URLs stay clean.
 */
export function drillToMoments(params: DrillToMomentsParams): string {
  const search = new URLSearchParams();
  if (params.agent) search.set('agent', params.agent);
  if (params.verdict) search.set('verdict', params.verdict);
  if (params.kind) search.set('kind', params.kind);
  if (params.since) search.set('since', params.since);
  if (params.until) search.set('until', params.until);
  const qs = search.toString();
  return qs ? `/moments?${qs}` : '/moments';
}

/** Build an /audit URL for a single entry or rule history. */
export function drillToAudit(params: DrillToAuditParams): string {
  const search = new URLSearchParams();
  if (params.focus) search.set('focus', params.focus);
  if (params.ruleId) search.set('rule', params.ruleId);
  if (params.since) search.set('since', params.since);
  const qs = search.toString();
  return qs ? `/audit?${qs}` : '/audit';
}

/**
 * Convenience: get an ISO timestamp `n` days ago, normalized to start of
 * day. Used by chart period selectors so since/until always align.
 */
export function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}
