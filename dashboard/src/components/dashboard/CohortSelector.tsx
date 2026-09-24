/*
 * The cohort selector: draw the Drift view over everything at
 * once, or split it by run — the grouping compare_runs tests, so the picture
 * and the test agree on what "before" means. Written to the URL like the
 * period, so a link carries it.
 */
import type { CSSProperties } from 'react';
import { useSearchParams } from 'react-router';

export type Cohort = 'run';

export function resolveCohort(searchParams: URLSearchParams): Cohort | undefined {
  return searchParams.get('cohort') === 'run' ? 'run' : undefined;
}

const OPTIONS: Array<{ id: Cohort | ''; label: string }> = [
  { id: '', label: 'All evaluations' },
  { id: 'run', label: 'By run' },
];

const styles = {
  group: { display: 'inline-flex', gap: '2px', padding: '2px', background: 'var(--bg-base)', borderRadius: 'var(--radius-pill)' } as CSSProperties,
  option: {
    appearance: 'none',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-secondary)',
    padding: '2px var(--space-2)',
    borderRadius: 'var(--radius-pill)',
    fontSize: 'var(--text-caption)',
    fontFamily: 'inherit',
    cursor: 'pointer',
  } as CSSProperties,
  active: { background: 'var(--bg-surface)', color: 'var(--text-primary)', fontWeight: 600 } as CSSProperties,
};

export function CohortSelector() {
  const [searchParams, setSearchParams] = useSearchParams();
  const active = resolveCohort(searchParams) ?? '';
  const choose = (id: Cohort | '') => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('cohort', id);
    else next.delete('cohort');
    setSearchParams(next);
  };
  return (
    <div style={styles.group} role="radiogroup" aria-label="Cohort">
      {OPTIONS.map((o) => (
        <button
          key={o.id || 'all'}
          type="button"
          role="radio"
          aria-checked={active === o.id}
          data-cohort-option={o.id || 'all'}
          style={{ ...styles.option, ...(active === o.id ? styles.active : {}) }}
          onClick={() => choose(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
