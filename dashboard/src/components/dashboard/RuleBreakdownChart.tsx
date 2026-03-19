import type { RuleBreakdown } from '../../api/types';

function formatRuleName(rule: string): string {
  return rule.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function getBarColor(passRate: number): string {
  if (passRate >= 0.95) return 'var(--accent-success)';
  if (passRate >= 0.85) return 'var(--accent-primary)';
  if (passRate >= 0.70) return 'var(--accent-warning)';
  return 'var(--accent-error)';
}

interface Props {
  rules: RuleBreakdown[];
}

export function RuleBreakdownChart({ rules }: Props) {
  const maxRate = 1;

  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--border-radius-lg)',
        padding: 'var(--space-5)',
        flex: 1,
        minWidth: 0,
      }}
    >
      <h3
        style={{
          fontSize: 'var(--font-size-sm)',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          margin: 0,
          marginBottom: 'var(--space-4)',
        }}
      >
        Rule Effectiveness
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {rules.map((rule) => {
          const widthPercent = (rule.passRate / maxRate) * 100;
          const color = getBarColor(rule.passRate);
          return (
            <div key={rule.rule} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
              <span
                style={{
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--text-secondary)',
                  width: 130,
                  flexShrink: 0,
                  textAlign: 'right',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={formatRuleName(rule.rule)}
              >
                {formatRuleName(rule.rule)}
              </span>
              <div
                style={{
                  flex: 1,
                  height: 18,
                  background: 'var(--bg-tertiary)',
                  borderRadius: 'var(--border-radius-sm)',
                  overflow: 'hidden',
                  position: 'relative',
                }}
              >
                <div
                  style={{
                    width: `${widthPercent}%`,
                    height: '100%',
                    background: color,
                    borderRadius: 'var(--border-radius-sm)',
                    opacity: 0.85,
                    transition: 'width 0.6s ease-out',
                  }}
                />
              </div>
              <span
                style={{
                  fontSize: 'var(--font-size-xs)',
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 600,
                  color,
                  width: 42,
                  textAlign: 'right',
                  flexShrink: 0,
                }}
              >
                {Math.round(rule.passRate * 100)}%
              </span>
              <span
                style={{
                  fontSize: '10px',
                  color: 'var(--text-muted)',
                  width: 50,
                  textAlign: 'right',
                  flexShrink: 0,
                }}
              >
                {rule.failCount} fail
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
