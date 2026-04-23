/*
 * MomentDetailPage — single Decision Moment surface (Phase B2).
 *
 * Three sections:
 *   1. Significance hero — verdict, why-this-is-significant, key stats
 *   2. Input/Output — the actual content the agent saw and produced
 *   3. Eval results — every rule that fired, grouped by eval_type
 *
 * The "Make this a rule" CTA is a placeholder for B3 (the composer).
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMomentDetail } from '../../api/hooks';
import { CopyableId } from '../shared/CopyableId';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { formatCost, formatLatency, formatTimestamp } from '../../utils/formatters';
import { getSignificanceVisual, getVerdictVisual } from './significance';
import { MakeRuleModal } from './MakeRuleModal';

const styles = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-6)',
  } as const,
  back: {
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text-muted)',
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
  } as const,
  hero: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderLeft: '3px solid transparent',
    borderRadius: 'var(--border-radius-lg)',
    padding: 'var(--space-6)',
    display: 'grid',
    gridTemplateColumns: 'auto 1fr auto',
    gap: 'var(--space-5)',
    alignItems: 'center',
  } as const,
  glyph: {
    width: '64px',
    height: '64px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 'var(--font-size-2xl)',
    fontFamily: 'var(--font-mono)',
    fontWeight: 700,
    color: 'var(--bg-primary)',
  } as const,
  heroBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
    minWidth: 0,
  } as const,
  significanceName: {
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-muted)',
  } as const,
  significanceLabel: {
    fontSize: 'var(--font-size-xl)',
    fontWeight: 700,
    color: 'var(--text-primary)',
    margin: 0,
  } as const,
  significanceReason: {
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text-secondary)',
    margin: 0,
    maxWidth: '640px',
    lineHeight: 1.5,
  } as const,
  ctaCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
    alignItems: 'flex-end',
  } as const,
  cta: {
    appearance: 'none',
    background: 'var(--accent-primary)',
    color: 'var(--bg-primary)',
    border: 'none',
    borderRadius: 'var(--border-radius)',
    padding: 'var(--space-2) var(--space-4)',
    fontSize: 'var(--font-size-sm)',
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
  } as const,
  ctaDisabled: {
    background: 'var(--bg-tertiary)',
    color: 'var(--text-muted)',
    cursor: 'not-allowed',
  } as const,
  ctaHint: {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
  } as const,
  metaRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 'var(--space-4)',
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
  } as const,
  twoCol: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 'var(--space-4)',
  } as const,
  panel: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-lg)',
    padding: 'var(--space-5)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  } as const,
  panelTitle: {
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'var(--font-mono)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-muted)',
    margin: 0,
  } as const,
  textBlock: {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-3)',
    fontSize: 'var(--font-size-sm)',
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
    fontSize: 'var(--font-size-sm)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    paddingBottom: 'var(--space-1)',
    borderBottom: '1px solid var(--border-color)',
  } as const,
  ruleRow: {
    display: 'grid',
    gridTemplateColumns: '20px 1fr auto',
    gap: 'var(--space-2)',
    alignItems: 'baseline',
    padding: 'var(--space-1) 0',
    fontSize: 'var(--font-size-sm)',
  } as const,
  ruleStatus: {
    width: '14px',
    height: '14px',
    borderRadius: '50%',
    display: 'inline-block',
  } as const,
  ruleName: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)',
  } as const,
  ruleMessage: {
    color: 'var(--text-muted)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
    textAlign: 'right',
    maxWidth: '50%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  } as const,
  toggle: {
    appearance: 'none',
    background: 'transparent',
    border: '1px solid var(--border-color)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-2)',
    cursor: 'pointer',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'inherit',
  } as const,
  toolList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
  } as const,
  toolRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: 'var(--space-1) var(--space-2)',
    borderRadius: 'var(--border-radius-sm)',
    background: 'var(--bg-tertiary)',
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
        <div style={{ ...styles.panel, borderColor: 'var(--accent-error)' }}>
          <h2 style={{ color: 'var(--accent-error)', margin: 0 }}>Could not load moment</h2>
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

      <div style={{ ...styles.hero, borderLeftColor: sig.color }}>
        <span style={{ ...styles.glyph, background: sig.color }} aria-label={sig.name}>
          {sig.glyph}
        </span>
        <div style={styles.heroBody}>
          <span style={styles.significanceName}>{sig.name}</span>
          <h2 style={styles.significanceLabel}>{data.significance.label}</h2>
          <p style={styles.significanceReason}>{data.significance.reason}</p>
          <div style={styles.metaRow}>
            <span style={{ color: verdict.color, fontWeight: 700 }}>{verdict.label}</span>
            <span>{data.agentName}</span>
            <span>{formatTimestamp(data.timestamp)}</span>
            {data.costUsd !== undefined && <span>{formatCost(data.costUsd)}</span>}
            {data.latencyMs !== undefined && <span>{formatLatency(data.latencyMs)}</span>}
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
      </div>

      {deployedToast && (
        <div style={{ ...styles.panel, borderColor: 'var(--accent-success)' }}>
          <strong style={{ color: 'var(--accent-success)' }}>✓ {deployedToast} deployed</strong>
          <span style={{ ...styles.ctaHint, color: 'var(--text-secondary)' }}>
            The rule is live and will fire on every future evaluation of its category. Audit
            entry written to <code>~/.iris/audit.log</code>.
          </span>
        </div>
      )}

      <div style={styles.twoCol}>
        <div style={styles.panel}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={styles.panelTitle}>Input → Output</h3>
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
              <span style={styles.panelTitle}>Input</span>
              <div style={styles.textBlock}>{data.input}</div>
            </>
          )}
          {data.output !== undefined && (
            <>
              <span style={styles.panelTitle}>Output</span>
              <div style={styles.textBlock}>{data.output}</div>
            </>
          )}
          {showRaw && (
            <>
              <span style={styles.panelTitle}>Raw moment JSON</span>
              <pre style={styles.textBlock}>{JSON.stringify(data, null, 2)}</pre>
            </>
          )}
          {toolCalls.length > 0 && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={styles.panelTitle}>Tool calls ({toolCalls.length})</span>
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
        </div>

        <div style={styles.panel}>
          <h3 style={styles.panelTitle}>Eval results ({data.evals.length})</h3>
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
                      <span style={{ color: e.passed ? 'var(--accent-success)' : 'var(--accent-error)' }}>
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
                        style={{
                          ...styles.ruleStatus,
                          background: r.skipped
                            ? 'var(--text-muted)'
                            : r.passed
                              ? 'var(--accent-success)'
                              : 'var(--accent-error)',
                        }}
                      />
                      <span style={styles.ruleName}>{r.ruleName}</span>
                      <span style={styles.ruleMessage}>{r.message}</span>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>
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
