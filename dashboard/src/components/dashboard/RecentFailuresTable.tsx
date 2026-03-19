import type { EvalFailure } from '../../api/types';
import { formatTimeAgo } from '../../utils/formatters';

function formatRuleName(rule: string): string {
  return rule.replace(/_/g, ' ');
}

function getScoreColor(score: number): string {
  if (score >= 0.7) return 'var(--accent-success)';
  if (score >= 0.4) return 'var(--accent-warning)';
  return 'var(--accent-error)';
}

interface Props {
  failures: EvalFailure[];
}

export function RecentFailuresTable({ failures }: Props) {
  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--border-radius-lg)',
        padding: 'var(--space-5)',
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
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
        Recent Failures
      </h3>

      {failures.length === 0 ? (
        <div style={{ color: 'var(--accent-success)', fontSize: 'var(--font-size-sm)', padding: 'var(--space-4) 0' }}>
          No failures in this period
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {/* Header */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1.2fr 60px 80px',
              gap: 'var(--space-2)',
              padding: '6px 0',
              borderBottom: '1px solid var(--border-color)',
              fontSize: '10px',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            <span>Agent</span>
            <span>Rule</span>
            <span style={{ textAlign: 'right' }}>Score</span>
            <span style={{ textAlign: 'right' }}>When</span>
          </div>

          {/* Rows */}
          {failures.slice(0, 8).map((f, i) => (
            <div
              key={`${f.traceId}-${f.rule}-${i}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1.2fr 60px 80px',
                gap: 'var(--space-2)',
                padding: '7px 0',
                borderBottom: '1px solid rgba(39, 39, 42, 0.4)',
                fontSize: 'var(--font-size-xs)',
                alignItems: 'center',
              }}
            >
              <span
                style={{
                  color: 'var(--text-secondary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={f.agent}
              >
                {f.agent}
              </span>
              <span
                style={{
                  color: 'var(--accent-error)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={formatRuleName(f.rule)}
              >
                {formatRuleName(f.rule)}
              </span>
              <span
                style={{
                  textAlign: 'right',
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 600,
                  color: getScoreColor(f.score),
                }}
              >
                {f.score.toFixed(2)}
              </span>
              <span
                style={{
                  textAlign: 'right',
                  color: 'var(--text-muted)',
                  fontSize: '11px',
                }}
              >
                {formatTimeAgo(f.timestamp)}
              </span>
            </div>
          ))}
        </div>
      )}

      {failures.length > 8 && (
        <div style={{ marginTop: 'var(--space-3)', textAlign: 'center' }}>
          <a
            href="/evals"
            style={{
              fontSize: 'var(--font-size-xs)',
              color: 'var(--accent-primary)',
              textDecoration: 'none',
            }}
          >
            View all failures →
          </a>
        </div>
      )}
    </div>
  );
}
