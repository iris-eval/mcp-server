export function EmptyState({ message = 'No data yet' }: { message?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-12)',
        color: 'var(--text-muted)',
        fontSize: 'var(--font-size-lg)',
      }}
    >
      <p>{message}</p>
    </div>
  );
}
