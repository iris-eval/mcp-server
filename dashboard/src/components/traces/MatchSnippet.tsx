import type { TraceMatch } from '../../api/types';

/*
 * Where a searched trace matched: the field, then the excerpt with the
 * matched words marked. The server sends the excerpt as fragments rather
 * than as markup, so the trace's own text is only ever rendered as text —
 * a trace that contains "<script>" shows those characters, nothing more.
 */
export const MATCH_FIELD_LABEL: Record<TraceMatch['field'], string> = {
  output: 'Output',
  input: 'Input',
  tool_calls: 'Tool call',
  metadata: 'Metadata',
};

const styles = {
  field: {
    display: 'inline-block',
    marginRight: 'var(--space-2)',
    color: 'var(--text-muted)',
    fontSize: 'var(--font-size-xs)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    whiteSpace: 'nowrap',
  } as const,
  text: {
    color: 'var(--text-secondary)',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    overflowWrap: 'anywhere',
  } as const,
  mark: {
    background: 'color-mix(in srgb, var(--iris-500) 28%, transparent)',
    color: 'var(--text-primary)',
    fontWeight: 600,
    borderRadius: '2px',
    padding: '0 1px',
  } as const,
};

export function MatchSnippet({ match }: { match: TraceMatch }) {
  return (
    <span style={styles.text} data-testid="match-snippet">
      <span style={styles.field}>{MATCH_FIELD_LABEL[match.field]}</span>
      {match.fragments.map((f, i) =>
        f.hit ? (
          <mark key={i} style={styles.mark}>
            {f.text}
          </mark>
        ) : (
          <span key={i}>{f.text}</span>
        ),
      )}
    </span>
  );
}
