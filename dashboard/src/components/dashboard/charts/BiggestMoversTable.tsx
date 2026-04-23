/*
 * BiggestMoversTable — agents whose pass rate moved most this period.
 *
 * Computes pass-rate delta per agent vs the prior equivalent window,
 * sorts by absolute change, surfaces the top N (default 5). Each row is
 * a drill-through into the moments timeline filtered to that agent.
 *
 * The mini-sparkline on each row gives at-a-glance shape — was the move
 * a steady decline or a single bad bucket?
 *
 * No comparison data shows when there's nothing to compare yet (first
 * period of activity) — empty state is honest about that.
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp, TrendingDown, Minus, Users } from 'lucide-react';
import { Icon } from '../../shared/Icon';
import { Sparkline } from '../Sparkline';
import { drillToMoments, isoDaysAgo } from '../../../utils/drillThrough';
import type { DecisionMoment } from '../../../api/types';

const styles = {
  card: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-lg)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    minHeight: '260px',
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
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-caption)',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    margin: 0,
  } as const,
  hint: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption-xs)',
    color: 'var(--text-muted)',
  } as const,
  list: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
  } as const,
  row: {
    display: 'grid',
    gridTemplateColumns: '1fr 80px 86px',
    alignItems: 'center',
    padding: 'var(--space-2) var(--space-4)',
    gap: 'var(--space-3)',
    borderBottom: '1px solid var(--border-subtle)',
    color: 'var(--text-primary)',
    textDecoration: 'none',
    transition: 'background-color var(--transition-fast)',
    fontSize: 'var(--text-body-sm)',
    minHeight: '40px',
  } as const,
  agentName: {
    fontFamily: 'var(--font-mono)',
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  spark: {
    color: 'var(--text-muted)',
  } as const,
  delta: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 6px',
    borderRadius: 'var(--radius-pill)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    fontWeight: 600,
    justifySelf: 'end',
  } as const,
  empty: {
    color: 'var(--text-muted)',
    fontSize: 'var(--text-body-sm)',
    textAlign: 'center',
    padding: 'var(--space-3) var(--space-4)',
  } as const,
  /* Three muted ghost rows that show the eventual layout (agent name +
   * sparkline column + delta column) so the empty state reads as a
   * skeleton, not a void. */
  skeletonRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 80px 86px',
    alignItems: 'center',
    padding: 'var(--space-2) var(--space-4)',
    gap: 'var(--space-3)',
    borderBottom: '1px solid var(--border-subtle)',
    minHeight: '40px',
    opacity: 0.32,
  } as const,
  skeletonText: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-body-sm)',
    color: 'var(--text-muted)',
  } as const,
  skeletonLine: {
    height: '4px',
    background: 'var(--text-muted)',
    borderRadius: 'var(--radius-pill)',
    opacity: 0.6,
  } as const,
  skeletonDelta: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
    justifySelf: 'end',
  } as const,
};

interface AgentMover {
  agent: string;
  currentRate: number;
  priorRate: number;
  delta: number;
  totalCurrent: number;
  series: number[];
}

function bucketize(moments: DecisionMoment[], buckets: number, periodStart: Date, periodEnd: Date): number[] {
  const span = periodEnd.getTime() - periodStart.getTime();
  if (span <= 0) return [];
  const out = Array.from({ length: buckets }, () => ({ pass: 0, total: 0 }));
  for (const m of moments) {
    const t = new Date(m.timestamp).getTime();
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor(((t - periodStart.getTime()) / span) * buckets)));
    out[idx].total += 1;
    if (m.verdict === 'pass') out[idx].pass += 1;
  }
  return out.map((b) => (b.total > 0 ? b.pass / b.total : 0));
}

