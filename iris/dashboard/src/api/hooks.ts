import { useState, useEffect, useCallback } from 'react';
import { api } from './client';
import { usePolling } from '../hooks/usePolling';
import type {
  TraceQueryResult,
  TraceDetail,
  DashboardSummary,
  FilterOptions,
  EvalQueryResult,
} from './types';

function useApiData<T>(fetcher: () => Promise<T>, pollInterval?: number) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const result = await fetcher();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  usePolling(fetchData, pollInterval);

  return { data, loading, error, refetch: fetchData };
}

export function useTraces(params?: Record<string, string>) {
  const fetcher = useCallback(() => api.getTraces(params), [JSON.stringify(params)]);
  return useApiData<TraceQueryResult>(fetcher, 5000);
}

export function useTraceDetail(traceId: string) {
  const fetcher = useCallback(() => api.getTraceDetail(traceId), [traceId]);
  return useApiData<TraceDetail>(fetcher);
}

export function useSummary(hours?: number) {
  const fetcher = useCallback(() => api.getSummary(hours), [hours]);
  return useApiData<DashboardSummary>(fetcher, 5000);
}

export function useFilters() {
  const fetcher = useCallback(() => api.getFilters(), []);
  return useApiData<FilterOptions>(fetcher, 30000);
}

export function useEvals(params?: Record<string, string>) {
  const fetcher = useCallback(() => api.getEvaluations(params), [JSON.stringify(params)]);
  return useApiData<EvalQueryResult>(fetcher, 5000);
}
