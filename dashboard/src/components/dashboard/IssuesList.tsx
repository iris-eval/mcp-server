/*
 * Recurring issues (arc 7, D-8): fires grouped by rule and by what the
 * rule found, over the recent window — ten fires of one pattern read as
 * one issue with a count. Read from /issues; the server groups.
 */
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { useIssues } from '../../api/hooks';
import type { IssueGroup } from '../../api/types';
import { DataTable, type Column } from '../shared/DataTable';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { QueryError } from '../shared/QueryError';
import { SectionHeader } from './SectionHeader';
import { TT } from '../shared/tooltipText';
import { formatTimeAgo } from '../../utils/formatters';

const ISSUE_LIMIT = '20';

const styles = {
  mono: { fontFamily: 'var(--font-mono)' } as CSSProperties,
  muted: { color: 'var(--text-muted)' } as CSSProperties,
  count: { fontFamily: 'var(--font-mono)', fontWeight: 600 } as CSSProperties,
};

export function IssuesList() {
  const issues = useIssues({ limit: ISSUE_LIMIT });
  if (issues.error) return <QueryError error={issues.error} what="recurring issues" onRetry={issues.refetch} />;
  if (issues.loading && !issues.data) return <LoadingSpinner />;
  const data = issues.data;
  if (!data || data.issues.length === 0) return null;

  const columns: Column<IssueGroup>[] = [
    { key: 'rule', header: 'Rule', width: '12rem', render: (g) => <code data-issue-rule={g.ruleName}>{g.ruleName}</code> },
    { key: 'signature', header: 'What it found', render: (g) => <span style={styles.mono} data-issue-signature={g.key}>{g.signature}</span> },
    { key: 'count', header: 'Fires', width: '5rem', render: (g) => <span style={styles.count} data-issue-count={g.key}>{g.count}</span> },
    { key: 'agents', header: 'Agents', width: '10rem', render: (g) => <span>{g.agents.length === 0 ? '—' : g.agents.join(', ')}</span> },
    { key: 'lastSeen', header: 'Last seen', width: '8rem', render: (g) => <span style={styles.muted}>{formatTimeAgo(g.lastSeen)}</span> },
    {
      key: 'labelled',
      header: 'Labelled',
      width: '9rem',
      render: (g) => (
        <span style={styles.mono} data-issue-labelled={g.key}>
          {g.labelled.right + g.labelled.wrong === 0 ? '—' : `${g.labelled.right} right · ${g.labelled.wrong} wrong`}
        </span>
      ),
    },
    {
      key: 'open',
      header: 'Open',
      width: '6rem',
      render: (g) => {
        const traceId = g.exampleTraceIds.find((t) => t !== null);
        return traceId ? (
          <Link to={`/traces/${traceId}`} data-issue-open={g.key}>
            open one
          </Link>
        ) : (
          <span style={styles.muted}>—</span>
        );
      },
    },
  ];

  return (
    <section aria-label="Recurring issues" data-issues="true" className="iris-stack">
      <SectionHeader title="Recurring issues" question={TT.issues} trailing={<span style={styles.muted}>over your last {data.window} evaluations</span>} />
      <DataTable columns={columns} data={data.issues} emptyMessage="No recurring issues" />
    </section>
  );
}
