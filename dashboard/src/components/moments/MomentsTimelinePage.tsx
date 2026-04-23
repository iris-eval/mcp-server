/*
 * MomentsTimelinePage — Decision Moment Timeline (Phase B1).
 *
 * The category-defining surface. Renders a vertically-stacked timeline of
 * Decision Moments derived from trace + eval data. Each moment is a card
 * with a significance-coded rail glyph; the timeline reads top-down (most
 * recent first by default).
 *
 * Filter state is encoded in URL search params so every filtered view is
 * shareable (per Phase B1 enterprise-depth requirement: permalinks).
 *
 * State coverage (per `feedback_enterprise_state_completeness.md`):
 *   - empty (no moments): hero CTA
 *   - empty after filter: clear-filter inline action
 *   - loading: skeleton cards
 *   - error: retry button
 */
import { useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMoments, useFilters } from '../../api/hooks';
import { usePreferences } from '../../hooks/usePreferences';
import { MomentCard } from './MomentCard';
import {
  SIGNIFICANCE_KIND_OPTIONS,
  VERDICT_OPTIONS,
  getSignificanceVisual,
} from './significance';
import { LoadingSpinner } from '../shared/LoadingSpinner';

const styles = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-6)',
  } as const,
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 'var(--space-4)',
    flexWrap: 'wrap',
  } as const,
  titleBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
  } as const,
  title: {
    fontSize: 'var(--font-size-2xl)',
    fontWeight: 700,
    margin: 0,
    color: 'var(--text-primary)',
  } as const,
  subtitle: {
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text-muted)',
    margin: 0,
    maxWidth: '720px',
  } as const,
  filterRow: {
    display: 'flex',
    gap: 'var(--space-3)',
    alignItems: 'center',
    flexWrap: 'wrap',
    background: 'var(--bg-secondary)',
    padding: 'var(--space-3) var(--space-4)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius)',
  } as const,
  filterLabel: {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  } as const,
  select: {
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-2)',
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'inherit',
  } as const,
  legend: {
    display: 'flex',
    gap: 'var(--space-3)',
    flexWrap: 'wrap',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
  } as const,
  legendItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
  } as const,
  legendDot: {
    width: '14px',
    height: '14px',
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '10px',
    fontFamily: 'var(--font-mono)',
    fontWeight: 700,
    color: 'var(--bg-primary)',
  } as const,
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  } as const,
  empty: {
    background: 'var(--bg-secondary)',
    border: '1px dashed var(--border-color)',
    borderRadius: 'var(--border-radius-lg)',
    padding: 'var(--space-12)',
    textAlign: 'center',
    color: 'var(--text-muted)',
  } as const,
  emptyTitle: {
    fontSize: 'var(--font-size-lg)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: '0 0 var(--space-2)',
  } as const,
  errorBox: {
    background: 'oklch(28% 0.10 25 / 0.18)',
    border: '1px solid var(--accent-error)',
    borderRadius: 'var(--border-radius)',
    padding: 'var(--space-4)',
    color: 'var(--accent-error)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
  } as const,
  retryBtn: {
    appearance: 'none',
    background: 'transparent',
    border: '1px solid var(--accent-error)',
    color: 'var(--accent-error)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-3)',
    cursor: 'pointer',
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'inherit',
    width: 'fit-content',
  } as const,
  countBadge: {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
  } as const,
  installCmd: {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-2) var(--space-3)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text-primary)',
    display: 'inline-block',
    margin: 'var(--space-3) 0',
  } as const,
};

const LEGEND_KINDS = [
  'safety-violation',
  'cost-spike',
  'rule-collision',
  'normal-fail',
  'normal-pass',
] as const;

