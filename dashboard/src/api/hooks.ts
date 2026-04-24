import { useState, useEffect, useCallback, useRef } from 'react';
import { api, RateLimitError } from './client';
import { usePolling } from '../hooks/usePolling';
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
  AuditQueryResult,
} from './types';

/**
 * Polling cadence presets — picks the default interval based on how
 * time-sensitive the data is. Per-view cadence is achieved by the hook
 * author picking the right preset, not by runtime route detection (which
 * would break the hook's co-location with its consumer).
 *
 * Cadence rationale (audit item #12):
 *   FAST   3s  — live-tail data: Stream view's trace feed
 *   NORMAL 10s — most dashboard reads: summary, rule breakdown, trend
 *   SLOW   30s — low-churn aggregations: filter options, audit log,
 *                deployed rules list
 *   NEVER  undefined — one-shot fetches: detail pages
 *
 * Previously most hooks polled at 5s which translated to 12 req/min per
 * data type on top of browser visibility gating. On a Pro tier with 100
 * req/min rate limit, a user with 3 open views would be rate-limited
 * before they did anything. The cadence here gives headroom.
 */
export const CADENCE = {
  FAST: 3000,
  NORMAL: 10000,
  SLOW: 30000,
} as const;

/**
 * Hook state augmented with rate-limit awareness (audit item #12).
 *
 * When a fetch returns 429, `useApiData` pauses polling until the
 * server's reset time, and surfaces `rateLimitedUntil` so the UI can
 * show a specific banner instead of a generic "Unknown error" message.
 */
export interface UseApiDataResult<T> {
  data: T | null;
  loading: boolean;
  /** Human-readable error message, or null if the last fetch was OK. */
  error: string | null;
  /**
   * Epoch-ms timestamp when the rate limit is expected to reset, or null.
   * While set, polling is paused. The value resets to null on the next
   * successful fetch or manual refetch.
   */
  rateLimitedUntil: number | null;
  refetch: () => Promise<void>;
}

function useApiData<T>(fetcher: () => Promise<T>, pollInterval?: number): UseApiDataResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number | null>(null);
  const resumeTimer = useRef<number | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const result = await fetcher();
      setData(result);
      setError(null);
      setRateLimitedUntil(null);
    } catch (err) {
      if (err instanceof RateLimitError) {
        const until = Date.now() + err.retryAfterMs;
        setRateLimitedUntil(until);
        setError(err.message);
        // Schedule auto-resume right after the window expires so the next
        // successful fetch clears the banner without user action.
        if (resumeTimer.current !== null) {
          window.clearTimeout(resumeTimer.current);
        }
        resumeTimer.current = window.setTimeout(() => {
          resumeTimer.current = null;
          setRateLimitedUntil(null);
        }, err.retryAfterMs + 100);
      } else {
        setError(err instanceof Error ? err.message : 'Unknown error');
      }
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    fetchData();
    return () => {
      if (resumeTimer.current !== null) {
        window.clearTimeout(resumeTimer.current);
        resumeTimer.current = null;
      }
    };
  }, [fetchData]);

  // While rate-limited, suppress polling entirely — the server already
  // told us how long to wait. Browser visibility gating inside usePolling
  // still applies.
  const activePollInterval = rateLimitedUntil ? undefined : pollInterval;
  usePolling(fetchData, activePollInterval);

  return { data, loading, error, rateLimitedUntil, refetch: fetchData };
}

export function useTraces(params?: Record<string, string>) {
  // Key by JSON-stringified params (semantic value) so callers can pass fresh
  // object literals without unnecessary refetches. params is captured in the
  // closure; paramsKey controls when the closure is recreated.
  const paramsKey = JSON.stringify(params);
  const fetcher = useCallback(
    () => api.getTraces(params),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- paramsKey is the semantic key
    [paramsKey],
  );
  return useApiData<TraceQueryResult>(fetcher, CADENCE.NORMAL);
}

export function useTraceDetail(traceId: string) {
  const fetcher = useCallback(() => api.getTraceDetail(traceId), [traceId]);
  return useApiData<TraceDetail>(fetcher);
}

export function useSummary(hours?: number) {
  const fetcher = useCallback(() => api.getSummary(hours), [hours]);
  return useApiData<DashboardSummary>(fetcher, CADENCE.NORMAL);
}

export function useFilters() {
  const fetcher = useCallback(() => api.getFilters(), []);
  return useApiData<FilterOptions>(fetcher, CADENCE.SLOW);
}

export function useEvals(params?: Record<string, string>) {
  const paramsKey = JSON.stringify(params);
  const fetcher = useCallback(
    () => api.getEvaluations(params),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- paramsKey is the semantic key
    [paramsKey],
  );
  return useApiData<EvalQueryResult>(fetcher, CADENCE.NORMAL);
}

export function useEvalStats(period?: string) {
  const fetcher = useCallback(() => api.getEvalStats(period), [period]);
  return useApiData<EvalStats>(fetcher, CADENCE.NORMAL);
}

export function useEvalTrend(period?: string) {
  const fetcher = useCallback(() => api.getEvalTrend(period), [period]);
  // Trend over 7d/30d/90d windows changes slowly — poll at SLOW cadence.
  return useApiData<EvalTrendPoint[]>(fetcher, CADENCE.SLOW);
}

export function useEvalRules() {
  const fetcher = useCallback(() => api.getEvalRules(), []);
  return useApiData<RuleBreakdown[]>(fetcher, CADENCE.NORMAL);
}

export function useEvalFailures(limit?: number) {
  const fetcher = useCallback(() => api.getEvalFailures(limit), [limit]);
  return useApiData<EvalFailure[]>(fetcher, CADENCE.NORMAL);
}

export function useMoments(params?: Record<string, string>) {
  const paramsKey = JSON.stringify(params);
  // Moments are the Stream view's live tail — keep this fast.
  const fetcher = useCallback(
    () => api.getMoments(params),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- paramsKey is the semantic key
    [paramsKey],
  );
  return useApiData<MomentQueryResult>(fetcher, CADENCE.FAST);
}

export function useMomentDetail(id: string) {
  const fetcher = useCallback(() => api.getMomentDetail(id), [id]);
  return useApiData<DecisionMomentDetail>(fetcher);
}

export function useCustomRules() {
  const fetcher = useCallback(() => api.getCustomRules().then((r) => r.rules), []);
  return useApiData<DeployedCustomRule[]>(fetcher, CADENCE.SLOW);
}

export function useAuditLog(params?: Record<string, string>) {
  const paramsKey = JSON.stringify(params);
  const fetcher = useCallback(
    () => api.getAuditLog(params),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- paramsKey is the semantic key
    [paramsKey],
  );
  return useApiData<AuditQueryResult>(fetcher, CADENCE.SLOW);
}
