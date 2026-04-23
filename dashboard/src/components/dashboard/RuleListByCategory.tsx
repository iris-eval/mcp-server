/*
 * RuleListByCategory — dashboard Row 3 LEFT — "RULES IN PLAY".
 *
 * Shows ALL 13 built-in rules grouped by category with per-rule pass
 * rate. The rule list is the authoritative roster (BUILT_IN_RULES) so
 * even unfired rules show up — answers "what does Iris evaluate?" not
 * just "what fired recently?".
 *
 * Custom rules (deployed via Make-This-A-Rule) get their own group
 * at the bottom. Empty-state copy leads with the workflow-inversion
 * story.
 */
import { Link } from 'react-router-dom';
import { Sparkles, ChevronRight } from 'lucide-react';
import { useEvalRules, useCustomRules } from '../../api/hooks';
import { Icon } from '../shared/Icon';
import { Tooltip } from '../shared/Tooltip';
import {
  BUILT_IN_RULES,
  CATEGORY_META,
  CATEGORY_ORDER,
  type RuleCategory,
} from './ruleCategories';

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
  body: {
    padding: 'var(--space-2) 0',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
  } as const,
  catHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 'var(--space-2) var(--space-4)',
    fontSize: 'var(--text-caption-xs)',
    fontFamily: 'var(--font-body)',
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    borderTop: '1px solid var(--border-subtle)',
    background: 'var(--bg-raised)',
  } as const,
  catLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
  } as const,
  catDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    flexShrink: 0,
  } as const,
  catRate: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)',
  } as const,
  rule: {
    display: 'grid',
    gridTemplateColumns: '14px 1fr auto',
    gap: 'var(--space-2)',
    alignItems: 'center',
    padding: 'var(--space-1_5) var(--space-4)',
    fontSize: 'var(--text-body-sm)',
  } as const,
  ruleStatus: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
  } as const,
  ruleName: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  ruleStat: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
    minWidth: '88px',
    textAlign: 'right',
  } as const,
  customEmpty: {
    padding: 'var(--space-3) var(--space-4)',
    fontSize: 'var(--text-body-sm)',
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
  } as const,
  customCta: {
    color: 'var(--text-accent)',
    textDecoration: 'underline',
  } as const,
};

