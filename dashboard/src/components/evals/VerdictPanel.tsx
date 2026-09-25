/*
 * The verdict panel: one evaluation's verdict with its basis,
 * the rules it was decided by, the risk estimate when one exists, coverage
 * by question with counts, and the composer's own sentences.
 *
 * The eight-step ladder — intention → question → method → evidence →
 * computation → uncertainty → result → interpretation — is progressive
 * disclosure: the panel shows result and interpretation, the rows show
 * evidence for failures, and one control ("How was this computed?") opens
 * method, computation and uncertainty on every row plus the composer's
 * facts here. The control's state is the parent's, so the rows follow it.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { Coverage, EvalRuleResult, Interpretation, Provenance, Verdict } from '../../api/types';
import { Badge } from '../shared/Badge';
import { ScoreBadge } from '../shared/ScoreBadge';
import { Tooltip } from '../shared/Tooltip';
import {
  ADDRESSEE_TEXT,
  BASIS_TEXT,
  NO_VERDICT_TEXT,
  QUESTION_LABEL,
  QUESTION_STATUS_TEXT,
  SEVERITY_TEXT,
  STATE_TEXT,
  composerFacts,
  confidenceChip,
  fmtRisk,
} from './verdictText';

export interface VerdictPanelProps {
  evalType: string;
  passed: boolean;
  score: number;
  verdict?: Verdict | null;
  coverage?: Coverage | null;
  interpretations?: Interpretation[] | null;
  provenance?: Provenance | null;
  criticalFailures?: string[] | null;
  criticalSkipped?: string[] | null;
  ruleResults: EvalRuleResult[];
  /** The full question text by id, when the page has capabilities; the short label otherwise. */
  questionText?: ReadonlyMap<string, string> | null;
  /** The ladder control's state — owned by the parent so the rows can follow it. */
  expanded: boolean;
  onToggleExpanded: () => void;
}

const TONE: Record<'pass' | 'fail' | 'unknown' | 'warn' | 'muted', { fg: string; bg: string }> = {
  pass: { fg: 'var(--eval-pass)', bg: 'rgba(34, 197, 94, 0.12)' },
  fail: { fg: 'var(--eval-fail)', bg: 'rgba(239, 68, 68, 0.14)' },
  unknown: { fg: 'var(--eval-warn)', bg: 'rgba(245, 158, 11, 0.14)' },
  warn: { fg: 'var(--eval-warn)', bg: 'rgba(245, 158, 11, 0.14)' },
  muted: { fg: 'var(--eval-skipped)', bg: 'rgba(148, 163, 184, 0.14)' },
};

