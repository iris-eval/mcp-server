import { Link } from 'react-router-dom';
import type { DecisionMoment } from '../../api/types';
import { formatCost, formatLatency, formatTimeAgo } from '../../utils/formatters';
import { getSignificanceVisual, getVerdictVisual } from './significance';

const styles = {
  card: {
    display: 'grid',
    gridTemplateColumns: '48px 1fr auto',
    gap: 'var(--space-4)',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderLeft: '3px solid transparent',
    borderRadius: 'var(--border-radius-lg)',
    padding: 'var(--space-4)',
    textDecoration: 'none',
    color: 'var(--text-primary)',
    transition: 'var(--transition-fast)',
  } as const,
  rail: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 'var(--space-1)',
  } as const,
  glyph: {
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 'var(--font-size-base)',
    fontFamily: 'var(--font-mono)',
    fontWeight: 700,
    color: 'var(--bg-primary)',
  } as const,
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
    minWidth: 0,
  } as const,
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    flexWrap: 'wrap',
  } as const,
  agent: {
    fontSize: 'var(--font-size-sm)',
    fontWeight: 600,
    color: 'var(--text-primary)',
  } as const,
  significanceLabel: {
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
    fontWeight: 500,
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  outputPreview: {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-mono)',
  } as const,
  ruleChips: {
    display: 'flex',
    gap: 'var(--space-1)',
    flexWrap: 'wrap',
  } as const,
  ruleChip: {
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
    padding: '1px 6px',
    borderRadius: 'var(--border-radius-sm)',
    background: 'oklch(28% 0.10 25 / 0.18)',
    color: 'var(--accent-error)',
  } as const,
  meta: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 'var(--space-1)',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
  } as const,
  verdict: {
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
    fontWeight: 700,
    letterSpacing: '0.05em',
  } as const,
};

export function MomentCard({ moment }: { moment: DecisionMoment }) {
  const sig = getSignificanceVisual(moment.significance.kind);
  const verdict = getVerdictVisual(moment.verdict);
  const outputPreview = moment.output?.slice(0, 140) ?? '';

  return (
    <Link
      to={`/moments/${moment.id}`}
      style={{ ...styles.card, borderLeftColor: sig.color }}
      title={moment.significance.reason}
    >
      <div style={styles.rail}>
        <span
          style={{ ...styles.glyph, background: sig.color }}
          aria-label={sig.name}
        >
          {sig.glyph}
        </span>
      </div>

      <div style={styles.body}>
        <div style={styles.headerRow}>
          <span style={styles.agent}>{moment.agentName}</span>
          <span style={{ ...styles.verdict, color: verdict.color }}>{verdict.label}</span>
          <span style={styles.significanceLabel}>· {moment.significance.label}</span>
        </div>
        {moment.ruleSnapshot.failed.length > 0 && (
          <div style={styles.ruleChips}>
            {moment.ruleSnapshot.failed.slice(0, 6).map((name) => (
              <span key={name} style={styles.ruleChip}>{name}</span>
            ))}
            {moment.ruleSnapshot.failed.length > 6 && (
              <span style={styles.ruleChip}>+{moment.ruleSnapshot.failed.length - 6}</span>
            )}
          </div>
        )}
        {outputPreview && (
          <div style={styles.outputPreview} aria-label="Output preview">
            {outputPreview}
            {moment.output && moment.output.length > 140 ? '…' : ''}
          </div>
        )}
      </div>

      <div style={styles.meta}>
        <span>{formatTimeAgo(moment.timestamp)}</span>
        {moment.costUsd !== undefined && <span>{formatCost(moment.costUsd)}</span>}
        {moment.latencyMs !== undefined && <span>{formatLatency(moment.latencyMs)}</span>}
        <span>
          {moment.ruleSnapshot.passedCount}/{
            moment.ruleSnapshot.totalCount - moment.ruleSnapshot.skipped.length
          } pass
        </span>
      </div>
    </Link>
  );
}
