/*
 * MakeRuleModal — workflow inversion composer (B3).
 *
 * Opens from MomentDetailPage's "Make this a rule" CTA. Pre-fills the
 * rule shape from the source moment's failed-rule context, lets the user
 * edit (name / description / severity / pattern), runs a live preview
 * against historical traces, requires explicit confirmation before
 * deploying.
 *
 * The composer is intentionally narrow in scope for v0.4: it covers the
 * 5 most common rule types that map cleanly from observed-moment patterns.
 * Authoring full json_schema or arbitrary cost_threshold rules is deferred
 * to v0.4.1 (the dedicated /rules editor surface).
 */
import { useEffect, useMemo, useState } from 'react';
import type {
  CustomRuleType,
  DecisionMomentDetail,
  RulePreviewResult,
  RuleSeverity,
  DeployRuleRequest,
} from '../../api/types';
import { api } from '../../api/client';
import { useFocusTrap } from '../shared/useFocusTrap';

const RULE_TYPE_OPTIONS: Array<{
  value: CustomRuleType;
  label: string;
  hint: string;
  configKey: string;
  defaultEvalType: 'completeness' | 'relevance' | 'safety' | 'cost' | 'custom';
}> = [
  { value: 'regex_no_match', label: 'Regex must NOT match', hint: 'Output fails if pattern appears (e.g., $\\d+ for prices, /API_KEY/ for credentials)', configKey: 'pattern', defaultEvalType: 'safety' },
  { value: 'regex_match', label: 'Regex must match', hint: 'Output fails if pattern is missing (e.g., signature footer, citation marker)', configKey: 'pattern', defaultEvalType: 'completeness' },
  { value: 'excludes_keywords', label: 'Output must NOT contain keywords', hint: 'Comma-separated list of forbidden words/phrases', configKey: 'keywords', defaultEvalType: 'safety' },
  { value: 'contains_keywords', label: 'Output must contain keywords', hint: 'Comma-separated list of required words/phrases', configKey: 'keywords', defaultEvalType: 'completeness' },
  { value: 'min_length', label: 'Output must be at least N chars', hint: 'Numeric character minimum', configKey: 'min_length', defaultEvalType: 'completeness' },
  { value: 'max_length', label: 'Output must be at most N chars', hint: 'Numeric character maximum', configKey: 'max_length', defaultEvalType: 'completeness' },
];

const SEVERITY_OPTIONS: RuleSeverity[] = ['low', 'medium', 'high', 'critical'];

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'oklch(0% 0 0 / 0.65)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    padding: 'var(--space-4)',
  } as const,
  modal: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-lg)',
    width: 'min(100%, 720px)',
    maxHeight: '90vh',
    display: 'flex',
    flexDirection: 'column',
  } as const,
  header: {
    padding: 'var(--space-4) var(--space-5)',
    borderBottom: '1px solid var(--border-color)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  } as const,
  title: {
    margin: 0,
    fontSize: 'var(--font-size-lg)',
    fontWeight: 700,
  } as const,
  body: {
    padding: 'var(--space-5)',
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-4)',
  } as const,
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
  } as const,
  label: {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  } as const,
  hint: {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
  } as const,
  input: {
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-2) var(--space-3)',
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'inherit',
  } as const,
  monoInput: {
    fontFamily: 'var(--font-mono)',
  } as const,
  twoCol: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 'var(--space-3)',
  } as const,
  textarea: {
    minHeight: '60px',
    resize: 'vertical',
  } as const,
  preview: {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius)',
    padding: 'var(--space-3)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
    fontSize: 'var(--font-size-sm)',
  } as const,
  previewStat: {
    display: 'flex',
    gap: 'var(--space-3)',
    fontFamily: 'var(--font-mono)',
  } as const,
  previewExample: {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    background: 'var(--bg-primary)',
    padding: 'var(--space-1) var(--space-2)',
    borderRadius: 'var(--border-radius-sm)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  footer: {
    padding: 'var(--space-4) var(--space-5)',
    borderTop: '1px solid var(--border-color)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 'var(--space-3)',
  } as const,
  footerLeft: {
    display: 'flex',
    gap: 'var(--space-2)',
  } as const,
  btn: {
    appearance: 'none',
    border: '1px solid var(--border-color)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-2) var(--space-4)',
    cursor: 'pointer',
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'inherit',
  } as const,
  btnPrimary: {
    background: 'var(--accent-primary)',
    color: 'var(--bg-primary)',
    borderColor: 'var(--accent-primary)',
    fontWeight: 600,
  } as const,
  btnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  } as const,
  errorMsg: {
    color: 'var(--accent-error)',
    fontSize: 'var(--font-size-xs)',
  } as const,
  confirmBox: {
    background: 'oklch(28% 0.10 80 / 0.20)',
    border: '1px solid var(--accent-warning)',
    borderRadius: 'var(--border-radius)',
    padding: 'var(--space-3)',
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text-primary)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
  } as const,
};

