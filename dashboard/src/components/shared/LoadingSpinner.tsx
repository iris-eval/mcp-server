export function LoadingSpinner() {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 'var(--space-12)',
        color: 'var(--text-muted)',
      }}
    >
      Loading...
    </div>
  );
}
