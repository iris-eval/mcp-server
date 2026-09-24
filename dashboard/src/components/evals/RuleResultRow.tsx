/*
 * One rule result, rendered once.
 *
 * Every field the composer stamps on a rule result has a place here: the
 * state, the kind, the role, criticality with its source, the evidence
 * (spans quoted from the text when the page has it, a link to the tool call
 * when the evidence names one), the error bar with its basis, the measured
 * value, the skip reason and its class, and the rule's definition behind one
 * disclosure. A row stamped before 0.9.0 says so instead of showing blanks.
 *
 * The trace page's evaluation card and the moment page both render this and
 * nothing else; a test holds that no second renderer exists.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { BuiltInRuleMeta, EvalRuleResult, RuleProofSummary, VerdictLabelValue } from '../../api/types';
import { Badge } from '../shared/Badge';
import { ScoreBadge } from '../shared/ScoreBadge';
import { Tooltip } from '../shared/Tooltip';
import { TT } from '../shared/tooltipText';
import {
  CRITICAL_SOURCE_TEXT,
  KIND_TEXT,
  PRE_STAMP_TEXT,
  ROLE_TEXT,
  SKIP_CLASS_TEXT,
  describeEvidence,
  describeUncertainty,
  fmtInterval,
  isPreStamp,
  ruleState,
  type EvidenceTexts,
} from './ruleResultText';

export interface RuleResultRowProps {
  result: EvalRuleResult;
  /** The rule's definition from GET /rules/builtin, when the page has it. */
  meta?: BuiltInRuleMeta | null;
  /** The published interval, for a row that carries no error bar of its own (older rows, measurements). */
  proof?: RuleProofSummary | null;
  /** Where a tool-call evidence item links — the page's own anchors or the trace page's. */
  callHref?: (index: number) => string;
  /** The texts the evidence spans point into, when the page has them. */
  texts?: EvidenceTexts;
  /**
   * The ladder's depth. `default` shows the result and, for a failed
   * row, its evidence; `full` adds method, computation and uncertainty —
   * the measured value, the error bar, the published interval and the
   * definition. Pages pass the verdict panel's control; alone, a row shows
   * everything.
   */
  depth?: 'default' | 'full';
  /**
   * Your label on this rule's fire, and the handler that
   * writes one. The control appears only on a FAILED row and only when a
   * page supplies the handler: a label is a judgement on a fire, so a quiet
   * or skipped rule has nothing here to be right or wrong about.
   */
  label?: VerdictLabelValue | null;
  onLabel?: (rule: string, label: VerdictLabelValue) => void;
  labelBusy?: boolean;
}

const SR_ONLY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

const styles = {
  row: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 'var(--space-1)',
    padding: 'var(--space-1_5) var(--space-2)',
    background: 'var(--bg-base)',
    borderRadius: 'var(--radius-xs)',
    fontSize: 'var(--text-body-sm)',
  } as CSSProperties,
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    flexWrap: 'wrap',
  } as CSSProperties,
  mark: { width: '16px', flex: '0 0 auto' } as CSSProperties,
  name: { color: 'var(--text-secondary)', fontSize: 'var(--text-caption)', fontFamily: 'var(--font-mono)' } as CSSProperties,
  message: { flex: 1, color: 'var(--text-muted)', fontSize: 'var(--text-caption)', minWidth: '12ch' } as CSSProperties,
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px var(--space-1_5)',
    borderRadius: 'var(--radius-pill)',
    fontSize: 'var(--text-caption-xs)',
    fontFamily: 'var(--font-mono)',
    fontWeight: 600,
    lineHeight: 1.6,
    cursor: 'default',
    whiteSpace: 'nowrap',
  } as CSSProperties,
  detail: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    paddingLeft: 'calc(16px + var(--space-2))',
    color: 'var(--text-muted)',
    fontSize: 'var(--text-caption)',
  } as CSSProperties,
  evidenceList: { margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '2px' } as CSSProperties,
  quote: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)',
    background: 'var(--bg-surface)',
    padding: '1px var(--space-1_5)',
    borderRadius: 'var(--radius-xs)',
    overflowWrap: 'anywhere',
  } as CSSProperties,
  definition: { marginTop: '2px' } as CSSProperties,
  summary: { cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 'var(--text-caption)' } as CSSProperties,
  definitionBody: { margin: 'var(--space-1) 0 0', paddingLeft: 'var(--space-3)', display: 'grid', gap: '2px' } as CSSProperties,
  value: { fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', fontSize: 'var(--text-caption)' } as CSSProperties,
  labelGroup: { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)', marginLeft: 'auto' } as CSSProperties,
  labelAsk: { color: 'var(--text-muted)', fontSize: 'var(--text-caption-xs)', whiteSpace: 'nowrap' } as CSSProperties,
  labelButton: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption-xs)',
    padding: '1px var(--space-1_5)',
    borderRadius: 'var(--radius-pill)',
    border: '1px solid var(--border-color)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    lineHeight: 1.6,
  } as CSSProperties,
};

