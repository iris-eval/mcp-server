import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
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

  it('a clickable row opens by a click anywhere, and by a named button in its first cell — never by a row that is itself a button', async () => {
    const opened: string[] = [];
    const withControl: Column<Row>[] = [...columns, { key: 'copy', header: 'Copy', render: (r) => <button type="button">Copy {r.id}</button> }];
    const { container } = render(
      <DataTable columns={withControl} data={[{ id: 't1', name: 'Alice' }]} onRowClick={(r) => opened.push(r.id)} rowActionLabel={(r) => `Open ${r.id}`} />,
    );
    expect(container.querySelector('tr[role="button"]')).toBeNull();
    fireEvent.click(screen.getByText('Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Open t1' }));
    expect(opened).toEqual(['t1', 't1']);
    // The control inside the row stays its own control: reachable, and not nested in another.
    expect(screen.getByRole('button', { name: 'Copy t1' })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('renders empty message when data is empty', () => {
    render(<DataTable columns={columns} data={[]} emptyMessage="No rows" />);
    expect(screen.getByText('No rows')).toBeInTheDocument();
  });
});