function computeMovers(
  currentMoments: DecisionMoment[],
  priorMoments: DecisionMoment[],
  periodDays: number,
): AgentMover[] {
  const periodStart = new Date(isoDaysAgo(periodDays));
  const periodEnd = new Date();
  const groupBy = (list: DecisionMoment[]): Map<string, DecisionMoment[]> => {
    const map = new Map<string, DecisionMoment[]>();
    for (const m of list) {
      const arr = map.get(m.agentName) ?? [];
      arr.push(m);
      map.set(m.agentName, arr);
    }
    return map;
  };

  const currentByAgent = groupBy(currentMoments);
  const priorByAgent = groupBy(priorMoments);
  const allAgents = new Set([...currentByAgent.keys(), ...priorByAgent.keys()]);

  const movers: AgentMover[] = [];
  for (const agent of allAgents) {
    const cur = currentByAgent.get(agent) ?? [];
    const pri = priorByAgent.get(agent) ?? [];
    if (cur.length < 3 && pri.length < 3) continue; // skip noise
    const curRate = cur.length === 0 ? 0 : cur.filter((m) => m.verdict === 'pass').length / cur.length;
    const priRate = pri.length === 0 ? 0 : pri.filter((m) => m.verdict === 'pass').length / pri.length;
    movers.push({
      agent,
      currentRate: curRate,
      priorRate: priRate,
      delta: curRate - priRate,
      totalCurrent: cur.length,
      series: bucketize(cur, 8, periodStart, periodEnd),
    });
  }
  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return movers.slice(0, 5);
}

export interface BiggestMoversTableProps {
  currentMoments?: DecisionMoment[];
  priorMoments?: DecisionMoment[];
  periodDays: number;
  periodLabel: string;
}

export function BiggestMoversTable({
  currentMoments,
  priorMoments,
  periodDays,
  periodLabel,
}: BiggestMoversTableProps) {
  const movers = useMemo(
    () => computeMovers(currentMoments ?? [], priorMoments ?? [], periodDays),
    [currentMoments, priorMoments, periodDays],
  );

  const periodStartIso = isoDaysAgo(periodDays);

  return (
    <div style={styles.card} role="region" aria-label="Biggest movers">
      <header style={styles.header}>
        <h3 style={styles.title}>
          <Icon as={Users} size={14} />
          Biggest movers
        </h3>
        <span style={styles.hint}>vs prior {periodLabel}</span>
      </header>
      <div style={styles.list}>
        {movers.length === 0 && (
          <>
            <div aria-hidden="true">
              {[78, 52, 36].map((linePct, i) => (
                <div key={i} style={styles.skeletonRow}>
                  <span style={styles.skeletonText}>—</span>
                  <span><div style={{ ...styles.skeletonLine, width: `${linePct}%` }} /></span>
                  <span style={styles.skeletonDelta}>—</span>
                </div>
              ))}
            </div>
            <div style={styles.empty}>
              Need at least 3 evals per agent in both windows to compute movement. Agents will appear here as activity accumulates.
            </div>
          </>
        )}
        {movers.map((m) => {
          const positive = m.delta > 0.005;
          const negative = m.delta < -0.005;
          const icon = positive ? TrendingUp : negative ? TrendingDown : Minus;
          const fg = positive ? 'var(--eval-pass)' : negative ? 'var(--eval-fail)' : 'var(--text-muted)';
          const bg = positive
            ? 'rgba(34, 197, 94, 0.12)'
            : negative
              ? 'rgba(239, 68, 68, 0.12)'
              : 'var(--bg-surface)';
          const sign = m.delta > 0 ? '+' : '';
          return (
            <Link
              key={m.agent}
              to={drillToMoments({ agent: m.agent, since: periodStartIso })}
              style={styles.row}
              title={`Inspect ${m.agent} moments`}
            >
              <span style={styles.agentName}>{m.agent}</span>
              <span style={styles.spark}>
                <Sparkline values={m.series} height={20} />
              </span>
              <span style={{ ...styles.delta, background: bg, color: fg }}>
                <Icon as={icon} size={14} />
                {sign}{Math.round(m.delta * 100)}%
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