export function MomentsTimelinePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: filters } = useFilters();
  const { preferences, patch } = usePreferences();
  // Track whether we've already applied persisted filters once on this mount,
  // so refreshes within the same visit don't keep re-applying them on top of
  // the user's manual clears.
  const hydratedFromPrefs = useRef(false);

  // ── Permalink + persistence resolution ────────────────────────────
  // 1. URL params present → permalink wins. Don't override.
  // 2. URL params empty + persisted filters in preferences → hydrate URL.
  // 3. URL params empty + no persisted filters → no-op.
  useEffect(() => {
    if (hydratedFromPrefs.current) return;
    if (!preferences) return;
    const hasUrlFilters =
      searchParams.has('agent') || searchParams.has('verdict') || searchParams.has('kind');
    if (hasUrlFilters) {
      hydratedFromPrefs.current = true;
      return;
    }
    const persisted = preferences.momentFilters;
    const hasPersisted =
      Boolean(persisted.agentName) || Boolean(persisted.verdict) || Boolean(persisted.significanceKind);
    if (hasPersisted) {
      const next = new URLSearchParams();
      if (persisted.agentName) next.set('agent', persisted.agentName);
      if (persisted.verdict) next.set('verdict', persisted.verdict);
      if (persisted.significanceKind) next.set('kind', persisted.significanceKind);
      setSearchParams(next, { replace: true });
    }
    hydratedFromPrefs.current = true;
  }, [preferences, searchParams, setSearchParams]);

  const queryParams = useMemo<Record<string, string>>(() => {
    const params: Record<string, string> = { limit: '50' };
    const agent = searchParams.get('agent');
    const verdict = searchParams.get('verdict');
    const kind = searchParams.get('kind');
    if (agent) params.agent_name = agent;
    if (verdict) params.verdict = verdict;
    if (kind) params.significance_kind = kind;
    return params;
  }, [searchParams]);

  const { data, loading, error, refetch } = useMoments(queryParams);

  // Persist filter changes back to preferences (best-effort; failures are
  // surfaced as a console warning but don't block the UI). We only persist
  // *after* the first hydration so initial mounts don't redundantly write
  // back what we just read.
  useEffect(() => {
    if (!hydratedFromPrefs.current || !preferences) return;
    const next = {
      agentName: searchParams.get('agent') ?? undefined,
      verdict: (searchParams.get('verdict') as
        | 'pass'
        | 'fail'
        | 'partial'
        | 'unevaluated'
        | null) ?? undefined,
      significanceKind: (searchParams.get('kind') as
        | 'safety-violation'
        | 'cost-spike'
        | 'first-failure'
        | 'novel-pattern'
        | 'rule-collision'
        | 'normal-pass'
        | 'normal-fail'
        | null) ?? undefined,
    };
    const current = preferences.momentFilters;
    const equal =
      next.agentName === current.agentName &&
      next.verdict === current.verdict &&
      next.significanceKind === current.significanceKind;
    if (equal) return;
    // Strip undefined fields so we PATCH a clean object — server schema is strict
    const cleaned: Record<string, string> = {};
    if (next.agentName) cleaned.agentName = next.agentName;
    if (next.verdict) cleaned.verdict = next.verdict;
    if (next.significanceKind) cleaned.significanceKind = next.significanceKind;
    patch({ momentFilters: cleaned as never }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[Iris] could not persist filter preference', err);
    });
  }, [searchParams, preferences, patch]);

  const updateFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  };

  const clearFilters = () => {
    setSearchParams(new URLSearchParams());
    patch({ momentFilters: {} }).catch(() => undefined);
  };

  const hasActiveFilters =
    Boolean(searchParams.get('agent')) ||
    Boolean(searchParams.get('verdict')) ||
    Boolean(searchParams.get('kind'));

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div style={styles.titleBlock}>
          <h1 style={styles.title}>Decision Moments</h1>
          <p style={styles.subtitle}>
            Every trace, classified by what makes it noteworthy. Safety violations and cost
            spikes surface to the top; happy-path passes recede. Click a moment to see why
            it was flagged and turn the observed pattern into a deployable rule.
          </p>
        </div>
        {data && (
          <span style={styles.countBadge}>
            {data.moments.length} of {data.total} traces
          </span>
        )}
      </div>

      <div style={styles.filterRow}>
        <span style={styles.filterLabel}>Filter</span>
        <select
          style={styles.select}
          value={searchParams.get('kind') ?? ''}
          onChange={(e) => updateFilter('kind', e.target.value)}
          aria-label="Filter by significance"
        >
          {SIGNIFICANCE_KIND_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <select
          style={styles.select}
          value={searchParams.get('verdict') ?? ''}
          onChange={(e) => updateFilter('verdict', e.target.value)}
          aria-label="Filter by verdict"
        >
          {VERDICT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <select
          style={styles.select}
          value={searchParams.get('agent') ?? ''}
          onChange={(e) => updateFilter('agent', e.target.value)}
          aria-label="Filter by agent"
        >
          <option value="">All agents</option>
          {(filters?.agent_names ?? []).map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearFilters}
            style={{ ...styles.select, cursor: 'pointer' }}
          >
            Clear
          </button>
        )}
        <span style={{ marginLeft: 'auto' }} />
        <div style={styles.legend} aria-label="Significance legend">
          {LEGEND_KINDS.map((kind) => {
            const v = getSignificanceVisual(kind);
            return (
              <span key={kind} style={styles.legendItem}>
                <span style={{ ...styles.legendDot, background: v.color }}>{v.glyph}</span>
                {v.name}
              </span>
            );
          })}
        </div>
      </div>

      {error && (
        <div style={styles.errorBox} role="alert">
          <strong>Could not load decision moments</strong>
          <span>{error}</span>
          <button type="button" style={styles.retryBtn} onClick={refetch}>
            Retry
          </button>
        </div>
      )}

      {loading && !data && <LoadingSpinner />}

      {data && data.moments.length === 0 && (
        <div style={styles.empty}>
          {hasActiveFilters ? (
            <>
              <h2 style={styles.emptyTitle}>No moments match these filters</h2>
              <p>Try widening the time window or removing filters.</p>
              <button
                type="button"
                onClick={clearFilters}
                style={{ ...styles.retryBtn, color: 'var(--accent-primary)', borderColor: 'var(--accent-primary)' }}
              >
                Clear all filters
              </button>
            </>
          ) : (
            <>
              <h2 style={styles.emptyTitle}>No moments yet</h2>
              <p>Run an agent through Iris and your first decision moment will appear here within seconds.</p>
              <code style={styles.installCmd}>npx @iris-eval/mcp-server --dashboard</code>
            </>
          )}
        </div>
      )}

      {data && data.moments.length > 0 && (
        <div style={styles.list}>
          {data.moments.map((m) => (
            <MomentCard key={m.id} moment={m} />
          ))}
        </div>
      )}
    </div>
  );
}