const LABEL_ON: Record<VerdictLabelValue, CSSProperties> = {
  right: { color: 'var(--eval-pass)', borderColor: 'var(--eval-pass)', fontWeight: 700 },
  wrong: { color: 'var(--eval-fail)', borderColor: 'var(--eval-fail)', fontWeight: 700 },
};

type Tone = 'neutral' | 'fail' | 'warn' | 'muted';

const TONE: Record<Tone, { fg: string; bg: string }> = {
  neutral: { fg: 'var(--text-secondary)', bg: 'rgba(148, 163, 184, 0.14)' },
  fail: { fg: 'var(--eval-fail)', bg: 'rgba(239, 68, 68, 0.14)' },
  warn: { fg: 'var(--eval-warn)', bg: 'rgba(245, 158, 11, 0.14)' },
  muted: { fg: 'var(--eval-skipped)', bg: 'rgba(148, 163, 184, 0.10)' },
};

function Chip({ label, tone, tooltip, attr }: { label: string; tone: Tone; tooltip: ReactNode; attr: Record<string, string> }) {
  const colors = TONE[tone];
  return (
    <Tooltip content={tooltip}>
      <span style={{ ...styles.chip, color: colors.fg, background: colors.bg }} tabIndex={0} {...attr}>
        {label}
      </span>
    </Tooltip>
  );
}

const ROLE_TONE: Record<NonNullable<EvalRuleResult['role']>, Tone> = {
  gate: 'warn',
  veto: 'fail',
  risk: 'neutral',
  advisory: 'muted',
};

