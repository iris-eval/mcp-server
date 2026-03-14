import type { EvalResult } from '../../api/types';
import { DataTable, type Column } from '../shared/DataTable';
import { Badge } from '../shared/Badge';
import { ScoreBadge } from '../shared/ScoreBadge';
import { TimeAgo } from '../shared/TimeAgo';

export function EvalTable({
  evals,
  onSelect,
}: {
  evals: EvalResult[];
  onSelect: (evalResult: EvalResult) => void;
}) {
  const columns: Column<EvalResult>[] = [
    {
      key: 'eval_type',
      header: 'Type',
      render: (e) => <Badge label={e.eval_type} />,
    },
    {
      key: 'passed',
      header: 'Result',
      render: (e) => <Badge label={e.passed ? 'PASS' : 'FAIL'} variant={e.passed ? 'pass' : 'fail'} />,
      width: '80px',
    },
    {
      key: 'score',
      header: 'Score',
      render: (e) => <ScoreBadge score={e.score} passed={e.passed} />,
      width: '80px',
    },
    {
      key: 'rules',
      header: 'Rules',
      render: (e) => `${e.rule_results.filter((r) => r.passed).length}/${e.rule_results.length}`,
      width: '80px',
    },
    {
      key: 'output',
      header: 'Output',
      render: (e) => (
        <span style={{ color: 'var(--text-muted)', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
          {e.output_text.slice(0, 100)}
        </span>
      ),
    },
    {
      key: 'created_at',
      header: 'Time',
      render: (e) => e.created_at ? <TimeAgo timestamp={e.created_at} /> : '—',
      width: '120px',
    },
  ];

  return <DataTable columns={columns} data={evals} onRowClick={onSelect} emptyMessage="No evaluations found" />;
}
