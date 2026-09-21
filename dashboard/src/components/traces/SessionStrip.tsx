/*
 * The session strip (arc 9, N-15): a trace is one turn of a conversation;
 * this shows the others. Rendered only when the trace carries a session id,
 * it reads the session's turns in time order through the same list route a
 * reader would call (`GET /api/v1/traces?session=…`), says which turn this
 * is, and links the previous and the next. A page for sessions is arc-10
 * work; the strip is what makes one findable from any of its turns.
 */
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { useTraces } from '../../api/hooks';
import type { Trace } from '../../api/types';

const styles = {
  strip: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: 'var(--space-3)',
    padding: 'var(--space-2) var(--space-3)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--surface-2, var(--surface))',
    fontSize: 'var(--text-caption)',
  } as CSSProperties,
  mono: { fontFamily: 'var(--font-mono)' } as CSSProperties,
  muted: { color: 'var(--text-muted)' } as CSSProperties,
  turns: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', margin: 0, padding: 0, listStyle: 'none' } as CSSProperties,
  turn: { padding: '0 var(--space-2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' } as CSSProperties,
  current: { borderColor: 'var(--accent)', fontWeight: 600 } as CSSProperties,
};

/** The turns of `trace`'s session, in time order, with this one marked. */
export function SessionStrip({ trace }: { trace: Trace }) {
  const sessionId = trace.session_id;
  const { data } = useTraces(sessionId ? { session: sessionId, sort_by: 'timestamp', sort_order: 'asc', limit: '200' } : undefined);
  if (!sessionId) return null;
  const turns = (data?.traces ?? []).filter((t) => t.session_id === sessionId);
  const index = turns.findIndex((t) => t.trace_id === trace.trace_id);
  const n = turns.length;
  const prev = index > 0 ? turns[index - 1] : null;
  const next = index >= 0 && index < n - 1 ? turns[index + 1] : null;
  return (
    <nav aria-label="Session" style={styles.strip} data-session-strip={sessionId}>
      <span style={styles.muted}>Session</span>
      <span style={styles.mono}>{sessionId}</span>
      {n > 0 && index >= 0 && (
        <span data-session-turn={index + 1} data-session-turns={n}>
          turn {index + 1} of {n}
        </span>
      )}
      {prev && (
        <Link to={`/traces/${encodeURIComponent(prev.trace_id)}`} data-session-prev={prev.trace_id}>
          ← previous turn
        </Link>
      )}
      {next && (
        <Link to={`/traces/${encodeURIComponent(next.trace_id)}`} data-session-next={next.trace_id}>
          next turn →
        </Link>
      )}
      {n > 1 && (
        <ol style={styles.turns} aria-label="Turns in this session">
          {turns.map((t, i) => (
            <li key={t.trace_id} style={{ ...styles.turn, ...(i === index ? styles.current : {}) }} data-session-turn-link={t.trace_id}>
              {i === index ? (
                <span aria-current="page">{i + 1}</span>
              ) : (
                <Link to={`/traces/${encodeURIComponent(t.trace_id)}`} title={t.input ? t.input.slice(0, 80) : t.trace_id}>
                  {i + 1}
                </Link>
              )}
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}
