import { useState, useMemo } from 'react';
import { useEvals } from '../../api/hooks';
import { api } from '../../api/client';
import { EvalFilters } from './EvalFilters';
import { EvalTable } from './EvalTable';
import { EvalDetailCard } from './EvalDetailCard';
import { Pagination } from '../shared/Pagination';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { ExportButton } from '../shared/ExportButton';
import type { EvalResult } from '../../api/types';

export function EvalListPage() {
  const [filters, setFilters] = useState({ eval_type: '', passed: '', since: '', until: '' });
  const [offset, setOffset] = useState(0);
  const [selectedEval, setSelectedEval] = useState<EvalResult | null>(null);
  const limit = 50;

  const params = useMemo(() => {
    const p: Record<string, string> = { limit: String(limit), offset: String(offset) };
    if (filters.eval_type) p.eval_type = filters.eval_type;
    if (filters.passed) p.passed = filters.passed;
    if (filters.since) p.since = new Date(filters.since).toISOString();
    if (filters.until) p.until = new Date(filters.until).toISOString();
    return p;
  }, [filters, offset]);

  const filterParams = useMemo(() => {
    const p: Record<string, string> = { limit: '1000' };
    if (filters.eval_type) p.eval_type = filters.eval_type;
    if (filters.passed) p.passed = filters.passed;
    if (filters.since) p.since = new Date(filters.since).toISOString();
    if (filters.until) p.until = new Date(filters.until).toISOString();
    return p;
  }, [filters]);

  const { data, loading } = useEvals(params);

  function handleExport(format: 'csv' | 'json') {
    const url = api.getEvaluationsExportUrl({ ...filterParams, format });
    window.open(url, '_blank');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700 }}>Evaluations</h1>
        <ExportButton onExport={handleExport} />
      </div>
      <EvalFilters values={filters} onChange={(v) => { setFilters(v); setOffset(0); }} />

      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius-lg)', overflow: 'hidden' }}>
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

      {/* Modal overlay for eval detail */}
      {selectedEval && (
        <div
          onClick={() => setSelectedEval(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: '500px', maxHeight: '80vh', overflow: 'auto', position: 'relative' }}
          >
            <button
              onClick={() => setSelectedEval(null)}
              style={{
                position: 'absolute',
                top: 8,
                right: 8,
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--border-radius-sm)',
                color: 'var(--text-primary)',
                width: 28,
                height: 28,
                cursor: 'pointer',
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1,
              }}
            >
              X
            </button>
            <EvalDetailCard evalResult={selectedEval} />
          </div>
        </div>
      )}
    </div>
  );
}
