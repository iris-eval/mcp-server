/*
 * RulesPage — deployed custom rules management (B3 sibling).
 *
 * Lightweight listing: shows every rule deployed via the composer, with
 * source moment provenance, severity, and a delete action. Read-only
 * editing of existing rules is deferred to v0.4.1 (full editor surface).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCustomRules } from '../../api/hooks';
import { api } from '../../api/client';
import type { DeployedCustomRule } from '../../api/types';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { formatTimeAgo } from '../../utils/formatters';

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
      <div style={styles.header}>
        <h1 style={styles.title}>Deployed rules</h1>
        <p style={styles.subtitle}>
          Custom rules deployed from Decision Moments. Each rule fires on every future
          <code> evaluate_output</code> call of its category. To deploy a new rule, click
          "Make this a rule" on any Decision Moment detail surface.
        </p>
      </div>

      {error && (
        <div style={{ ...styles.empty, borderColor: 'var(--accent-error)', color: 'var(--accent-error)' }}>
          Error loading rules: {error}
        </div>
      )}

      {data && data.length === 0 && (
        <div style={styles.empty}>
          <h2 style={styles.emptyTitle}>No custom rules yet</h2>
          <p>
            Open a <Link to="/moments" style={styles.sourceLink}>Decision Moment</Link>,
            click "Make this a rule," and the rule appears here.
          </p>
        </div>
      )}

      {data && data.length > 0 && (
        <div style={styles.list}>
          {data.map((rule) => (
            <div key={rule.id} style={styles.card}>
              <div style={styles.cardBody}>
                <div style={styles.nameRow}>
                  <span style={styles.name}>{rule.name}</span>
                  <span style={{ ...styles.badge, ...styles.severityBadge[rule.severity] }}>
                    {rule.severity}
                  </span>
                  <span style={styles.badge}>{rule.evalType}</span>
                  <span style={styles.badge}>{rule.definition.type}</span>
                  {!rule.enabled && (
                    <span style={{ ...styles.badge, color: 'var(--accent-warning)' }}>disabled</span>
                  )}
                </div>
                {rule.description && <p style={styles.description}>{rule.description}</p>}
                <div style={styles.metaRow}>
                  <span>id {rule.id}</span>
                  <span>v{rule.version}</span>
                  <span>created {formatTimeAgo(rule.createdAt)}</span>
                  {rule.sourceMomentId && (
                    <Link to={`/moments/${rule.sourceMomentId}`} style={styles.sourceLink}>
                      from moment {rule.sourceMomentId.slice(0, 12)}…
                    </Link>
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