interface Props {
  moment: DecisionMomentDetail;
  onClose: () => void;
  onDeployed: () => void;
}

interface RuleFormState {
  name: string;
  description: string;
  severity: RuleSeverity;
  evalType: 'completeness' | 'relevance' | 'safety' | 'cost' | 'custom';
  ruleType: CustomRuleType;
  configValue: string;
}

function suggestInitialState(moment: DecisionMomentDetail): RuleFormState {
  // Workflow inversion provenance: if a safety rule failed, suggest a
  // regex_no_match rule (most common safety extension). If a length rule
  // failed, suggest the matching length rule. Else fall back to
  // regex_no_match in safety.
  const failed = moment.ruleSnapshot.failed;
  if (failed.includes('no_pii') || failed.includes('no_blocklist_words') || failed.includes('no_injection_patterns') || failed.includes('no_stub_output')) {
    return {
      name: `my_${failed[0]}_extension`,
      description: `Custom extension building on ${failed[0]}.`,
      severity: 'high',
      evalType: 'safety',
      ruleType: 'regex_no_match',
      configValue: '',
    };
  }
  if (failed.includes('min_output_length')) {
    return {
      name: 'my_min_length',
      description: 'Stricter minimum output length than the default.',
      severity: 'medium',
      evalType: 'completeness',
      ruleType: 'min_length',
      configValue: '200',
    };
  }
  if (failed.includes('cost_under_threshold')) {
    return {
      name: 'my_cost_cap',
      description: 'Per-trace cost cap.',
      severity: 'high',
      evalType: 'cost',
      ruleType: 'max_length',
      configValue: '0.05',
    };
  }
  return {
    name: 'my_custom_rule',
    description: 'Pattern observed in this Decision Moment.',
    severity: 'medium',
    evalType: 'safety',
    ruleType: 'regex_no_match',
    configValue: '',
  };
}

function buildDefinition(form: RuleFormState): DeployRuleRequest['definition'] | null {
  const meta = RULE_TYPE_OPTIONS.find((o) => o.value === form.ruleType);
  if (!meta) return null;

  let configValue: unknown = form.configValue;
  if (form.ruleType === 'min_length' || form.ruleType === 'max_length') {
    const n = Number(form.configValue);
    if (!Number.isFinite(n) || n <= 0) return null;
    configValue = n;
  } else if (form.ruleType === 'contains_keywords' || form.ruleType === 'excludes_keywords') {
    const list = form.configValue
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 0) return null;
    configValue = list;
  } else {
    if (!form.configValue.trim()) return null;
  }

  return {
    name: form.name,
    type: form.ruleType,
    config: { [meta.configKey]: configValue },
  };
}

