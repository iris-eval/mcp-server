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
  rowAction: {
    appearance: 'none',
    background: 'none',
    border: 0,
    padding: 0,
    margin: 0,
    color: 'inherit',
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
  } as const,
};

/*
 * A clickable row. The whole row answers a click, and the keyboard reaches
 * it through a real button in its first cell, named by rowActionLabel. The
 * row itself used to be role="button": a button's content is presentational
 * to assistive technology, so a control inside a row — a copy-id button —
 * was unreachable, and axe reports it as nested-interactive (serious).
 */

export function DataTable<T>({
  columns,
  data,
  onRowClick,
  rowActionLabel,
  emptyMessage = 'No data',
}: {
  columns: Column<T>[];
  data: T[];
  onRowClick?: (item: T) => void;
  /** The accessible name of a row's open button, e.g. "Open trace 3f2a (support-bot)". Defaults to the first cell's text. */
  rowActionLabel?: (item: T) => string;
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
            {columns.map((col, ci) => (
              <td key={col.key} style={styles.td}>
                {onRowClick && ci === 0 ? (
                  <button
                    type="button"
                    style={styles.rowAction}
                    aria-label={rowActionLabel?.(item)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRowClick(item);
                    }}
                  >
                    {col.render(item)}
                  </button>
                ) : (
                  col.render(item)
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