const styles = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
    fontSize: 'var(--text-body-sm)',
  } as CSSProperties,
  head: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' } as CSSProperties,
  state: { fontWeight: 700, fontSize: 'var(--text-body)', letterSpacing: '0.02em' } as CSSProperties,
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
  muted: { color: 'var(--text-muted)', fontSize: 'var(--text-caption)' } as CSSProperties,
  mono: { fontFamily: 'var(--font-mono)' } as CSSProperties,
  list: { margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '2px' } as CSSProperties,
  question: { display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap' } as CSSProperties,
  sentence: { display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap' } as CSSProperties,
  notice: { fontWeight: 600, color: 'var(--eval-fail)' } as CSSProperties,
  toggle: {
    alignSelf: 'flex-start',
    background: 'transparent',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius-pill)',
    color: 'var(--text-secondary)',
    padding: '2px var(--space-2)',
    fontSize: 'var(--text-caption)',
    cursor: 'pointer',
  } as CSSProperties,
  facts: { margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px var(--space-3)' } as CSSProperties,
};

function Chip({ label, tone, tooltip, attr }: { label: string; tone: keyof typeof TONE; tooltip: ReactNode; attr: Record<string, string> }) {
  const colors = TONE[tone];
  return (
    <Tooltip content={tooltip}>
      <span style={{ ...styles.chip, color: colors.fg, background: colors.bg }} tabIndex={0} {...attr}>
        {label}
      </span>
    </Tooltip>
  );
}

const SEVERITY_TONE: Record<Interpretation['severity'], keyof typeof TONE> = { block: 'fail', warn: 'warn', note: 'muted' };
const STATUS_TONE: Record<Coverage['questions'][number]['status'], keyof typeof TONE> = {
  judged: 'pass',
  unjudged: 'unknown',
  not_applicable: 'muted',
};

export function VerdictPanel({
  evalType,
  passed,
  score,
  verdict = null,
  coverage = null,
  interpretations = null,
  provenance = null,
  criticalFailures = null,
  criticalSkipped = null,
  ruleResults,
  questionText = null,
  expanded,
  onToggleExpanded,
}: VerdictPanelProps) {
  const counts = {
    failed: ruleResults.filter((r) => !r.passed && !r.skipped).length,
    passed: ruleResults.filter((r) => r.passed && !r.skipped).length,
    skipped: ruleResults.filter((r) => r.skipped).length,
  };
  const state = verdict ? STATE_TEXT[verdict.state] : passed ? STATE_TEXT.pass : STATE_TEXT.fail;
  const composer = provenance?.composer ?? null;
  // The server writes the composer's notes only for a row that carries its composer facts.
  const chip = verdict ? confidenceChip(verdict, composer, composer !== null && (interpretations?.length ?? 0) > 0) : null;

  return (
    <div style={styles.panel} data-verdict-panel={evalType}>
      <div style={styles.head}>
        <Badge label={evalType} />
        <span style={{ ...styles.state, color: TONE[state.tone].fg }} data-verdict-state={verdict?.state ?? (passed ? 'pass' : 'fail')}>
          {state.label}
        </span>
        {verdict && <Chip label={verdict.basis} tone={state.tone} tooltip={BASIS_TEXT[verdict.basis]} attr={{ 'data-basis': verdict.basis }} />}
        {verdict && verdict.by.length > 0 && (
          <span style={{ ...styles.muted, ...styles.mono }} data-by={verdict.by.join(',')}>
            by {verdict.by.join(', ')}
          </span>
        )}
        {verdict?.risk && (
          <Tooltip content="The composer's estimate that this output is bad, from the rules that fired at their published accuracy and the prior in force, with its 95% credible interval.">
            <span style={{ ...styles.muted, ...styles.mono }} tabIndex={0} data-risk={verdict.risk.pBad.toFixed(2)}>
              {fmtRisk(verdict.risk)}
            </span>
          </Tooltip>
        )}
        {verdict?.confidence && chip && (
          <Chip label={verdict.confidence} tone={chip.tone} tooltip={chip.tooltip} attr={{ 'data-confidence': verdict.confidence, 'data-confidence-tone': chip.tone }} />
        )}
        <Tooltip content="The weighted score is a quality gradient. The composer never consults it.">
          <span tabIndex={0}>
            <ScoreBadge score={score} passed={passed} />
          </span>
        </Tooltip>
        <span style={styles.muted}>
          {counts.passed}p · {counts.failed}f · {counts.skipped}s
        </span>
      </div>

      {!verdict && <p style={styles.muted} data-no-verdict="true">{NO_VERDICT_TEXT}</p>}

      {criticalFailures && criticalFailures.length > 0 && (
        <div style={styles.notice} data-vetoed-by={criticalFailures.join(',')}>
          Vetoed by {criticalFailures.join(', ')}: a critical rule failed, so the verdict is fail regardless of the other rules.
        </div>
      )}
      {criticalSkipped && criticalSkipped.length > 0 && (
        <div style={{ ...styles.notice, color: 'var(--eval-warn)' }} data-critical-skipped={criticalSkipped.join(',')}>
          Critical and could not judge: {criticalSkipped.join(', ')}. The verdict is unknown, not clean.
        </div>
      )}

      {coverage && coverage.questions.length > 0 && (
        <ul style={styles.list} aria-label="Coverage by question">
          {coverage.questions.map((q) => (
            <li key={q.id} style={styles.question} data-question={q.id} data-question-status={q.status}>
              <Tooltip content={questionText?.get(q.id) ?? QUESTION_LABEL[q.id] ?? q.id}>
                <span tabIndex={0}>{QUESTION_LABEL[q.id] ?? q.id}</span>
              </Tooltip>
              <Chip label={q.status.replace('_', ' ')} tone={STATUS_TONE[q.status]} tooltip={QUESTION_STATUS_TEXT[q.status]} attr={{ 'data-status': q.status }} />
              {q.of !== undefined && (
                <span style={{ ...styles.muted, ...styles.mono }} data-evaluated={`${q.evaluated ?? 0}/${q.of}`}>
                  {q.evaluated ?? 0} of {q.of} rules ran
                </span>
              )}
              {q.why && <span style={styles.muted}>{q.why}</span>}
            </li>
          ))}
        </ul>
      )}

      {interpretations && interpretations.length > 0 && (
        <ul style={styles.list} aria-label="What the composer says">
          {interpretations.map((it, i) => (
            <li
              key={i}
              style={styles.sentence}
              data-interpretation={it.severity}
              data-interpretation-rule={it.rule ?? undefined}
              data-config-key={it.configKey ?? undefined}
            >
              <Chip label={it.severity} tone={SEVERITY_TONE[it.severity]} tooltip={SEVERITY_TEXT[it.severity]} attr={{ 'data-severity': it.severity }} />
              <Chip label={it.addressee} tone="muted" tooltip={ADDRESSEE_TEXT[it.addressee]} attr={{ 'data-addressee': it.addressee }} />
              <span>{it.text}</span>
              {it.configKey && (
                <code style={{ ...styles.muted, ...styles.mono }}>{it.configKey}</code>
              )}
            </li>
          ))}
        </ul>
      )}

      {(verdict || composer) && (
        <button type="button" style={styles.toggle} onClick={onToggleExpanded} aria-expanded={expanded} data-ladder-toggle="true">
          {expanded ? 'Hide how it was computed' : 'How was this computed?'}
        </button>
      )}

      {expanded && composer && (
        <dl style={styles.facts} aria-label="The composer's facts" data-composer-facts="true">
          {composerFacts(composer).map((f) => (
            <div key={f.key} style={{ display: 'contents' }}>
              <dt style={{ ...styles.muted, ...styles.mono }}>
                {f.key} = {f.value}
              </dt>
              <dd style={{ margin: 0, ...styles.muted }}>{f.sentence}</dd>
            </div>
          ))}
          {provenance && (
            <>
              <dt style={{ ...styles.muted, ...styles.mono }}>provenance</dt>
              <dd style={{ margin: 0, ...styles.muted, ...styles.mono }}>
                iris {provenance.irisVersion} · rules {provenance.rulesetHash.slice(0, 12)} · config {provenance.configHash.slice(0, 12)} · corpus{' '}
                {provenance.corpusVersion}
              </dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}
