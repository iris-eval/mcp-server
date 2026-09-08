import { API_BASE_URL } from '../utils/constants';
import { networkError, toApiError } from './errors';
import { reportConnection } from './connection';
import type {
  DriftComparison,
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
  FailureQueryResult,
  DeployedCustomRule,
  DeployRuleRequest,
  RulePreviewRequest,
  RulePreviewResult,
  PreferencesEnvelope,
  PreferencesPatch,
  AuditQueryResult,
  BuiltInRuleMeta,
  HealthResponse,
  CapabilitiesSummary,
} from './types';

/**
 * Thrown when the server returns 429. Carries the reset time so pollers
 * can back off intelligently instead of hammering the endpoint.
 *
 * Source: RFC 9110 + draft-ietf-httpapi-ratelimit-headers. The Iris
 * dashboard API emits `RateLimit-Reset` (seconds until reset) and
 * `Retry-After` (seconds) — we prefer RateLimit-Reset when present.
 */
/*
 * The typed error model lives in ./errors (D-1); RateLimitError is
 * re-exported so the code that has imported it from here since 0.5 keeps
 * working. Every throw below is an ApiError with a kind.
 */
export { ApiError, RateLimitError } from './errors';
export type { ApiErrorKind } from './errors';

function handleUnauthorized(res: Response): void {
  if (res.status !== 401) return;
  try {
    if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
      window.location.reload();
    }
  } catch {
    // Non-browser environment — the thrown API error below still surfaces.
  }
}

async function fetchJson<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, value);
      }
    }
  }
  let res: Response;
  try {
    res = await fetch(url.toString());
  } catch (err) {
    reportConnection('unreachable');
    throw networkError(path, err);
  }
  reportConnection(res.status === 401 || res.status === 403 ? 'signed-out' : 'connected');
  handleUnauthorized(res);
  if (!res.ok) throw await toApiError(res, path);
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

  /**
   * The health poll (D-2). Unauthenticated by design; the server answers 503
   * with a body when its storage is down, and that body is the answer the
   * header renders ("degraded"), not an error.
   */
  async getHealth(): Promise<HealthResponse> {
    const path = `${API_BASE_URL}/health`;
    let res: Response;
    try {
      res = await fetch(new URL(path, window.location.origin).toString());
    } catch (err) {
      reportConnection('unreachable');
      throw networkError(path, err);
    }
    reportConnection('connected');
    if (res.ok || res.status === 503) return res.json() as Promise<HealthResponse>;
    throw await toApiError(res, path);
  },

  /** Read once by the shell: the judge's enable steps and the retention window (D-2). */
  getCapabilities(): Promise<CapabilitiesSummary> {
    return fetchJson<CapabilitiesSummary>(`${API_BASE_URL}/capabilities`);
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

  getDrift(params?: Record<string, string>): Promise<DriftComparison> {
    return fetchJson<DriftComparison>(`${API_BASE_URL}/eval-stats/drift`, params);
  },

  getMoments(params?: Record<string, string>): Promise<MomentQueryResult> {
    return fetchJson<MomentQueryResult>(`${API_BASE_URL}/moments`, params);
  },

  getMomentDetail(id: string): Promise<DecisionMomentDetail> {
    return fetchJson<DecisionMomentDetail>(`${API_BASE_URL}/moments/${id}`);
  },

  getFailures(params?: Record<string, string>): Promise<FailureQueryResult> {
    return fetchJson<FailureQueryResult>(`${API_BASE_URL}/failures`, params);
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

  /** Enable/disable a deployed rule in place — it stops (or resumes) firing on the next evaluation. */
  setCustomRuleEnabled(id: string, enabled: boolean): Promise<{ rule: DeployedCustomRule }> {
    return patchJson<{ rule: DeployedCustomRule }>(`${API_BASE_URL}/rules/custom/${id}`, { enabled });
  },

  getBuiltInRules(): Promise<{ rules: BuiltInRuleMeta[] }> {
    return fetchJson<{ rules: BuiltInRuleMeta[] }>(`${API_BASE_URL}/rules/builtin`);
  },

  previewCustomRule(req: RulePreviewRequest): Promise<RulePreviewResult> {
    return postJson<RulePreviewResult>(`${API_BASE_URL}/rules/custom/preview`, req);
  },

  getPreferences(): Promise<PreferencesEnvelope> {
    return fetchJson<PreferencesEnvelope>(`${API_BASE_URL}/preferences`);
  },

  patchPreferences(patch: PreferencesPatch): Promise<PreferencesEnvelope> {
    return patchJson<PreferencesEnvelope>(`${API_BASE_URL}/preferences`, patch);
  },

  getAuditLog(params?: Record<string, string>): Promise<AuditQueryResult> {
    return fetchJson<AuditQueryResult>(`${API_BASE_URL}/audit`, params);
  },
};

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const url = new URL(path, window.location.origin);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    reportConnection('unreachable');
    throw networkError(path, err);
  }
  reportConnection(res.status === 401 || res.status === 403 ? 'signed-out' : 'connected');
  handleUnauthorized(res);
  if (!res.ok) throw await toApiError(res, path);
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const url = new URL(path, window.location.origin);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    reportConnection('unreachable');
    throw networkError(path, err);
  }
  reportConnection(res.status === 401 || res.status === 403 ? 'signed-out' : 'connected');
  handleUnauthorized(res);
  if (!res.ok) throw await toApiError(res, path);
  return res.json() as Promise<T>;
}

async function deleteRequest(path: string): Promise<void> {
  const url = new URL(path, window.location.origin);
  let res: Response;
  try {
    res = await fetch(url.toString(), { method: 'DELETE' });
  } catch (err) {
    reportConnection('unreachable');
    throw networkError(path, err);
  }
  reportConnection(res.status === 401 || res.status === 403 ? 'signed-out' : 'connected');
  handleUnauthorized(res);
  if (!res.ok && res.status !== 204) throw await toApiError(res, path);
}
