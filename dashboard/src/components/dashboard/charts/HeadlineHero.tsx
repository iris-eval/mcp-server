/*
 * HeadlineHero — Health view's anchor block. ONE composite, not two cards.
 *
 * The previous pass shipped a standalone gauge AND a standalone area chart
 * AND a KPI tile that all displayed the same percentage. This card collapses
 * the headline (current value + delta) and the trajectory (annotated trend)
 * into a single visual unit so the eye reads them as ONE story:
 *
 *   "Pass rate is X%, it moved by Y vs prior, here's how it got there."
 *
 * Layout:
 *   ┌──────────────────────────────────────────────┐
 *   │  90%        ▲ +3%        Pass rate trend     │
 *   │  pass rate  vs prior     [annotated chart]   │
 *   │  19 evals · 5 agents     ▼ deploy ▲ delete   │
 *   └──────────────────────────────────────────────┘
 *
 * Drops the standalone gauge from Health (the gauge primitive stays in the
 * codebase — it earns its keep elsewhere: per-rule meters or a /rules
 * health composite).
 */
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from '../../shared/Icon';
import { PassRateAreaChart } from './PassRateAreaChart';
import type { AuditLogEntry, EvalTrendPoint } from '../../../api/types';

const styles = {
  card: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-5)',
    display: 'grid',
    gridTemplateColumns: '260px 1fr',
    gap: 'var(--space-5)',
    alignItems: 'stretch',
    minHeight: '260px',
  } as const,
  statBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
    justifyContent: 'center',
    paddingRight: 'var(--space-4)',
    borderRight: '1px solid var(--border-subtle)',
  } as const,
  label: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-caption)',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    margin: 0,
  } as const,
  bigNumber: {
    fontFamily: 'var(--font-display)',
    fontSize: 'clamp(48px, 6vw, 72px)',
    fontWeight: 700,
    color: 'var(--text-primary)',
    letterSpacing: '-0.04em',
    lineHeight: 1,
    margin: 0,
  } as const,
  delta: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
    padding: '4px var(--space-2)',
    borderRadius: 'var(--radius-pill)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-body-sm)',
    fontWeight: 600,
    width: 'fit-content',
  } as const,
  deltaCaption: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
    margin: 0,
  } as const,
  context: {
    fontSize: 'var(--text-body-sm)',
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
    margin: 0,
  } as const,
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
    color: 'var(--text-muted)',
  } as const,
  emptyTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-heading-sm)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: 0,
  } as const,
  emptyCmd: {
    margin: 'var(--space-2) 0 0',
    padding: 'var(--space-2) var(--space-3)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-secondary)',
    width: 'fit-content',
  } as const,
  trendWrap: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    width: '100%',
  } as const,
};

function thresholdAccent(rate: number): { color: string; bg: string; label: string } {
  if (rate >= 0.9) return { color: 'var(--eval-pass)', bg: 'rgba(34, 197, 94, 0.12)', label: 'pass' };
  if (rate >= 0.7) return { color: 'var(--eval-warn)', bg: 'rgba(245, 158, 11, 0.12)', label: 'warn' };
  return { color: 'var(--eval-fail)', bg: 'rgba(239, 68, 68, 0.12)', label: 'fail' };
}

function deltaPresentation(delta?: number): {
  icon: LucideIcon;
  bg: string;
  fg: string;
  label: string;
} {
  if (delta === undefined || Number.isNaN(delta)) {
    return { icon: Minus, bg: 'var(--bg-surface)', fg: 'var(--text-muted)', label: '—' };
  }
  const pct = Math.round(delta * 100);
  if (pct > 0) {
    return {
      icon: TrendingUp,
      bg: 'rgba(34, 197, 94, 0.12)',
      fg: 'var(--eval-pass)',
      label: `+${pct}%`,
    };
  }
  if (pct < 0) {
    return {
      icon: TrendingDown,
      bg: 'rgba(239, 68, 68, 0.12)',
      fg: 'var(--eval-fail)',
      label: `${pct}%`,
    };
  }
  return { icon: Minus, bg: 'var(--bg-surface)', fg: 'var(--text-muted)', label: '0%' };
}

export interface HeadlineHeroProps {
  passRate?: number;
  delta?: number;
  totalEvals?: number;
  agentCount?: number;
  trend?: EvalTrendPoint[];
  auditEntries?: AuditLogEntry[];
  periodLabel: string;
}

export function HeadlineHero({
  passRate,
  delta,
  totalEvals,
  agentCount,
  trend,
  auditEntries,
  periodLabel,
}: HeadlineHeroProps) {
  if (passRate === undefined || totalEvals === 0) {
    return (
      <div style={styles.card}>
        <div style={styles.statBlock}>
          <h2 style={styles.label}>Pass rate · {periodLabel}</h2>
          <div style={styles.emptyState}>
            <p style={styles.emptyTitle}>Awaiting first eval</p>
            <p style={styles.context}>
              Run any MCP-compatible agent against Iris and your first eval lands here within seconds.
            </p>
            <code style={styles.emptyCmd}>npx @iris-eval/mcp-server</code>
          </div>
        </div>
        <div style={styles.trendWrap}>
          <PassRateAreaChart naked trend={trend} auditEntries={auditEntries} periodLabel={periodLabel} />
        </div>
      </div>
    );
  }

  const accent = thresholdAccent(passRate);
  const delta_ = deltaPresentation(delta);
  const pct = Math.round(passRate * 100);

  return (
    <div style={styles.card} role="region" aria-label={`Pass rate ${pct} percent for ${periodLabel}`}>
      <div style={styles.statBlock}>
        <h2 style={styles.label}>Pass rate · {periodLabel}</h2>
        <p style={{ ...styles.bigNumber, color: accent.color }}>{pct}%</p>
        <span style={{ ...styles.delta, background: delta_.bg, color: delta_.fg }}>
          <Icon as={delta_.icon} size={14} />
          {delta_.label} vs prior {periodLabel}
        </span>
        <p style={styles.context}>
          {totalEvals?.toLocaleString() ?? 0} evals · {agentCount ?? 0} agents
        </p>
      </div>
      <div style={styles.trendWrap}>
        <PassRateAreaChart naked trend={trend} auditEntries={auditEntries} periodLabel={periodLabel} title="Trend" height={220} />
      </div>
    </div>
  );
}
