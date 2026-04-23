import { API_BASE_URL } from '../utils/constants';
import type {
  TraceQueryResult,
  TraceDetail,
  DashboardSummary,
  FilterOptions,
  EvalQueryResult,
  EvalStats,
  EvalTrendPoint,
  RuleBreakdown,
  EvalFailure,
  MomentQueryResult,
  DecisionMomentDetail,
  DeployedCustomRule,
  DeployRuleRequest,
  RulePreviewRequest,
  RulePreviewResult,
} from './types';

async function fetchJson<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, value);
      }
    }
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getTraces(params?: Record<string, string>): Promise<TraceQueryResult> {
    return fetchJson<TraceQueryResult>(`${API_BASE_URL}/traces`, params);
  },

  getTraceDetail(traceId: string): Promise<TraceDetail> {
    return fetchJson<TraceDetail>(`${API_BASE_URL}/traces/${traceId}`);
  },

  getSummary(hours?: number): Promise<DashboardSummary> {
    return fetchJson<DashboardSummary>(`${API_BASE_URL}/summary`, hours ? { hours: String(hours) } : undefined);
  },

  getFilters(): Promise<FilterOptions> {
    return fetchJson<FilterOptions>(`${API_BASE_URL}/filters`);
  },

  getEvaluations(params?: Record<string, string>): Promise<EvalQueryResult> {
    return fetchJson<EvalQueryResult>(`${API_BASE_URL}/evaluations`, params);
  },

  getEvalStats(period?: string): Promise<EvalStats> {
    return fetchJson<EvalStats>(`${API_BASE_URL}/eval-stats`, period ? { period } : undefined);
  },

  getEvalTrend(period?: string): Promise<EvalTrendPoint[]> {
    return fetchJson<EvalTrendPoint[]>(`${API_BASE_URL}/eval-stats/trend`, period ? { period } : undefined);
  },

  getEvalRules(): Promise<RuleBreakdown[]> {
    return fetchJson<RuleBreakdown[]>(`${API_BASE_URL}/eval-stats/rules`);
  },

  getEvalFailures(limit?: number): Promise<EvalFailure[]> {
    return fetchJson<EvalFailure[]>(`${API_BASE_URL}/eval-stats/failures`, limit ? { limit: String(limit) } : undefined);
  },

  getMoments(params?: Record<string, string>): Promise<MomentQueryResult> {
    return fetchJson<MomentQueryResult>(`${API_BASE_URL}/moments`, params);
  },

  getMomentDetail(id: string): Promise<DecisionMomentDetail> {
    return fetchJson<DecisionMomentDetail>(`${API_BASE_URL}/moments/${id}`);
  },

  getCustomRules(): Promise<{ rules: DeployedCustomRule[] }> {
    return fetchJson<{ rules: DeployedCustomRule[] }>(`${API_BASE_URL}/rules/custom`);
  },

  deployCustomRule(req: DeployRuleRequest): Promise<{ rule: DeployedCustomRule }> {
    return postJson<{ rule: DeployedCustomRule }>(`${API_BASE_URL}/rules/custom`, req);
  },

  deleteCustomRule(id: string): Promise<void> {
    return deleteRequest(`${API_BASE_URL}/rules/custom/${id}`);
  },

  previewCustomRule(req: RulePreviewRequest): Promise<RulePreviewResult> {
    return postJson<RulePreviewResult>(`${API_BASE_URL}/rules/custom/preview`, req);
  },
};

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const url = new URL(path, window.location.origin);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API error: ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }
  return res.json() as Promise<T>;
}

async function deleteRequest(path: string): Promise<void> {
  const url = new URL(path, window.location.origin);
  const res = await fetch(url.toString(), { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
}
