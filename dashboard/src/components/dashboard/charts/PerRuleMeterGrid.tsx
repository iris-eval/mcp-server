/*
 * PerRuleMeterGrid — Drift view's per-rule performance grid.
 *
 * Replacement for RuleListByCategory on Drift. Each of the 13 built-in
 * rules gets:
 *   - pass-rate horizontal meter (filled by current pass rate)
 *   - mini sparkline (per-bucket pass rate trend)
 *   - drift arrow (delta vs prior period)
 *
 * Compact density — fits all 13 rules in ~3 columns × 5 rows on desktop.
 * Each rule is a drill-through to /moments?kind={inferredKind}&since=…
 *
 * Data: counted from the moments of each window. A rule's rate is over the
 * moments it RAN on: each moment names the rules that failed, the rules
 * that passed and the rules that skipped. A rule that did not run on a
 * moment is not a pass there. The grid used to take "not in the failed
 * list" for a pass, so a rule that skipped on every evaluation was drawn
 * as a full green bar titled "84 firings, 100% pass". It now reads
 * "not run (84)" with an empty bar.
 */
import { useMemo } from 'react';
import { Link } from 'react-router';
import { Sparkline } from '../Sparkline';
import { drillToMoments } from '../../../utils/drillThrough';
import {
  BUILT_IN_RULES,
  CATEGORY_META,
  CATEGORY_ORDER,
  BUILT_IN_RULE_CATEGORY,
  ruleToSignificanceKind,
  type RuleCategory,
} from '../ruleCategories';
import type { DecisionMoment } from '../../../api/types';

const styles = {
  card: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-5)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-4)',
  } as const,
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 'var(--space-2)',
  } as const,
  title: {
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
  categoryBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
  } as const,
  catLabel: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption-xs)',
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    margin: 0,
  } as const,
  ruleGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 'var(--space-2)',
  } as const,
  ruleRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 56px 60px',
    gap: 'var(--space-2)',
    alignItems: 'center',
    padding: 'var(--space-2) var(--space-2_5)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    color: 'var(--text-primary)',
    textDecoration: 'none',
    transition: 'border-color var(--transition-fast)',
    minHeight: '44px',
  } as const,
  ruleName: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-body-sm)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  meterTrack: {
    height: '6px',
    background: 'var(--bg-base)',
    borderRadius: 'var(--radius-pill)',
    overflow: 'hidden',
    position: 'relative' as const,
  },
  meterFill: {
    height: '100%',
    borderRadius: 'var(--radius-pill)',
    transition: 'width var(--transition-base)',
  },
  meterValue: {
    position: 'absolute' as const,
    right: '4px',
    top: '-12px',
    fontFamily: 'var(--font-mono)',
    fontSize: '9px',
    color: 'var(--text-muted)',
  },
  spark: {
    color: 'var(--text-muted)',
  } as const,
  driftBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption-xs)',
    fontWeight: 600,
  } as const,
  empty: {
    color: 'var(--text-muted)',
    fontSize: 'var(--text-body-sm)',
    textAlign: 'center',
    padding: 'var(--space-6)',
  } as const,
};

interface RuleStat {
  rule: string;
  passRate: number;
  /** Moments the rule ran on: passed or failed. */
  total: number;
  /** Evaluated moments the rule did not run on: it skipped, or its bundle was not asked for. */
  notRun: number;
  drift?: number; // delta vs prior period
  series: number[];
}

/** What a rule did on one moment: failed, passed, or null when it did not run there. */
export function ruleOutcome(m: DecisionMoment, rule: string): 'failed' | 'passed' | null {
  if (m.ruleSnapshot.failed.includes(rule)) return 'failed';
  if ((m.ruleSnapshot.passed ?? []).includes(rule)) return 'passed';
  return null;
}

/** Pass, ran and not-run counts for one rule over a window of moments. */
export function tallyRule(moments: DecisionMoment[], rule: string): { pass: number; total: number; notRun: number } {
  let pass = 0;
  let total = 0;
  let notRun = 0;
  for (const m of moments) {
    const outcome = ruleOutcome(m, rule);
    if (outcome === null) {
      if (m.evalCount > 0) notRun += 1;
      continue;
    }
    total += 1;
    if (outcome === 'passed') pass += 1;
  }
  return { pass, total, notRun };
}

function thresholdAccent(rate: number): string {
  if (rate >= 0.9) return 'var(--eval-pass)';
  if (rate >= 0.7) return 'var(--eval-warn)';
  return 'var(--eval-fail)';
}

function bucketPassByRule(moments: DecisionMoment[], rule: string, buckets: number): number[] {
  if (moments.length === 0) return [];
  const sorted = [...moments].sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp));
  const t0 = +new Date(sorted[0].timestamp);
  const t1 = +new Date(sorted[sorted.length - 1].timestamp);
  const span = Math.max(1, t1 - t0);
  const buckets_ = Array.from({ length: buckets }, () => ({ pass: 0, total: 0 }));
  for (const m of sorted) {
    const idx = Math.min(buckets - 1, Math.floor(((+new Date(m.timestamp) - t0) / span) * buckets));
    const outcome = ruleOutcome(m, rule);
    if (outcome === null) continue;
    buckets_[idx].total += 1;
    if (outcome === 'passed') buckets_[idx].pass += 1;
  }
  // Only the buckets the rule ran in: an empty bucket is not a pass rate of zero.
  return buckets_.filter((b) => b.total > 0).map((b) => b.pass / b.total);
}

