/*
 * LiveTraceTail — Stream view's genuine differentiator.
 *
 * Health is "what's the state?" Drift is "what changed?" Stream needs to
 * be "what's flowing through right now?" — the on-call view.
 *
 * Renders the most recent N traces as a tail-f-style log. Each row is a
 * compact line: time + agent + cost + input snippet. Polls 5s via the
 * underlying useTraces hook. New traces appear at the top; the user
 * watches activity flow without taking action.
 *
 * Click a row → /traces/{trace_id} for the full execution detail.
 *
 * Empty state: skeleton rows with the explanation that traces will
 * stream here once an MCP-compatible agent posts.
 */
import { useTraces } from '../../../api/hooks';
import { Link } from 'react-router-dom';
import { Activity, ChevronRight } from 'lucide-react';
import { Icon } from '../../shared/Icon';
import { Tooltip } from '../../shared/Tooltip';
import { formatTimeAgo, formatCost } from '../../../utils/formatters';
import type { Trace } from '../../../api/types';

const TAIL_LIMIT = 12;

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
  titleRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-caption)',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  } as const,
  livePill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px var(--space-2)',
    borderRadius: 'var(--radius-pill)',
    background: 'rgba(34, 197, 94, 0.12)',
    color: 'var(--eval-pass)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption-xs)',
    fontWeight: 600,
    marginLeft: 'var(--space-2)',
  } as const,
  liveDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: 'var(--eval-pass)',
    flexShrink: 0,
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
  /* Compact tail rows — designed for density, monospace, clickable. */
  row: {
    display: 'grid',
    gridTemplateColumns: '64px 140px 64px 1fr',
    gap: 'var(--space-3)',
    alignItems: 'center',
    padding: 'var(--space-1_5) var(--space-4)',
    borderBottom: '1px solid var(--border-subtle)',
    color: 'var(--text-primary)',
    textDecoration: 'none',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-body-sm)',
    minHeight: '28px',
    transition: 'background-color var(--transition-fast)',
  } as const,
  time: {
    color: 'var(--text-muted)',
    fontSize: 'var(--text-caption)',
  } as const,
  agent: {
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  cost: {
    color: 'var(--text-muted)',
    fontSize: 'var(--text-caption)',
    textAlign: 'right',
  } as const,
  snippet: {
    color: 'var(--text-secondary)',
    fontSize: 'var(--text-caption)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  emptySkeleton: {
    padding: 'var(--space-2) var(--space-4) var(--space-1)',
    opacity: 0.32,
  } as const,
  emptyMsg: {
    padding: 'var(--space-3) var(--space-4)',
    color: 'var(--text-muted)',
    fontSize: 'var(--text-body-sm)',
    textAlign: 'center',
  } as const,
};

function snippet(trace: { input?: string; output?: string }): string {
  const src = trace.input ?? trace.output ?? '';
  if (!src) return '—';
  return src.replace(/\s+/g, ' ').slice(0, 120);
}

export function LiveTraceTail() {
  const { data, loading } = useTraces({
    limit: String(TAIL_LIMIT),
  });
  const traces = data?.traces ?? [];

  return (
    <div style={styles.card} role="region" aria-label="Live trace tail">
      <div style={styles.header}>
        <span style={styles.titleRow}>
          <Icon as={Activity} size={14} />
          Live trace tail
          <Tooltip content="Most recent traces logged into Iris. Refreshes every 5 seconds.">
            <span style={styles.livePill} tabIndex={0} aria-label="Live, auto-refreshing">
              <span style={styles.liveDot} aria-hidden="true" />
              live · 5s
            </span>
          </Tooltip>
        </span>
        <Link to="/traces" style={styles.link}>
          All traces <Icon as={ChevronRight} size={14} />
        </Link>
      </div>

      {loading && traces.length === 0 && (
        <div style={styles.emptyMsg}>Loading…</div>
      )}

      {!loading && traces.length === 0 && (
        <>
          <div style={styles.emptySkeleton} aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} style={styles.row}>
                <span style={styles.time}>—</span>
                <span style={styles.agent}>—</span>
                <span style={styles.cost}>—</span>
                <span style={styles.snippet}>—</span>
              </div>
            ))}
          </div>
          <div style={styles.emptyMsg}>
            Traces stream here once an MCP-compatible agent calls <code>log_trace</code>.
          </div>
        </>
      )}

      {traces.map((t: Trace) => (
        <Link
          key={t.trace_id}
          to={`/traces/${t.trace_id}`}
          style={styles.row}
          title={`Trace ${t.trace_id.slice(0, 8)}`}
        >
          <Tooltip content={new Date(t.timestamp).toLocaleString()}>
            <span style={styles.time} tabIndex={0}>{formatTimeAgo(t.timestamp)}</span>
          </Tooltip>
          <span style={styles.agent}>{t.agent_name}</span>
          <span style={styles.cost}>
            {t.cost_usd !== undefined ? formatCost(t.cost_usd) : '—'}
          </span>
          <span style={styles.snippet}>{snippet(t)}</span>
        </Link>
      ))}
    </div>
  );
}