export function RuleResultRow({ result, meta = null, proof = null, callHref, texts, depth = 'full', label = null, onLabel, labelBusy = false }: RuleResultRowProps) {
  const full = depth === 'full';
  const state = ruleState(result);
  const color = state === 'skipped' ? 'var(--eval-skipped)' : state === 'passed' ? 'var(--eval-pass)' : 'var(--eval-fail)';
  const mark = state === 'skipped' ? '○' : state === 'passed' ? '✓' : '✗';
  const srLabel = state === 'skipped' ? 'Skipped: ' : state === 'passed' ? 'Passed: ' : 'Failed: ';
  const preStamp = isPreStamp(result);
  const uncertainty = describeUncertainty(result.uncertainty);
  const evidence = (result.evidence ?? []).map((e) => describeEvidence(e, texts));
  const published = !uncertainty && proof?.ci95.precision ? proof : null;
  const showEvidence = evidence.length > 0 && (full || state === 'failed');
  const showComputation = full && Boolean(uncertainty || published || meta);

  return (
    <div className="eval-card__rule" style={styles.row} data-rule-state={state} data-rule-name={result.ruleName}>
      <div style={styles.head}>
        <span className="eval-card__rule-mark" style={{ ...styles.mark, color }} aria-hidden="true">
          {mark}
        </span>
        <code className="eval-card__rule-name" style={styles.name}>
          <span style={SR_ONLY}>{srLabel}</span>
          {result.ruleName}
        </code>
        {result.kind && <Chip label={result.kind} tone="neutral" tooltip={KIND_TEXT[result.kind]} attr={{ 'data-kind': result.kind }} />}
        {result.role && (
          <Chip label={result.role} tone={ROLE_TONE[result.role]} tooltip={ROLE_TEXT[result.role]} attr={{ 'data-role': result.role }} />
        )}
        {result.critical && (
          <Chip
            label={`critical · ${result.criticalSource ?? 'default'}`}
            tone="fail"
            tooltip={CRITICAL_SOURCE_TEXT[result.criticalSource ?? 'default']}
            attr={{ 'data-critical-source': result.criticalSource ?? 'default' }}
          />
        )}
        <span className="eval-card__rule-message" style={styles.message}>
          {result.message}
        </span>
        {full && result.value && (
          <span style={styles.value} data-measured={result.value.stat}>
            {result.value.stat} {result.value.value} {result.value.unit}
          </span>
        )}
        {state === 'skipped' ? <Badge label="SKIPPED" variant="UNSET" /> : <ScoreBadge score={result.score} passed={result.passed} />}
        {state === 'failed' && onLabel && (
          <span
            style={styles.labelGroup}
            role="group"
            aria-label={`Was ${result.ruleName} right to fire?`}
            data-label-control={result.ruleName}
            data-label={label ?? 'none'}
          >
            <span style={styles.labelAsk}>right to fire?</span>
            {(['right', 'wrong'] as const).map((value) => (
              <Tooltip key={value} content={value === 'right' ? TT.labelRight : TT.labelWrong}>
                <button
                  type="button"
                  aria-pressed={label === value}
                  disabled={labelBusy}
                  style={{ ...styles.labelButton, ...(label === value ? LABEL_ON[value] : {}) }}
                  onClick={() => onLabel(result.ruleName, value)}
                >
                  {value}
                </button>
              </Tooltip>
            ))}
          </span>
        )}
      </div>

      {(preStamp || state === 'skipped' || result.evidenceIncomplete || showEvidence || showComputation) && (
        <div style={styles.detail}>
          {preStamp && <span data-pre-stamp="true">{PRE_STAMP_TEXT}</span>}

          {state === 'skipped' && (
            <span data-skip-reason="true">
              {result.skipReason ?? 'Skipped without a reason recorded.'}
              {result.skipClass && ` — ${SKIP_CLASS_TEXT[result.skipClass]}`}
            </span>
          )}

          {result.evidenceIncomplete && (
            <span data-evidence-incomplete="true">Evidence was truncated: the rule read more than it could keep.</span>
          )}

          {showEvidence && (
            <ul style={styles.evidenceList} aria-label={`Evidence for ${result.ruleName}`}>
              {evidence.map((e, i) => (
                <li key={i} data-evidence-type={e.type}>
                  {e.callIndex !== undefined && callHref ? (
                    <a href={callHref(e.callIndex)} data-show-call={e.callIndex}>
                      {e.text}
                    </a>
                  ) : (
                    <span>{e.text}</span>
                  )}
                  {e.quote && (
                    <>
                      {' '}
                      <q style={styles.quote}>{e.quote}</q>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {full && uncertainty && (
            <Tooltip content={uncertainty.sentence}>
              <span tabIndex={0} data-uncertainty={result.uncertainty?.basis}>
                {uncertainty.label}
              </span>
            </Tooltip>
          )}

          {full && published && published.ci95.precision && (
            <Tooltip
              content={`Published precision for this rule on the labelled corpus (n = ${published.n}, release ${published.release}); this row carries no error bar of its own.`}
            >
              <span tabIndex={0} data-uncertainty="published_table">
                published precision{' '}
                {fmtInterval({ point: published.precision ?? 0, lo: published.ci95.precision[0], hi: published.ci95.precision[1] })}
              </span>
            </Tooltip>
          )}

          {full && meta && (
            <details style={styles.definition} data-definition={meta.name}>
              <summary style={styles.summary}>definition</summary>
              <dl style={styles.definitionBody}>
                <div>{meta.description}</div>
                {meta.question && <div>Question: {meta.question}</div>}
                {meta.needs && meta.needs.length > 0 && <div>Needs: {meta.needs.join(', ')}</div>}
                {meta.mechanism && <div>Mechanism: {meta.mechanism}</div>}
                {(result.ruleVersion ?? meta.version) !== undefined && <div>Rule version: {result.ruleVersion ?? meta.version}</div>}
              </dl>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