function computeRuleStats(
  current: DecisionMoment[],
  prior: DecisionMoment[],
): Map<string, RuleStat> {
  const out = new Map<string, RuleStat>();
  for (const { name } of BUILT_IN_RULES) {
    const { pass: curPass, total: curTotal, notRun } = tallyRule(current, name);
    const { pass: priPass, total: priTotal } = tallyRule(prior, name);
    const cur = curTotal > 0 ? curPass / curTotal : 0;
    const pri = priTotal > 0 ? priPass / priTotal : 0;
    out.set(name, {
      rule: name,
      passRate: cur,
      total: curTotal,
      notRun,
      drift: priTotal > 0 && curTotal > 0 ? cur - pri : undefined,
      series: bucketPassByRule(current, name, 6),
    });
  }
  return out;
}

export interface PerRuleMeterGridProps {
  currentMoments?: DecisionMoment[];
  priorMoments?: DecisionMoment[];
  periodStartIso: string;
  periodLabel: string;
  /**
   * Rule → category, ideally from useRuleCategoryMap() (the engine's own
   * registry). Defaults to the vendored table so the chart stays I/O-free.
   */
  ruleCategories?: Record<string, RuleCategory>;
}

export function PerRuleMeterGrid({
  currentMoments,
  priorMoments,
  periodStartIso,
  periodLabel,
  ruleCategories = BUILT_IN_RULE_CATEGORY,
}: PerRuleMeterGridProps) {
  const ruleStats = useMemo(
    () => computeRuleStats(currentMoments ?? [], priorMoments ?? []),
    [currentMoments, priorMoments],
  );

  const totalEvalsAcrossRules = Array.from(ruleStats.values()).reduce(
    (acc, s) => acc + s.total,
    0,
  );
  const totalNotRun = Array.from(ruleStats.values()).reduce((acc, s) => acc + s.notRun, 0);

  return (
    <div style={styles.card} role="region" aria-label="Per-rule performance">
      <div style={styles.header}>
        <h3 style={styles.title}>Per-rule performance</h3>
        <span style={styles.hint} data-rule-checks-run={totalEvalsAcrossRules} data-rule-checks-not-run={totalNotRun}>
          {totalEvalsAcrossRules.toLocaleString()} rule checks run
          {totalNotRun > 0 && ` · ${totalNotRun.toLocaleString()} not run`} · {periodLabel}
        </span>
      </div>

      {totalEvalsAcrossRules === 0 && totalNotRun === 0 ? (
        <div style={styles.empty}>
          No rule activity in {periodLabel}. Run agents through Iris to see per-rule meters land here.
        </div>
      ) : (
        CATEGORY_ORDER.filter((c) => c !== 'custom').map((catId) => {
          const cat = CATEGORY_META[catId];
          const rulesInCat = BUILT_IN_RULES.filter((r) => (ruleCategories[r.name] ?? r.category) === catId);
          return (
            <div key={catId} style={styles.categoryBlock}>
              <p style={{ ...styles.catLabel, color: cat.color }}>
                {cat.label}
              </p>
              <div style={styles.ruleGrid}>
                {rulesInCat.map((r) => {
                  const stat = ruleStats.get(r.name);
                  if (!stat) return null;
                  const ratePct = Math.round(stat.passRate * 100);
                  const accent = thresholdAccent(stat.passRate);
                  const driftPct =
                    stat.drift !== undefined ? Math.round(stat.drift * 100) : undefined;
                  const driftSign = driftPct !== undefined && driftPct > 0 ? '+' : '';
                  const driftColor =
                    driftPct === undefined
                      ? 'var(--text-muted)'
                      : driftPct > 0
                        ? 'var(--eval-pass)'
                        : driftPct < 0
                          ? 'var(--eval-fail)'
                          : 'var(--text-muted)';
                  return (
                    <Link
                      key={r.name}
                      to={drillToMoments({ kind: ruleToSignificanceKind(r.name, ruleCategories), since: periodStartIso })}
                      style={styles.ruleRow}
                      title={
                        stat.total > 0
                          ? `${r.name}: ran on ${stat.total} of ${stat.total + stat.notRun} evaluated traces, ${ratePct}% passed`
                          : `${r.name}: not run on any of ${stat.notRun} evaluated traces`
                      }
                      data-rule-meter={r.name}
                      data-rule-ran={stat.total}
                      data-rule-not-run={stat.notRun}
                    >
                      <div>
                        <div style={styles.ruleName}>{r.name}</div>
                        <div style={{ position: 'relative', marginTop: '4px' }}>
                          <div style={styles.meterTrack}>
                            <div
                              style={{
                                ...styles.meterFill,
                                width: stat.total > 0 ? `${ratePct}%` : '0%',
                                background: accent,
                              }}
                            />
                          </div>
                          <span style={styles.meterValue}>
                            {stat.total > 0 ? `${ratePct}%` : stat.notRun > 0 ? `not run (${stat.notRun})` : '—'}
                          </span>
                        </div>
                      </div>
                      <span style={styles.spark}>
                        {stat.series.length > 1 && <Sparkline values={stat.series} height={20} label={`${r.name} pass rate over the period`} />}
                      </span>
                      <span style={{ ...styles.driftBadge, color: driftColor }}>
                        {driftPct === undefined ? '—' : `${driftSign}${driftPct}%`}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
