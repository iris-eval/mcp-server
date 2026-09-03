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
  FailureQueryResult,
  DeployedCustomRule,
  DeployRuleRequest,
  RulePreviewRequest,
  RulePreviewResult,
  PreferencesEnvelope,
  PreferencesPatch,
  AuditQueryResult,
  BuiltInRuleMeta,
} from './types';

/**
 * Thrown when the server returns 429. Carries the reset time so pollers
 * can back off intelligently instead of hammering the endpoint.
 *
 * Source: RFC 9110 + draft-ietf-httpapi-ratelimit-headers. The Iris
 * dashboard API emits `RateLimit-Reset` (seconds until reset) and
 * `Retry-After` (seconds) — we prefer RateLimit-Reset when present.
 */
export class RateLimitError extends Error {
  readonly kind = 'rate-limit' as const;
  /** Milliseconds until the client should retry. Minimum 1 second. */
  readonly retryAfterMs: number;
  /** Policy label from `RateLimit-Policy`, e.g. "100;w=60". Optional. */
  readonly policy?: string;

  constructor(retryAfterMs: number, policy?: string) {
    super(`Rate limited — retry in ${Math.round(retryAfterMs / 1000)}s`);
    this.name = 'RateLimitError';
    this.retryAfterMs = Math.max(retryAfterMs, 1000);
    this.policy = policy;
  }
}

/** Parse RateLimit-Reset (preferred) or Retry-After into ms. */
function parseRetryAfter(res: Response): number {
  // RateLimit-Reset: seconds until reset (RFC draft)
  const reset = res.headers.get('ratelimit-reset');
  if (reset) {
    const n = Number.parseInt(reset, 10);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
  }
  // Retry-After: seconds OR HTTP-date (RFC 9110 §10.2.3)
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) {
    const n = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(date - Date.now(), 0);
  }
  return 30_000; // conservative 30s fallback
}

/*
 * A 401 from the API means the server has an --api-key and this browser
 * has no session for it (never signed in, or the server restarted and
 * dropped its in-memory sessions). The server renders a sign-in page for
 * any HTML navigation in that state, so the honest recovery is to reload:
 * the user lands on the sign-in form instead of a wall of "API error:
 * 401" tiles. Guarded because jsdom does not implement navigation.
 */
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
  const res = await fetch(url.toString());
  handleUnauthorized(res);
  if (res.status === 429) {
    throw new RateLimitError(
      parseRetryAfter(res),
      res.headers.get('ratelimit-policy') ?? undefined,
    );
  }
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
  const res = await fetch(url.toString(), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  handleUnauthorized(res);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API error: ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const url = new URL(path, window.location.origin);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  handleUnauthorized(res);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API error: ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }
  return res.json() as Promise<T>;
}

async function deleteRequest(path: string): Promise<void> {
  const url = new URL(path, window.location.origin);
  const res = await fetch(url.toString(), { method: 'DELETE' });
  handleUnauthorized(res);
  if (!res.ok && res.status !== 204) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
}
