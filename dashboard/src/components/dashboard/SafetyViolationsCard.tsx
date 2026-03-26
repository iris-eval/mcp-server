import { formatCost } from '../../utils/formatters';

interface SafetyViolations {
  pii: number;
  injection: number;
  hallucination: number;
}

interface Props {
  violations: SafetyViolations;
  totalCost: number;
}

function ViolationRow({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' }}>
      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)' }}>{label}</span>
      <span
        style={{
          fontSize: 'var(--font-size-xs)',
          fontFamily: 'var(--font-mono)',
          fontWeight: 600,
          color: count > 0 ? color : 'var(--text-muted)',
        }}
      >
        {count}
      </span>
    </div>
  );
}

export function SafetyViolationsCard({ violations, totalCost }: Props) {
  const total = violations.pii + violations.injection + violations.hallucination;
  const hasViolations = total > 0;

  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        border: `1px solid ${hasViolations ? 'rgba(239, 68, 68, 0.3)' : 'var(--border-color)'}`,
        borderRadius: 'var(--border-radius-lg)',
        padding: 'var(--space-5)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      {/* Safety Violations */}
      <div>
        <span
          style={{
            fontSize: 'var(--font-size-xs)',
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Safety Violations
        </span>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
          <span
            style={{
              fontSize: 'var(--font-size-2xl)',
              fontWeight: 700,
              fontFamily: 'var(--font-mono)',
              color: hasViolations ? 'var(--accent-error)' : 'var(--accent-success)',
            }}
          >
            {total}
          </span>
          {hasViolations && (
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--accent-error)' }}>
              detected
            </span>
          )}
          {!hasViolations && (
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--accent-success)' }}>
              clean
            </span>
          )}
        </div>
      </div>

      {/* Violation breakdown */}
      <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 'var(--space-2)' }}>
        <ViolationRow label="PII detected" count={violations.pii} color="var(--accent-error)" />
        <ViolationRow label="Injection flags" count={violations.injection} color="var(--accent-warning)" />
        <ViolationRow label="Hallucination" count={violations.hallucination} color="var(--accent-warning)" />
      </div>

      {/* Cost */}
      <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 'var(--space-2)' }}>
        <span
          style={{
            fontSize: 'var(--font-size-xs)',
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Total Cost
        </span>
        <div
          style={{
            fontSize: 'var(--font-size-xl)',
            fontWeight: 700,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-primary)',
            marginTop: '2px',
          }}
        >
          {formatCost(totalCost)}
        </div>
      </div>
    </div>
  );
}
