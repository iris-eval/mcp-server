import { useFilters } from '../../api/hooks';

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

interface TraceFilterValues {
  agent_name: string;
  framework: string;
  since: string;
  until: string;
}

export function TraceFilters({
  values,
  onChange,
}: {
  values: TraceFilterValues;
  onChange: (values: TraceFilterValues) => void;
}) {
  const { data: filters } = useFilters();

  return (
    <div style={styles.container} onClick={(e) => e.stopPropagation()}>
      <select
        style={styles.select}
        value={values.agent_name}
        onChange={(e) => { e.stopPropagation(); onChange({ ...values, agent_name: e.target.value }); }}
      >
        <option value="">All Agents</option>
        {filters?.agent_names.map((name) => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
      <select
        style={styles.select}
        value={values.framework}
        onChange={(e) => { e.stopPropagation(); onChange({ ...values, framework: e.target.value }); }}
      >
        <option value="">All Frameworks</option>
        {filters?.frameworks.map((fw) => (
          <option key={fw} value={fw}>{fw}</option>
        ))}
      </select>
      <input
        style={styles.input}
        type="datetime-local"
        value={values.since}
        onChange={(e) => { e.stopPropagation(); onChange({ ...values, since: e.target.value }); }}
        placeholder="Since"
      />
      <input
        style={styles.input}
        type="datetime-local"
        value={values.until}
        onChange={(e) => { e.stopPropagation(); onChange({ ...values, until: e.target.value }); }}
        placeholder="Until"
      />
    </div>
  );
}