export function RuleListByCategory() {
  const { data: ruleStats } = useEvalRules();
  const { data: customRules } = useCustomRules();

  // Index rule stats by name for O(1) lookup
  const statsByName = new Map<string, { passRate: number; totalRun: number; failCount: number }>();
  for (const r of ruleStats ?? []) {
    statsByName.set(r.rule, { passRate: r.passRate, totalRun: r.totalRun, failCount: r.failCount });
  }

  // Group built-in rules by category
  const builtInByCategory: Record<RuleCategory, Array<{ name: string; stats?: typeof statsByName extends Map<string, infer V> ? V : never }>> = {
    safety: [],
    relevance: [],
    completeness: [],
    cost: [],
    custom: [],
  };
  for (const rule of BUILT_IN_RULES) {
    builtInByCategory[rule.category].push({ name: rule.name, stats: statsByName.get(rule.name) });
  }

  // Compute per-category aggregate pass rate
  function categoryAggregate(rules: Array<{ stats?: { passRate: number; totalRun: number } }>): {
    pct: number | null;
    fired: number;
    total: number;
  } {
    const fired = rules.filter((r) => r.stats && r.stats.totalRun > 0);
    if (fired.length === 0) return { pct: null, fired: 0, total: rules.length };
    const totalRuns = fired.reduce((a, r) => a + (r.stats?.totalRun ?? 0), 0);
    const weightedPass = fired.reduce(
      (a, r) => a + (r.stats?.passRate ?? 0) * (r.stats?.totalRun ?? 0),
      0,
    );
    return { pct: totalRuns > 0 ? weightedPass / totalRuns : null, fired: fired.length, total: rules.length };
  }

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div style={styles.title}>
          <Icon as={Sparkles} size={14} />
          Rules in play <span style={{ color: 'var(--text-muted)' }}>· {BUILT_IN_RULES.length} built-in + {customRules?.length ?? 0} custom</span>
        </div>
        <Link to="/rules" style={styles.link}>
          Manage <Icon as={ChevronRight} size={14} />
        </Link>
      </div>

      <div style={styles.body}>
        {CATEGORY_ORDER.filter((c) => c !== 'custom').map((cat) => {
          const meta = CATEGORY_META[cat];
          const rules = builtInByCategory[cat];
          const agg = categoryAggregate(rules);
          return (
            <div key={cat}>
              <div style={styles.catHeader}>
                <Tooltip content={meta.description}>
                  <span style={styles.catLabel} tabIndex={0}>
                    <span style={{ ...styles.catDot, background: meta.color }} aria-hidden="true" />
                    {meta.label} ({rules.length})
                  </span>
                </Tooltip>
                <span style={styles.catRate}>
                  {agg.pct === null ? 'no fires' : `${Math.round(agg.pct * 100)}% pass`}
                </span>
              </div>
              {rules.map(({ name, stats }) => {
                const passed = stats?.passRate ?? 1;
                const fired = stats?.totalRun ?? 0;
                const failed = stats?.failCount ?? 0;
                const dotColor =
                  fired === 0
                    ? 'var(--text-muted)'
                    : passed === 1
                      ? 'var(--eval-pass)'
                      : passed >= 0.8
                        ? 'var(--eval-warn)'
                        : 'var(--eval-fail)';
                return (
                  <div key={name} style={styles.rule}>
                    <span style={{ ...styles.ruleStatus, background: dotColor }} aria-hidden="true" />
                    <span style={styles.ruleName}>{name}</span>
                    <span style={styles.ruleStat}>
                      {fired === 0
                        ? 'unfired'
                        : `${Math.round(passed * 100)}% (${fired - failed}/${fired})`}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* Custom rules section — always shown, even when empty */}
        <div style={styles.catHeader}>
          <Tooltip content={CATEGORY_META.custom.description}>
            <span style={styles.catLabel} tabIndex={0}>
              <span style={{ ...styles.catDot, background: CATEGORY_META.custom.color }} aria-hidden="true" />
              {CATEGORY_META.custom.label} ({customRules?.length ?? 0})
            </span>
          </Tooltip>
        </div>
        {customRules && customRules.length > 0 ? (
          customRules.map((rule) => {
            const stats = statsByName.get(rule.name);
            const passed = stats?.passRate ?? 1;
            const fired = stats?.totalRun ?? 0;
            const failed = stats?.failCount ?? 0;
            const dotColor =
              !rule.enabled
                ? 'var(--text-muted)'
                : fired === 0
                  ? 'var(--text-muted)'
                  : passed === 1
                    ? 'var(--eval-pass)'
                    : passed >= 0.8
                      ? 'var(--eval-warn)'
                      : 'var(--eval-fail)';
            return (
              <div key={rule.id} style={styles.rule}>
                <span style={{ ...styles.ruleStatus, background: dotColor }} aria-hidden="true" />
                <span style={styles.ruleName}>{rule.name}</span>
                <span style={styles.ruleStat}>
                  {!rule.enabled
                    ? 'disabled'
                    : fired === 0
                      ? 'unfired'
                      : `${Math.round(passed * 100)}% (${fired - failed}/${fired})`}
                </span>
              </div>
            );
          })
        ) : (
          <div style={styles.customEmpty}>
            No custom rules deployed yet. Open{' '}
            <Link to="/moments" style={styles.customCta}>Decision Moments</Link>{' '}
            to make a rule from any observed pattern — Iris's workflow-inversion shortcut.
          </div>
        )}
      </div>
    </div>
  );
}
