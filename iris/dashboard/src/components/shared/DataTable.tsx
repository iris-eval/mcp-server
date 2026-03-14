import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  render: (item: T) => ReactNode;
  sortable?: boolean;
  width?: string;
}

const styles = {
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 'var(--font-size-sm)',
  } as const,
  th: {
    textAlign: 'left',
    padding: 'var(--space-3) var(--space-4)',
    borderBottom: '1px solid var(--border-color)',
    color: 'var(--text-muted)',
    fontWeight: 500,
    fontSize: 'var(--font-size-xs)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  } as const,
  td: {
    padding: 'var(--space-3) var(--space-4)',
    borderBottom: '1px solid var(--border-color)',
    color: 'var(--text-primary)',
  } as const,
  tr: {
    transition: 'var(--transition-fast)',
  } as const,
  empty: {
    padding: 'var(--space-10)',
    textAlign: 'center',
    color: 'var(--text-muted)',
  } as const,
};

export function DataTable<T>({
  columns,
  data,
  onRowClick,
  emptyMessage = 'No data',
}: {
  columns: Column<T>[];
  data: T[];
  onRowClick?: (item: T) => void;
  emptyMessage?: string;
}) {
  if (data.length === 0) {
    return <div style={styles.empty as React.CSSProperties}>{emptyMessage}</div>;
  }

  return (
    <table style={styles.table}>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key} style={{ ...styles.th, width: col.width }}>
              {col.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((item, i) => (
          <tr
            key={i}
            style={{ ...styles.tr, cursor: onRowClick ? 'pointer' : 'default' }}
            onClick={() => onRowClick?.(item)}
            onMouseOver={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)';
            }}
            onMouseOut={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'transparent';
            }}
          >
            {columns.map((col) => (
              <td key={col.key} style={styles.td}>
                {col.render(item)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
