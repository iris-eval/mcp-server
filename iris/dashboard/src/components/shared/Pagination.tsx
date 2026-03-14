const styles = {
  container: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 'var(--space-4) 0',
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text-secondary)',
  } as const,
  buttons: {
    display: 'flex',
    gap: 'var(--space-2)',
  } as const,
  button: {
    padding: 'var(--space-2) var(--space-4)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-sm)',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-size-sm)',
    cursor: 'pointer',
  } as const,
  disabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  } as const,
};

export function Pagination({
  total,
  limit,
  offset,
  onPageChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onPageChange: (offset: number) => void;
}) {
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  return (
    <div style={styles.container}>
      <span>
        Showing {offset + 1}-{Math.min(offset + limit, total)} of {total}
      </span>
      <div style={styles.buttons}>
        <button
          style={{ ...styles.button, ...(hasPrev ? {} : styles.disabled) }}
          onClick={() => hasPrev && onPageChange(offset - limit)}
          disabled={!hasPrev}
        >
          Previous
        </button>
        <span style={{ padding: 'var(--space-2)', color: 'var(--text-muted)' }}>
          {currentPage} / {totalPages}
        </span>
        <button
          style={{ ...styles.button, ...(hasNext ? {} : styles.disabled) }}
          onClick={() => hasNext && onPageChange(offset + limit)}
          disabled={!hasNext}
        >
          Next
        </button>
      </div>
    </div>
  );
}
