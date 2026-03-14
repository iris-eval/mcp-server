import { useState } from 'react';

const styles = {
  container: {
    background: 'var(--bg-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius)',
    overflow: 'hidden',
  } as const,
  header: {
    padding: 'var(--space-2) var(--space-3)',
    background: 'var(--bg-tertiary)',
    cursor: 'pointer',
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text-secondary)',
    userSelect: 'none',
  } as const,
  content: {
    padding: 'var(--space-3)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-primary)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: '400px',
    overflow: 'auto',
  } as const,
};

export function JsonViewer({ data, label }: { data: unknown; label?: string }) {
  const [expanded, setExpanded] = useState(false);
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  return (
    <div style={styles.container}>
      <div style={styles.header} onClick={() => setExpanded(!expanded)}>
        {expanded ? '\u25BC' : '\u25B6'} {label ?? 'JSON'} ({typeof data === 'string' ? `${data.length} chars` : 'object'})
      </div>
      {expanded && <pre style={styles.content}>{text}</pre>}
    </div>
  );
}
