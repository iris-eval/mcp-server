import { useState, useMemo } from 'react';
import { useEvals } from '../../api/hooks';
import { EvalFilters } from './EvalFilters';
import { EvalTable } from './EvalTable';
import { EvalDetailCard } from './EvalDetailCard';
import { Pagination } from '../shared/Pagination';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import type { EvalResult } from '../../api/types';

export function EvalListPage() {
  const [filters, setFilters] = useState({ eval_type: '', passed: '' });
  const [offset, setOffset] = useState(0);
  const [selectedEval, setSelectedEval] = useState<EvalResult | null>(null);
  const limit = 50;

  const params = useMemo(() => {
    const p: Record<string, string> = { limit: String(limit), offset: String(offset) };
    if (filters.eval_type) p.eval_type = filters.eval_type;
    if (filters.passed) p.passed = filters.passed;
    return p;
  }, [filters, offset]);

  const { data, loading } = useEvals(params);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <h1 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700 }}>Evaluations</h1>
      <EvalFilters values={filters} onChange={(v) => { setFilters(v); setOffset(0); }} />

      <div style={{ display: 'flex', gap: 'var(--space-4)' }}>
        <div style={{ flex: 1, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius-lg)', overflow: 'hidden' }}>
          {loading && !data ? (
            <LoadingSpinner />
          ) : (
            <>
              <EvalTable
                evals={data?.results ?? []}
                onSelect={setSelectedEval}
              />
              {data && data.total > limit && (
                <div style={{ padding: '0 var(--space-4)' }}>
                  <Pagination total={data.total} limit={limit} offset={offset} onPageChange={setOffset} />
                </div>
              )}
            </>
          )}
        </div>

        {selectedEval && (
          <div style={{ width: '400px', flexShrink: 0 }}>
            <EvalDetailCard evalResult={selectedEval} />
          </div>
        )}
      </div>
    </div>
  );
}
