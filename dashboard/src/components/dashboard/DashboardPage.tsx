import { useState } from 'react';
import { useEvalStats, useEvalTrend, useEvalRules, useEvalFailures } from '../../api/hooks';
import { EvalScoreGauge } from './EvalScoreGauge';
import { StatCard } from './StatCards';
import { SafetyViolationsCard } from './SafetyViolationsCard';
import { EvalTrendChart } from './EvalTrendChart';
import { RuleBreakdownChart } from './RuleBreakdownChart';
import { RecentFailuresTable } from './RecentFailuresTable';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { EmptyState } from '../shared/EmptyState';
import { Tooltip } from '../shared/Tooltip';
import { TT } from '../shared/tooltipText';
import { formatNumber } from '../../utils/formatters';

type Period = '24h' | '7d' | '30d' | 'all';

export function DashboardPage() {
  const [period, setPeriod] = useState<Period>('7d');

  const { data: stats, loading: statsLoading, error: statsError } = useEvalStats(period);
  const { data: trend } = useEvalTrend(period);
  const { data: rules } = useEvalRules();
  const { data: failures } = useEvalFailures(10);

  if (statsLoading) return <LoadingSpinner />;
  if (statsError) return <EmptyState message={`Error: ${statsError}`} />;
  if (!stats) return <EmptyState />;

  const passRateColor =
    stats.passRate >= 0.9 ? 'var(--accent-success)' :
    stats.passRate >= 0.7 ? 'var(--accent-primary)' :
    stats.passRate >= 0.5 ? 'var(--accent-warning)' :
    'var(--accent-error)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      {/* Page header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, margin: 0 }}>Agent Eval</h1>
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', margin: '4px 0 0' }}>
            Output quality scoring across all agents
          </p>
        </div>
      </div>

      {/* ═══ ROW 1: "Am I OK?" ═══ */}
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr 1fr', gap: 'var(--space-4)', alignItems: 'stretch' }}>
        {/* Eval Score Gauge — the signature element */}
        <div
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--border-radius-lg)',
            padding: 'var(--space-5)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <EvalScoreGauge score={stats.avgScore} />
        </div>

        {/* Pass Rate + Volume cards */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <Tooltip content={TT.passRate} placement="top">
            <span style={{ display: 'block' }} tabIndex={0}>
              <StatCard
                label="Pass Rate"
                value={`${Math.round(stats.passRate * 100)}%`}
                sub={`${stats.totalEvals} evaluations scored`}
                color={passRateColor}
              />
            </span>
          </Tooltip>
          <Tooltip content={TT.agentsMonitored} placement="top">
            <span style={{ display: 'block' }} tabIndex={0}>
              <StatCard
                label="Agents Monitored"
                value={formatNumber(stats.agentCount)}
                sub={`${formatNumber(stats.totalEvals)} evals this period`}
                color="var(--text-primary)"
              />
            </span>
          </Tooltip>
        </div>

        {/* Safety + Cost */}
        <SafetyViolationsCard
          violations={stats.safetyViolations}
          totalCost={stats.totalCost}
        />
      </div>

      {/* ═══ ROW 2: "What's Trending?" ═══ */}
      {trend && trend.length > 0 && (
        <EvalTrendChart data={trend} period={period} onPeriodChange={setPeriod} />
      )}

      {/* ═══ ROW 3: "Where Do I Dig In?" ═══ */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
        {rules && rules.length > 0 && <RuleBreakdownChart rules={rules} />}
        {failures && <RecentFailuresTable failures={failures} />}
      </div>
    </div>
  );
}