export function MakeRuleModal({ moment, onClose, onDeployed }: Props) {
  const [form, setForm] = useState<RuleFormState>(() => suggestInitialState(moment));
  const [preview, setPreview] = useState<RulePreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [deployLoading, setDeployLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // ESC dismisses the modal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const definition = useMemo(() => buildDefinition(form), [form]);
  const canPreview = definition !== null && /^[a-z0-9._-]+$/i.test(form.name);

  const meta = RULE_TYPE_OPTIONS.find((o) => o.value === form.ruleType)!;

  const onPreview = async () => {
    if (!definition) return;
    setError(null);
    setPreviewLoading(true);
    setPreview(null);
    try {
      const result = await api.previewCustomRule({
        definition,
        evalType: form.evalType,
        windowDays: 7,
        maxTraces: 1000,
      });
      setPreview(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
  };

  const onDeploy = async () => {
    if (!definition) return;
    setError(null);
    setDeployLoading(true);
    try {
      await api.deployCustomRule({
        name: form.name,
        description: form.description,
        evalType: form.evalType,
        severity: form.severity,
        definition,
        sourceMomentId: moment.id,
      });
      onDeployed();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deploy failed');
      setConfirming(false);
    } finally {
      setDeployLoading(false);
    }
  };

  const trapRef = useFocusTrap<HTMLDivElement>(true);

  return (
    <div
      ref={trapRef}
      style={styles.backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="make-rule-title"
    >
      <div style={styles.modal}>
        <div style={styles.header}>
          <h2 id="make-rule-title" style={styles.title}>
            Make this a rule
          </h2>
          <button type="button" onClick={onClose} style={styles.btn} aria-label="Close">
            ×
          </button>
        </div>

        <div style={styles.body}>
          <div style={styles.hint}>
            Workflow inversion: this rule will be born from the moment you're looking at.
            Source moment ID is recorded for audit; the rule fires on every future
            <code> evaluate_output</code> call of category <code>{form.evalType}</code>.
          </div>

          <div style={styles.twoCol}>
            <div style={styles.field}>
              <label style={styles.label} htmlFor="rule-name">Name</label>
              <input
                id="rule-name"
                style={{ ...styles.input, ...styles.monoInput }}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="my_custom_rule"
                pattern="^[a-z0-9._-]+$"
              />
              <span style={styles.hint}>Letters, digits, dot, dash, underscore.</span>
            </div>
            <div style={styles.field}>
              <label style={styles.label} htmlFor="rule-severity">Severity</label>
              <select
                id="rule-severity"
                style={styles.input}
                value={form.severity}
                onChange={(e) => setForm({ ...form, severity: e.target.value as RuleSeverity })}
              >
                {SEVERITY_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>

          <div style={styles.field}>
            <label style={styles.label} htmlFor="rule-desc">Description</label>
            <textarea
              id="rule-desc"
              style={{ ...styles.input, ...styles.textarea }}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="What this rule checks for and why it matters"
            />
          </div>

          <div style={styles.twoCol}>
            <div style={styles.field}>
              <label style={styles.label} htmlFor="rule-eval-type">Eval category</label>
              <select
                id="rule-eval-type"
                style={styles.input}
                value={form.evalType}
                onChange={(e) => setForm({ ...form, evalType: e.target.value as RuleFormState['evalType'] })}
              >
                <option value="safety">safety</option>
                <option value="completeness">completeness</option>
                <option value="relevance">relevance</option>
                <option value="cost">cost</option>
                <option value="custom">custom</option>
              </select>
            </div>
            <div style={styles.field}>
              <label style={styles.label} htmlFor="rule-type">Check type</label>
              <select
                id="rule-type"
                style={styles.input}
                value={form.ruleType}
                onChange={(e) => {
                  const next = e.target.value as CustomRuleType;
                  const opt = RULE_TYPE_OPTIONS.find((o) => o.value === next);
                  setForm({
                    ...form,
                    ruleType: next,
                    evalType: opt?.defaultEvalType ?? form.evalType,
                  });
                }}
              >
                {RULE_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div style={styles.field}>
            <label style={styles.label} htmlFor="rule-config">{meta.configKey}</label>
            <input
              id="rule-config"
              style={{ ...styles.input, ...styles.monoInput }}
              value={form.configValue}
              onChange={(e) => setForm({ ...form, configValue: e.target.value })}
              placeholder={
                form.ruleType === 'regex_no_match' || form.ruleType === 'regex_match'
                  ? 'e.g. \\$\\d+ or (?i)password'
                  : form.ruleType === 'min_length' || form.ruleType === 'max_length'
                    ? 'e.g. 200'
                    : 'e.g. apology, sorry, regret'
              }
            />
            <span style={styles.hint}>{meta.hint}</span>
          </div>

          {preview && (
            <div style={styles.preview}>
              <div style={styles.previewStat}>
                <span><strong>{preview.wouldFail}</strong> would fail</span>
                <span><strong>{preview.wouldPass}</strong> would pass</span>
                <span style={{ color: 'var(--text-muted)' }}>
                  {preview.wouldSkip} skip · {preview.tracesEvaluated} evaluated · last 7d
                </span>
              </div>
              {preview.examples.length > 0 && (
                <div>
                  <span style={styles.label}>Sample failures</span>
                  {preview.examples.map((ex) => (
                    <div key={ex.traceId} style={styles.previewExample} title={ex.outputPreview}>
                      [{ex.agentName}] {ex.outputPreview}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {error && <div style={styles.errorMsg}>{error}</div>}

          {confirming && preview && (
            <div style={styles.confirmBox}>
              <strong>Confirm deploy</strong>
              <span>
                Deploying <code>{form.name}</code> will mean this rule fires on every future
                evaluation of category <code>{form.evalType}</code>. Based on the last 7 days,
                <strong> {preview.wouldFail}</strong> traces would have failed it. Audit log
                entry will be written to <code>~/.iris/audit.log</code>.
              </span>
            </div>
          )}
        </div>

        <div style={styles.footer}>
          <div style={styles.footerLeft}>
            <button
              type="button"
              onClick={onPreview}
              disabled={!canPreview || previewLoading}
              style={{
                ...styles.btn,
                ...(!canPreview || previewLoading ? styles.btnDisabled : {}),
              }}
            >
              {previewLoading ? 'Previewing…' : 'Preview against last 7 days'}
            </button>
          </div>
          <div style={styles.footerLeft}>
            <button type="button" onClick={onClose} style={styles.btn}>
              Cancel
            </button>
            {confirming ? (
              <button
                type="button"
                onClick={onDeploy}
                disabled={deployLoading}
                style={{ ...styles.btn, ...styles.btnPrimary, ...(deployLoading ? styles.btnDisabled : {}) }}
              >
                {deployLoading ? 'Deploying…' : 'Confirm & deploy'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={!canPreview || !preview}
                style={{ ...styles.btn, ...styles.btnPrimary, ...(!canPreview || !preview ? styles.btnDisabled : {}) }}
              >
                Deploy rule
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
