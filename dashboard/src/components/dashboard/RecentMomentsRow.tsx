/*
 * RecentMomentsRow — dashboard Row 2 "NEEDS ATTENTION".
 *
 * Surfaces the top N significant Decision Moments since last visit.
 * Powered by useMoments({min_significance: 0.4}) which filters out
 * normal-pass and normal-fail (low-signal) classifications.
 *
 * Empty state celebrates: "All systems healthy — no moments require
 * attention since {timestamp}."
 */
import { Link } from 'react-router-dom';
import { Activity, ChevronRight } from 'lucide-react';
import { useMoments } from '../../api/hooks';
import { Icon } from '../shared/Icon';
import { Tooltip } from '../shared/Tooltip';
import { getSignificanceVisual, getVerdictVisual } from '../moments/significance';
import { formatTimeAgo, formatCost } from '../../utils/formatters';
import { TT } from '../shared/tooltipText';

const MAX_ROWS = 4;

const styles = {
  card: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-lg)',
    overflow: 'hidden',
  } as const,
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 'var(--space-3) var(--space-4)',
    borderBottom: '1px solid var(--border-subtle)',
    background: 'var(--bg-surface)',
  } as const,
  title: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-caption)',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  } as const,
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-accent)',
    textDecoration: 'none',
    fontFamily: 'var(--font-mono)',
  } as const,
  row: {
    display: 'grid',
    gridTemplateColumns: '20px 1fr 1fr auto auto',
    gap: 'var(--space-3)',
    alignItems: 'center',
    padding: 'var(--space-2) var(--space-4)',
    borderBottom: '1px solid var(--border-subtle)',
    color: 'var(--text-primary)',
    textDecoration: 'none',
    fontSize: 'var(--text-body-sm)',
    minHeight: '32px',
    transition: 'background-color var(--transition-fast)',
  } as const,
  glyph: {
    width: '20px',
    height: '20px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    fontWeight: 700,
    color: 'var(--bg-base)',
    flexShrink: 0,
  } as const,
  agent: {
    fontFamily: 'var(--font-mono)',
    fontWeight: 500,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  failedRules: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  cost: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
  } as const,
  time: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
    minWidth: '64px',
    textAlign: 'right',
  } as const,
  empty: {
    padding: 'var(--space-6) var(--space-4)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
    color: 'var(--text-secondary)',
    fontSize: 'var(--text-body-sm)',
  } as const,
  emptyDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: 'var(--eval-pass)',
    flexShrink: 0,
  } as const,
  loading: {
    padding: 'var(--space-6) var(--space-4)',
    color: 'var(--text-muted)',
    fontSize: 'var(--text-body-sm)',
    textAlign: 'center',
  } as const,
};

export function RecentMomentsRow() {
  const { data, loading } = useMoments({
    limit: String(MAX_ROWS * 3),
    min_significance: '0.4',
  });

  // Filter to true significance (not normal-fail), take MAX_ROWS by recency
  const moments = (data?.moments ?? [])
    .filter((m) => m.significance.kind !== 'normal-pass')
    .slice(0, MAX_ROWS);

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div style={styles.title}>
          <Icon as={Activity} size={14} />
          Needs attention
        </div>
        <Link to="/moments" style={styles.link}>
          View timeline <Icon as={ChevronRight} size={14} />
        </Link>
      </div>

      {loading && !data && <div style={styles.loading}>Loading…</div>}

      {!loading && moments.length === 0 && (
        <div style={styles.empty}>
          <span style={styles.emptyDot} aria-hidden="true" />
          All systems healthy. No Decision Moments require your attention right now.
        </div>
      )}

      {moments.map((m) => {
        const sig = getSignificanceVisual(m.significance.kind);
        const verdict = getVerdictVisual(m.verdict);
        const failedRulesPreview =
          m.ruleSnapshot.failed.length > 0
            ? m.ruleSnapshot.failed.slice(0, 3).join(', ') +
              (m.ruleSnapshot.failed.length > 3 ? ` +${m.ruleSnapshot.failed.length - 3}` : '')
            : m.significance.label;
        return (
          <Link
            key={m.id}
            to={`/moments/${m.id}`}
            style={styles.row}
            title={m.significance.reason}
          >
            <Tooltip content={sig.name}>
              <span style={{ ...styles.glyph, background: sig.color }} aria-label={sig.name}>
                {sig.glyph}
              </span>
            </Tooltip>
            <span style={styles.agent}>{m.agentName}</span>
            <span style={styles.failedRules}>{failedRulesPreview}</span>
            {m.costUsd !== undefined ? (
              <Tooltip content={TT.costPerTrace}>
                <span style={styles.cost} tabIndex={0}>{formatCost(m.costUsd)}</span>
              </Tooltip>
            ) : (
              <span style={styles.cost}>—</span>
            )}
            <Tooltip content={`Verdict: ${verdict.label}`}>
              <span style={styles.time} tabIndex={0}>{formatTimeAgo(m.timestamp)}</span>
            </Tooltip>
          </Link>
        );
      })}
    </div>
  );
}
