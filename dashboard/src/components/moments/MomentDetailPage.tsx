/*
 * MomentDetailPage — single Decision Moment surface (Phase B2).
 *
 * Three sections under the app chrome h1:
 *   1. Significance hero — verdict, reason, key stats, Make-This-A-Rule CTA
 *   2. Input/Output — the actual content the agent saw and produced
 *   3. Eval results — every rule that fired, grouped by eval_type
 *
 * Each section is wrapped in <section aria-labelledby> with its own h2 so
 * screen readers can jump the page structure and axe never flags a flat
 * content region. PageHeader is not used here — the significance hero IS
 * the page header for this resource route.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMomentDetail } from '../../api/hooks';
import { CopyableId } from '../shared/CopyableId';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { formatCost, formatLatency, formatTimestamp } from '../../utils/formatters';
import { getSignificanceVisual, getVerdictVisual } from './significance';
import { MakeRuleModal } from './MakeRuleModal';
import { Tooltip } from '../shared/Tooltip';
import { TT } from '../shared/tooltipText';

const SIG_TOOLTIP_DETAIL: Record<string, string> = {
  'safety-violation': TT.sigSafetyViolation,
  'cost-spike': TT.sigCostSpike,
  'rule-collision': TT.sigRuleCollision,
  'normal-fail': TT.sigNormalFail,
  'normal-pass': TT.sigNormalPass,
};

const styles = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-6)',
  } as const,
  back: {
    fontSize: 'var(--text-body-sm)',
    color: 'var(--text-muted)',
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
  } as const,
  hero: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderLeft: '3px solid transparent',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-6)',
    display: 'grid',
    gridTemplateColumns: 'auto 1fr auto',
    gap: 'var(--space-5)',
    alignItems: 'center',
  } as const,
  glyph: {
    width: '64px',
    height: '64px',
    borderRadius: 'var(--radius-pill)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 'var(--text-heading)',
    fontFamily: 'var(--font-mono)',
    fontWeight: 700,
    color: 'var(--bg-base)',
  } as const,
  heroBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
    minWidth: 0,
  } as const,
  significanceName: {
    fontSize: 'var(--text-caption)',
    fontFamily: 'var(--font-mono)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-muted)',
  } as const,
  significanceLabel: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-heading)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    letterSpacing: '-0.01em',
    lineHeight: 'var(--leading-heading)',
    margin: 0,
  } as const,
  significanceReason: {
    fontSize: 'var(--text-body-sm)',
    color: 'var(--text-secondary)',
    margin: 0,
    maxWidth: '640px',
    lineHeight: 'var(--leading-body)',
  } as const,
  ctaCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
    alignItems: 'flex-end',
  } as const,
  cta: {
    appearance: 'none',
    background: 'var(--iris-500)',
    color: 'var(--bg-base)',
    border: 'none',
    borderRadius: 'var(--radius)',
    padding: 'var(--space-2) var(--space-4)',
    fontSize: 'var(--text-body-sm)',
    fontFamily: 'inherit',
    fontWeight: 600,
    cursor: 'pointer',
  } as const,
  ctaHint: {
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
  } as const,
  metaRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 'var(--space-4)',
    fontSize: 'var(--text-body-sm)',
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
  } as const,
  twoCol: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 'var(--space-4)',
  } as const,
  panel: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-5)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  } as const,
  panelTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-heading-sm)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    letterSpacing: '-0.01em',
    margin: 0,
  } as const,
  subLabel: {
    fontSize: 'var(--text-caption)',
    fontFamily: 'var(--font-mono)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-muted)',
    margin: 0,
  } as const,
  textBlock: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    padding: 'var(--space-3)',
    fontSize: 'var(--text-body-sm)',
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: '320px',
    overflow: 'auto',
  } as const,
  evalGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
  } as const,
  evalGroupHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: 'var(--text-body-sm)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    paddingBottom: 'var(--space-1)',
    borderBottom: '1px solid var(--border-default)',
  } as const,
  ruleRow: {
    display: 'grid',
    gridTemplateColumns: '20px 1fr auto',
    gap: 'var(--space-2)',
    alignItems: 'baseline',
    padding: 'var(--space-1) 0',
    fontSize: 'var(--text-body-sm)',
  } as const,
  ruleStatus: {
    width: '14px',
    height: '14px',
    borderRadius: 'var(--radius-pill)',
    display: 'inline-block',
  } as const,
  ruleName: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)',
  } as const,
  ruleMessage: {
    color: 'var(--text-muted)',
    fontSize: 'var(--text-caption)',
    fontFamily: 'var(--font-mono)',
    textAlign: 'right',
    maxWidth: '50%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  } as const,
  toggle: {
    appearance: 'none',
    background: 'transparent',
    border: '1px solid var(--border-default)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--radius-sm)',
    padding: 'var(--space-1) var(--space-2)',
    cursor: 'pointer',
    fontSize: 'var(--text-caption)',
    fontFamily: 'inherit',
  } as const,
  toolList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
    fontSize: 'var(--text-caption)',
    fontFamily: 'var(--font-mono)',
  } as const,
  toolRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: 'var(--space-1) var(--space-2)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-surface)',
  } as const,
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    border: 0,
  } as const,
};

export function MomentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error, refetch } = useMomentDetail(id ?? '');
  const [showRaw, setShowRaw] = useState(false);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [deployedToast, setDeployedToast] = useState<string | null>(null);

  if (loading && !data) return <LoadingSpinner />;
  if (error) {
    return (
      <div style={styles.page}>
        <Link to="/moments" style={styles.back}>← Back to moments</Link>
        <div style={{ ...styles.panel, borderColor: 'var(--eval-fail)' }}>
          <h2 style={{ ...styles.panelTitle, color: 'var(--eval-fail)' }}>Could not load moment</h2>
          <p>{error}</p>
          <button type="button" onClick={refetch} style={styles.toggle}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!data) return null;

  const sig = getSignificanceVisual(data.significance.kind);
  const verdict = getVerdictVisual(data.verdict);
  const toolCalls = data.toolCalls ?? [];
  const visibleTools = toolsExpanded ? toolCalls : toolCalls.slice(0, 3);

  return (
    <div style={styles.page}>
      <Link to="/moments" style={styles.back}>← Back to moments</Link>

      <section aria-labelledby="moment-sig-label" style={{ ...styles.hero, borderLeftColor: sig.color }}>
        <Tooltip content={SIG_TOOLTIP_DETAIL[data.significance.kind] ?? sig.name}>
          <span style={{ ...styles.glyph, background: sig.color }} aria-label={sig.name} tabIndex={0}>
            {sig.glyph}
          </span>
        </Tooltip>
        <div style={styles.heroBody}>
          <span style={styles.significanceName}>{sig.name}</span>
          <h2 id="moment-sig-label" style={styles.significanceLabel}>{data.significance.label}</h2>
          <p style={styles.significanceReason}>{data.significance.reason}</p>
          <div style={styles.metaRow}>
            <span style={{ color: verdict.color, fontWeight: 700 }}>{verdict.label}</span>
            <span>{data.agentName}</span>
            <span>{formatTimestamp(data.timestamp)}</span>
            {data.costUsd !== undefined && (
              <Tooltip content={TT.costPerTrace}>
                <span tabIndex={0}>{formatCost(data.costUsd)}</span>
              </Tooltip>
            )}
            {data.latencyMs !== undefined && (
              <Tooltip content={TT.latencyMs}>
                <span tabIndex={0}>{formatLatency(data.latencyMs)}</span>
              </Tooltip>
            )}
            <CopyableId value={data.id} displayValue={data.id.slice(0, 12) + '…'} ariaLabel="Copy moment ID" />
          </div>
        </div>
        <div style={styles.ctaCol}>
          <button
            type="button"
            style={styles.cta}
            onClick={() => setComposerOpen(true)}
          >
            Make this a rule
          </button>
          <span style={styles.ctaHint}>workflow inversion · v0.4</span>
        </div>
      </section>

      {deployedToast && (
        <div
          role="status"
          aria-live="polite"
          style={{ ...styles.panel, borderColor: 'var(--eval-pass)' }}
        >
          <strong style={{ color: 'var(--eval-pass)' }}>✓ {deployedToast} deployed</strong>
          <span style={{ ...styles.ctaHint, color: 'var(--text-secondary)' }}>
            The rule is live and will fire on every future evaluation of its category. Audit
            entry written to <code>~/.iris/audit.log</code>.
          </span>
        </div>
      )}

      <div style={styles.twoCol}>
        <section aria-labelledby="moment-io-title" style={styles.panel}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 id="moment-io-title" style={styles.panelTitle}>Input → Output</h3>
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              style={styles.toggle}
            >
              {showRaw ? 'Hide raw' : 'Show raw'}
            </button>
          </div>
          {data.input !== undefined && (
            <>
              <span style={styles.subLabel}>Input</span>
              <div style={styles.textBlock}>{data.input}</div>
            </>
          )}
          {data.output !== undefined && (
            <>
              <span style={styles.subLabel}>Output</span>
              <div style={styles.textBlock}>{data.output}</div>
            </>
          )}
          {showRaw && (
            <>
              <span style={styles.subLabel}>Raw moment JSON</span>
              <pre style={styles.textBlock}>{JSON.stringify(data, null, 2)}</pre>
            </>
          )}
          {toolCalls.length > 0 && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={styles.subLabel}>Tool calls ({toolCalls.length})</span>
                {toolCalls.length > 3 && (
                  <button
                    type="button"
                    onClick={() => setToolsExpanded((v) => !v)}
                    style={styles.toggle}
                  >
                    {toolsExpanded ? 'Collapse' : `Show all ${toolCalls.length}`}
                  </button>
                )}
              </div>
              <div style={styles.toolList}>
                {visibleTools.map((t, i) => (
                  <div key={i} style={styles.toolRow}>
                    <span>{t.tool_name}</span>
                    {t.latency_ms !== undefined && (
                      <span>{formatLatency(t.latency_ms)}</span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        <section aria-labelledby="moment-evals-title" style={styles.panel}>
          <h3 id="moment-evals-title" style={styles.panelTitle}>Eval results ({data.evals.length})</h3>
          {data.evals.length === 0 ? (
            <p style={styles.ctaHint}>
              No rules ran for this moment. The trace was logged but no eval was requested,
              or every applicable rule was skipped due to insufficient context.
            </p>
          ) : (
            data.evals.map((e) => {
              const failed = e.ruleResults.filter((r) => !r.passed && !r.skipped);
              const skipped = e.ruleResults.filter((r) => r.skipped);
              const passed = e.ruleResults.filter((r) => r.passed && !r.skipped);
              return (
                <div key={e.id} style={styles.evalGroup}>
                  <div style={styles.evalGroupHeader}>
                    <span>
                      {e.evalType} ·{' '}
                      <span style={{ color: e.passed ? 'var(--eval-pass)' : 'var(--eval-fail)' }}>
                        {e.passed ? 'pass' : 'fail'}
                      </span>{' '}
                      <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                        score {e.score.toFixed(2)}
                      </span>
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                      {passed.length}p · {failed.length}f · {skipped.length}s
                    </span>
                  </div>
                  {[...failed, ...passed, ...skipped].map((r) => (
                    <div key={r.ruleName} style={styles.ruleRow}>
                      <span
                        aria-hidden="true"
                        style={{
                          ...styles.ruleStatus,
                          background: r.skipped
                            ? 'var(--eval-skipped)'
                            : r.passed
                              ? 'var(--eval-pass)'
                              : 'var(--eval-fail)',
                        }}
                      />
                      <span style={styles.ruleName}>
                        <span style={styles.srOnly}>
                          {r.skipped ? 'Skipped: ' : r.passed ? 'Passed: ' : 'Failed: '}
                        </span>
                        {r.ruleName}
                      </span>
                      <span style={styles.ruleMessage}>{r.message}</span>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </section>
      </div>

      {composerOpen && (
        <MakeRuleModal
          moment={data}
          onClose={() => setComposerOpen(false)}
          onDeployed={() => setDeployedToast(`Rule for ${data.agentName}`)}
        />
      )}
    </div>
  );
}
