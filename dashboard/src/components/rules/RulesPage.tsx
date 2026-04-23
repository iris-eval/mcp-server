/*
 * RulesPage — deployed custom rules management (B3 sibling).
 *
 * Lightweight listing: shows every rule deployed via the composer, with
 * source moment provenance, severity, and a delete action. Read-only
 * editing of existing rules is deferred to v0.4.1 (full editor surface).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { useCustomRules } from '../../api/hooks';
import { api } from '../../api/client';
import type { DeployedCustomRule, RuleSeverity } from '../../api/types';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { Tooltip } from '../shared/Tooltip';
import { TT } from '../shared/tooltipText';
import { formatTimeAgo } from '../../utils/formatters';
import { PageHeader } from '../layout/PageHeader';
import { PageEmptyState } from '../layout/PageEmptyState';

const SEVERITY_TOOLTIP: Record<RuleSeverity, string> = {
  low: TT.ruleSeverityLow,
  medium: TT.ruleSeverityMedium,
  high: TT.ruleSeverityHigh,
  critical: TT.ruleSeverityCritical,
};

const styles = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-6)',
  } as const,
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
  } as const,
  title: {
    fontSize: 'var(--font-size-2xl)',
    fontWeight: 700,
    margin: 0,
    color: 'var(--text-primary)',
  } as const,
  subtitle: {
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text-muted)',
    margin: 0,
    maxWidth: '720px',
  } as const,
  empty: {
    background: 'var(--bg-secondary)',
    border: '1px dashed var(--border-color)',
    borderRadius: 'var(--border-radius-lg)',
    padding: 'var(--space-12)',
    textAlign: 'center',
    color: 'var(--text-muted)',
  } as const,
  emptyTitle: {
    fontSize: 'var(--font-size-lg)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: '0 0 var(--space-2)',
  } as const,
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  } as const,
  card: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-lg)',
    padding: 'var(--space-4)',
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: 'var(--space-3)',
    alignItems: 'start',
  } as const,
  cardBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
    minWidth: 0,
  } as const,
  nameRow: {
    display: 'flex',
    gap: 'var(--space-2)',
    alignItems: 'baseline',
    flexWrap: 'wrap',
  } as const,
  name: {
    fontSize: 'var(--font-size-base)',
    fontWeight: 600,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)',
  } as const,
  description: {
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text-secondary)',
    margin: 0,
  } as const,
  metaRow: {
    display: 'flex',
    gap: 'var(--space-3)',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    flexWrap: 'wrap',
  } as const,
  badge: {
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
    padding: '1px 6px',
    borderRadius: 'var(--border-radius-sm)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
  } as const,
  severityBadge: {
    low: { background: 'var(--bg-tertiary)', color: 'var(--text-muted)' },
    medium: { background: 'oklch(28% 0.10 240 / 0.20)', color: 'var(--accent-tool)' },
    high: { background: 'oklch(28% 0.10 80 / 0.20)', color: 'var(--accent-warning)' },
    critical: { background: 'oklch(28% 0.10 25 / 0.20)', color: 'var(--accent-error)' },
  } as const,
  deleteBtn: {
    appearance: 'none',
    background: 'transparent',
    border: '1px solid var(--border-color)',
    color: 'var(--accent-error)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-3)',
    cursor: 'pointer',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'inherit',
  } as const,
  sourceLink: {
    color: 'var(--accent-primary)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
    textDecoration: 'underline',
  } as const,
};

export function RulesPage() {
  const { data, loading, error, refetch } = useCustomRules();
  const [deleting, setDeleting] = useState<string | null>(null);

  const onDelete = async (rule: DeployedCustomRule) => {
    if (!window.confirm(`Delete rule "${rule.name}"? It will stop firing on subsequent iris-mcp restart.`)) return;
    setDeleting(rule.id);
    try {
      await api.deleteCustomRule(rule.id);
      refetch();
    } catch (err) {
      window.alert(`Delete failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setDeleting(null);
    }
  };

  if (loading && !data) return <LoadingSpinner />;

  return (
    <div style={styles.page}>
      <PageHeader
        subtitle={
          <>
            Custom rules deployed from Decision Moments. Each rule fires on every future{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>evaluate_output</code> call of its
            category. To deploy a new rule, click "Make this a rule" on any Decision Moment.
          </>
        }
        meta={
          data && (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-caption)',
                color: 'var(--text-muted)',
              }}
            >
              {data.length} deployed
            </span>
          )
        }
      />

      {error && (
        <PageEmptyState
          icon={Sparkles}
          title="Could not load rules"
          body={error}
        />
      )}

      {data && data.length === 0 && (
        <PageEmptyState
          icon={Sparkles}
          title="No custom rules deployed yet"
          body={
            <>
              Workflow inversion: rules are born from observed Decision Moments, not authored
              from scratch. Open any{' '}
              <Link to="/moments" style={{ color: 'var(--text-accent)', textDecoration: 'underline' }}>
                Decision Moment
              </Link>
              , click <strong style={{ color: 'var(--text-primary)' }}>Make this a rule</strong>,
              and the composer pre-fills from the observed pattern.
            </>
          }
          cta={
            <Link
              to="/moments"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                background: 'var(--iris-600)',
                color: 'white',
                padding: 'var(--space-2) var(--space-4)',
                borderRadius: 'var(--radius-sm)',
                textDecoration: 'none',
                fontWeight: 600,
                fontSize: 'var(--text-body-sm)',
              }}
            >
              Open Decision Moments →
            </Link>
          }
        />
      )}

      {data && data.length > 0 && (
        <div style={styles.list}>
          {data.map((rule) => (
            <div key={rule.id} style={styles.card}>
              <div style={styles.cardBody}>
                <div style={styles.nameRow}>
                  <span style={styles.name}>{rule.name}</span>
                  <Tooltip content={SEVERITY_TOOLTIP[rule.severity]}>
                    <span style={{ ...styles.badge, ...styles.severityBadge[rule.severity] }} tabIndex={0}>
                      {rule.severity}
                    </span>
                  </Tooltip>
                  <Tooltip content={`Fires on every evaluate_output call with eval_type='${rule.evalType}'.`}>
                    <span style={styles.badge} tabIndex={0}>{rule.evalType}</span>
                  </Tooltip>
                  <Tooltip content={`Underlying check: ${rule.definition.type.replace(/_/g, ' ')}.`}>
                    <span style={styles.badge} tabIndex={0}>{rule.definition.type}</span>
                  </Tooltip>
                  {!rule.enabled && (
                    <Tooltip content={TT.ruleEnabled}>
                      <span style={{ ...styles.badge, color: 'var(--accent-warning)' }} tabIndex={0}>disabled</span>
                    </Tooltip>
                  )}
                </div>
                {rule.description && <p style={styles.description}>{rule.description}</p>}
                <div style={styles.metaRow}>
                  <span>id {rule.id}</span>
                  <Tooltip content={TT.ruleVersion}>
                    <span tabIndex={0}>v{rule.version}</span>
                  </Tooltip>
                  <span>created {formatTimeAgo(rule.createdAt)}</span>
                  {rule.sourceMomentId && (
                    <Tooltip content={TT.sourceMoment}>
                      <Link to={`/moments/${rule.sourceMomentId}`} style={styles.sourceLink}>
                        from moment {rule.sourceMomentId.slice(0, 12)}…
                      </Link>
                    </Tooltip>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onDelete(rule)}
                disabled={deleting === rule.id}
                style={styles.deleteBtn}
              >
                {deleting === rule.id ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
