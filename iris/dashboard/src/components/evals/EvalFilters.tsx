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
};

interface EvalFilterValues {
  eval_type: string;
  passed: string;
}

export function EvalFilters({
  values,
  onChange,
}: {
  values: EvalFilterValues;
  onChange: (values: EvalFilterValues) => void;
}) {
  return (
    <div style={styles.container}>
      <select
        style={styles.select}
        value={values.eval_type}
        onChange={(e) => onChange({ ...values, eval_type: e.target.value })}
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
        onChange={(e) => onChange({ ...values, passed: e.target.value })}
      >
        <option value="">All Results</option>
        <option value="true">Passed</option>
        <option value="false">Failed</option>
      </select>
    </div>
  );
}
