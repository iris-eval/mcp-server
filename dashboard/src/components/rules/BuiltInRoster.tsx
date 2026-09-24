/*
 * The built-in roster with its proof: every rule Iris ships,
 * what kind of claim it makes, how it works, which question it answers,
 * whether it is critical and by whose say-so, and its published precision
 * on the labelled corpus — or the honest "no family" when it has none.
 * Read once from /rules/builtin and /capabilities; nothing is typed here.
 */
import type { CSSProperties } from 'react';
import { useBuiltInRules, useCapabilities } from '../../api/hooks';
import type { BuiltInRuleMeta, RuleProofSummary } from '../../api/types';
import { DataTable, type Column } from '../shared/DataTable';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { QueryError } from '../shared/QueryError';
import { Tooltip } from '../shared/Tooltip';
import { KIND_TEXT } from '../evals/ruleResultText';
import { QUESTION_LABEL } from '../evals/verdictText';
import type { QuestionId } from '../../api/types';

const styles = {
  card: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius)',
    padding: 'var(--space-4)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  } as CSSProperties,
  head: { display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', flexWrap: 'wrap' } as CSSProperties,
  h2: { margin: 0, fontSize: 'var(--text-body)', fontWeight: 600 } as CSSProperties,
  muted: { color: 'var(--text-muted)', fontSize: 'var(--text-caption)' } as CSSProperties,
  mono: { fontFamily: 'var(--font-mono)' } as CSSProperties,
  critical: { color: 'var(--eval-fail)', fontWeight: 600 } as CSSProperties,
};

export function fmtPrecision(p: RuleProofSummary | null | undefined): string {
  if (!p || p.precision === null || !p.ci95.precision) return 'no family';
  return `${p.precision.toFixed(2)} [${p.ci95.precision[0].toFixed(2)}, ${p.ci95.precision[1].toFixed(2)}] · n = ${p.n}`;
}

export function BuiltInRoster() {
  const rules = useBuiltInRules();
  const capabilities = useCapabilities();

  if (rules.error) return <QueryError error={rules.error} what="the built-in rules" onRetry={rules.refetch} />;
  if (rules.loading && !rules.data) return <LoadingSpinner />;
  const roster = [...(rules.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  if (roster.length === 0) return null;

  const proofs = new Map((capabilities.data?.rules ?? []).map((r) => [r.name, r.proof]));
  const withProof = roster.filter((r) => proofs.get(r.name)?.precision != null).length;
  const first = [...proofs.values()].find((p) => p !== null) ?? null;

  const columns: Column<BuiltInRuleMeta>[] = [
    { key: 'name', header: 'Rule', render: (r) => <code data-roster-rule={r.name}>{r.name}</code> },
    {
      key: 'kind',
      header: 'Kind',
      width: '8rem',
      render: (r) =>
        r.kind ? (
          <Tooltip content={KIND_TEXT[r.kind]}>
            <span tabIndex={0} style={styles.mono}>
              {r.kind}
            </span>
          </Tooltip>
        ) : (
          <span style={styles.muted}>—</span>
        ),
    },
    { key: 'mechanism', header: 'How', width: '7rem', render: (r) => <span style={styles.mono}>{r.mechanism ?? '—'}</span> },
    {
      key: 'question',
      header: 'Answers',
      width: '9rem',
      render: (r) => (r.question ? (QUESTION_LABEL[r.question as QuestionId] ?? r.question) : <span style={styles.muted}>—</span>),
    },
    {
      key: 'critical',
      header: 'Critical',
      width: '9rem',
      render: (r) =>
        r.critical ? (
          <span style={styles.critical} data-roster-critical={r.criticalSource}>
            yes · {r.criticalSource}
          </span>
        ) : (
          <span style={styles.muted}>no</span>
        ),
    },
    { key: 'version', header: 'v', width: '3rem', render: (r) => <span style={styles.mono}>{r.version ?? '—'}</span> },
    {
      key: 'precision',
      header: 'Published precision',
      width: '16rem',
      render: (r) => (
        <span style={styles.mono} data-roster-precision={r.name}>
          {fmtPrecision(proofs.get(r.name))}
        </span>
      ),
    },
  ];

  return (
    <section style={styles.card} aria-label="Built-in rules" data-roster="true">
      <div style={styles.head}>
        <h2 style={styles.h2}>Built-in rules</h2>
        <span style={styles.muted} data-roster-count={roster.length}>
          {roster.length} rules · {withProof} with a published error rate
          {first && ` · corpus ${first.corpusVersion} · release ${first.release} · ${first.labelling === 'human-verified' ? 'human-verified labels' : 'same-model labels'}`}
        </span>
      </div>
      <p style={styles.muted}>
        What each rule claims, how it decides, which question it answers, and how often its fires were right on the labelled corpus. A rule with no family
        has no published error rate and says so on every result.
      </p>
      <DataTable columns={columns} data={roster} emptyMessage="No built-in rules reported" />
    </section>
  );
}
