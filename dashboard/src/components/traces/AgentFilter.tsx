/*
 * AgentFilter — agent-level filter dropdown for the trace list.
 *
 * Wired into TraceListPage; reads/writes URL search param `agent` so
 * the filter is shareable + bookmarkable. v0.3.1 prep — landed in v0.3.0
 * source tree but not user-visible until TraceListPage wires it in
 * (separate PR, gated on UX review).
 */
import type { ChangeEvent } from 'react';

const styles = {
  wrapper: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    fontSize: 'var(--font-size-sm)',
  } as const,
  label: {
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
  } as const,
  select: {
    appearance: 'none',
    border: '1px solid var(--border-color)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-3)',
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'inherit',
    cursor: 'pointer',
    minWidth: '180px',
  } as const,
};

export interface AgentFilterProps {
  /** Distinct agent names available (computed by parent from current trace set). */
  agents: string[];
  /** Currently-selected agent. Empty string = "All agents." */
  value: string;
  /** Called with the new agent value (or empty string for "All agents"). */
  onChange: (next: string) => void;
}

export function AgentFilter({ agents, value, onChange }: AgentFilterProps) {
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    onChange(event.target.value);
  };

  return (
    <span style={styles.wrapper}>
      <label htmlFor="agent-filter" style={styles.label}>
        agent
      </label>
      <select
        id="agent-filter"
        value={value}
        onChange={handleChange}
        style={styles.select}
        aria-label="Filter traces by agent"
      >
        <option value="">All agents</option>
        {agents.map((agent) => (
          <option key={agent} value={agent}>
            {agent}
          </option>
        ))}
      </select>
    </span>
  );
}
