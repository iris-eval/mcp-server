const styles = {
  container: {
    display: 'flex',
    gap: 'var(--space-3)',
    flexWrap: 'wrap',
    alignItems: 'center',
  } as const,
  select: {
    padding: 'var(--space-2) var(--space-3)',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-sm)',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-size-sm)',
  } as const,
  input: {
    padding: 'var(--space-2) var(--space-3)',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-sm)',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-size-sm)',
    width: '160px',
  } as const,
};

interface EvalFilterValues {
  eval_type: string;
  passed: string;
  since: string;
  until: string;
}

export function EvalFilters({
  values,
  onChange,
}: {
  values: EvalFilterValues;
  onChange: (values: EvalFilterValues) => void;
}) {
  return (
    <div style={styles.container} onClick={(e) => e.stopPropagation()}>
      <select
        style={styles.select}
        value={values.eval_type}
        onChange={(e) => { e.stopPropagation(); onChange({ ...values, eval_type: e.target.value }); }}
        aria-label="Filter by eval type"
      >
        <option value="">All Types</option>
        <option value="completeness">Completeness</option>
        <option value="relevance">Relevance</option>
        <option value="safety">Safety</option>
        <option value="cost">Cost</option>
        <option value="custom">Custom</option>
      </select>
      <select
        style={styles.select}
        value={values.passed}
        onChange={(e) => { e.stopPropagation(); onChange({ ...values, passed: e.target.value }); }}
        aria-label="Filter by result"
      >
        <option value="">All Results</option>
        <option value="true">Passed</option>
        <option value="false">Failed</option>
      </select>
      <input
        style={styles.input}
        type="datetime-local"
        value={values.since}
        onChange={(e) => { e.stopPropagation(); onChange({ ...values, since: e.target.value }); }}
        placeholder="Since"
        aria-label="Filter from date"
      />
      <input
        style={styles.input}
        type="datetime-local"
        value={values.until}
        onChange={(e) => { e.stopPropagation(); onChange({ ...values, until: e.target.value }); }}
        placeholder="Until"
        aria-label="Filter to date"
      />
    </div>
  );
}
