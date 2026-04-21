import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DataTable, type Column } from '../../../src/components/shared/DataTable';

interface Row {
  id: string;
  name: string;
}

const columns: Column<Row>[] = [
  { key: 'id', header: 'ID', render: (r) => r.id },
  { key: 'name', header: 'Name', render: (r) => r.name },
];

describe('DataTable', () => {
  it('renders headers and row data', () => {
    const rows: Row[] = [
      { id: 't1', name: 'Alice' },
      { id: 't2', name: 'Bob' },
    ];
    render(<DataTable columns={columns} data={rows} />);
    expect(screen.getByText('ID')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('renders empty message when data is empty', () => {
    render(<DataTable columns={columns} data={[]} emptyMessage="No rows" />);
    expect(screen.getByText('No rows')).toBeInTheDocument();
  });
});
