/*
 * RulesPage — deployed custom rules management (B3 sibling).
 *
 * Lightweight listing: shows every rule deployed via the composer, with
 * source moment provenance, severity, and a delete action. Read-only
 * editing of existing rules is deferred to v0.4.1 (full editor surface).
 *
 * Deletion confirms through ConfirmDialog (in-app modal) — the previous
 * window.confirm()/window.alert() pair was the loudest side-project tell
 * in the app, and a native alert can't show the failed request inline.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { Sparkles } from 'lucide-react';
import { useCustomRules } from '../../api/hooks';
import { api } from '../../api/client';
import type { DeployedCustomRule, RuleSeverity } from '../../api/types';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { ConfirmDialog } from '../shared/ConfirmDialog';
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

/* Static styling lives in utilities.css (.rule-card block). Severity
 * badge colors stay inline — they're chosen from data. */
const SEVERITY_BADGE_STYLE: Record<RuleSeverity, { background: string; color: string }> = {
  low: { background: 'var(--bg-surface)', color: 'var(--text-muted)' },
  medium: { background: 'oklch(28% 0.10 240 / 0.20)', color: 'var(--eval-tool)' },
  high: { background: 'oklch(28% 0.10 80 / 0.20)', color: 'var(--eval-warn)' },
  critical: { background: 'oklch(28% 0.10 25 / 0.20)', color: 'var(--eval-fail)' },
};

export function RulesPage() {
  const { data, loading, error, refetch } = useCustomRules();
  const [pendingDelete, setPendingDelete] = useState<DeployedCustomRule | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const closeDeleteDialog = () => {
    if (deleting) return;
    setPendingDelete(null);
    setDeleteError(null);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteCustomRule(pendingDelete.id);
      setPendingDelete(null);
      refetch();
    } catch (err) {
      // Keep the dialog open with the failure inline so the user can
      // retry or bail — the old window.alert() dead-ended here.
      setDeleteError(`Delete failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setDeleting(false);
    }
  };

  if (loading && !data) return <LoadingSpinner />;

  return (
    <div className="iris-stack iris-stack--lg">
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
              <Link to="/moments" style={{ textDecoration: 'underline' }}>
                Decision Moment
              </Link>
              , click <strong style={{ color: 'var(--text-primary)' }}>Make this a rule</strong>,
              and the composer pre-fills from the observed pattern.
            </>
          }
          cta={
            <Link to="/moments" className="iris-btn iris-btn--primary">
              Open Decision Moments →
            </Link>
          }
        />
      )}

      {data && data.length > 0 && (
        <div className="iris-stack">
          {data.map((rule) => (
            <div key={rule.id} className="iris-card iris-card--hover rule-card">
              <div className="rule-card__body">
                <div className="rule-card__name-row">
                  <span className="rule-card__name">{rule.name}</span>
                  <Tooltip content={SEVERITY_TOOLTIP[rule.severity]}>
                    <span
                      className="rule-card__badge"
                      style={SEVERITY_BADGE_STYLE[rule.severity]}
                      tabIndex={0}
                    >
                      {rule.severity}
                    </span>
                  </Tooltip>
                  <Tooltip content={`Fires on every evaluate_output call with eval_type='${rule.evalType}'.`}>
                    <span className="rule-card__badge" tabIndex={0}>{rule.evalType}</span>
                  </Tooltip>
                  <Tooltip content={`Underlying check: ${rule.definition.type.replace(/_/g, ' ')}.`}>
                    <span className="rule-card__badge" tabIndex={0}>{rule.definition.type}</span>
                  </Tooltip>
                  {!rule.enabled && (
                    <Tooltip content={TT.ruleEnabled}>
                      <span
                        className="rule-card__badge"
                        style={{ color: 'var(--eval-warn)' }}
                        tabIndex={0}
                      >
                        disabled
                      </span>
                    </Tooltip>
                  )}
                </div>
                {rule.description && <p className="rule-card__description">{rule.description}</p>}
                <div className="rule-card__meta">
                  <span>id {rule.id}</span>
                  <Tooltip content={TT.ruleVersion}>
                    <span tabIndex={0}>v{rule.version}</span>
                  </Tooltip>
                  <span>created {formatTimeAgo(rule.createdAt)}</span>
                  {rule.sourceMomentId && (
                    <Tooltip content={TT.sourceMoment}>
                      <Link to={`/moments/${rule.sourceMomentId}`} className="rule-card__source-link">
                        from moment {rule.sourceMomentId.slice(0, 12)}…
                      </Link>
                    </Tooltip>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPendingDelete(rule)}
                className="iris-btn iris-btn--danger iris-btn--sm"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete rule "${pendingDelete?.name ?? ''}"?`}
        body="It will stop firing on subsequent iris-mcp restart. This cannot be undone."
        confirmLabel="Delete rule"
        danger
        busy={deleting}
        error={deleteError}
        onConfirm={confirmDelete}
        onCancel={closeDeleteDialog}
      />
    </div>
  );
}
