/*
 * RulesPage — deployed custom rules management (B3 sibling).
 *
 * Lightweight listing: shows every rule deployed via the composer, with
 * source moment provenance, severity, an enable/disable switch and a
 * delete action. Editing an existing rule's definition is still delete +
 * redeploy.
 *
 * The switch is the "dashboard toggle affordance" delete_rule's and
 * list_rules' descriptions have pointed users at since v0.4 — until now
 * nothing invoked the store's setEnabled. It is optimistic: the row flips
 * immediately, the PATCH runs, and a failure rolls the row back with the
 * error inline. A disabled rule stops firing on the very next evaluation
 * (the route unregisters it from the live engine); re-enabling registers
 * it again. No restart either way.
 *
 * Deletion confirms through ConfirmDialog (in-app modal) — the previous
 * window.confirm()/window.alert() pair was the loudest side-project tell
 * in the app, and a native alert can't show the failed request inline.
 */
import { useEffect, useState } from 'react';
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

  /*
   * Optimistic enabled-state overlay, keyed by rule id. An entry exists
   * only while the UI is ahead of (or has rolled back from) the server;
   * once a refetch brings the server's value in line, the entry is
   * dropped so the list is single-sourced again.
   */
  const [enabledOverride, setEnabledOverride] = useState<Record<string, boolean>>({});
  const [toggleBusy, setToggleBusy] = useState<Record<string, boolean>>({});
  const [toggleError, setToggleError] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!data) return;
    setEnabledOverride((current) => {
      let changed = false;
      const next = { ...current };
      for (const rule of data) {
        if (next[rule.id] !== undefined && next[rule.id] === rule.enabled) {
          delete next[rule.id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [data]);

  const isEnabled = (rule: DeployedCustomRule): boolean => enabledOverride[rule.id] ?? rule.enabled;

  const toggleRule = async (rule: DeployedCustomRule) => {
    const next = !isEnabled(rule);
    setEnabledOverride((m) => ({ ...m, [rule.id]: next }));
    setToggleBusy((m) => ({ ...m, [rule.id]: true }));
    setToggleError((m) => {
      const { [rule.id]: _dropped, ...rest } = m;
      return rest;
    });
    try {
      await api.setCustomRuleEnabled(rule.id, next);
      refetch();
    } catch (err) {
      // Roll back to the server's last known state and say why.
      setEnabledOverride((m) => {
        const { [rule.id]: _dropped, ...rest } = m;
        return rest;
      });
      setToggleError((m) => ({
        ...m,
        [rule.id]: `Could not ${next ? 'enable' : 'disable'} rule: ${err instanceof Error ? err.message : err}`,
      }));
    } finally {
      setToggleBusy((m) => {
        const { [rule.id]: _dropped, ...rest } = m;
        return rest;
      });
    }
  };

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
            Custom rules deployed from Decision Moments. Each enabled rule fires on every future{' '}
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
              {data.length} deployed · {data.filter(isEnabled).length} enabled
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
          {data.map((rule) => {
            const enabled = isEnabled(rule);
            const busy = toggleBusy[rule.id] === true;
            const errorText = toggleError[rule.id];
            return (
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
                <div className="rule-card__actions">
                  <div className="rule-card__toggle">
                    <Tooltip content={TT.ruleEnabled}>
                      <span
                        className={`rule-card__state${enabled ? ' rule-card__state--on' : ''}`}
                        tabIndex={0}
                        aria-live="polite"
                      >
                        {enabled ? 'Enabled · fires on the next evaluation' : 'Disabled · kept for audit, does not fire'}
                      </span>
                    </Tooltip>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      aria-label={`Enable rule ${rule.name}`}
                      aria-busy={busy || undefined}
                      disabled={busy}
                      className={`iris-switch${enabled ? ' iris-switch--on' : ''}`}
                      onClick={() => toggleRule(rule)}
                    >
                      <span className="iris-switch__knob" aria-hidden="true" />
                    </button>
                  </div>
                  {errorText && (
                    <span role="alert" className="rule-card__toggle-error">
                      {errorText}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setPendingDelete(rule)}
                    className="iris-btn iris-btn--danger iris-btn--sm"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete rule "${pendingDelete?.name ?? ''}"?`}
        body="It stops firing on the very next evaluation — no restart needed — and its audit history is kept. This cannot be undone; to pause the rule instead, use its Enabled switch."
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
