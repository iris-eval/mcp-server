/*
 * The wildcard route (D-1). An address the router did not know used to
 * render the shell with nothing inside it — no heading, no sentence, no
 * way out. This says what happened and where the sections are.
 */
import { Link, useLocation } from 'react-router';

const SECTIONS: Array<{ to: string; label: string; what: string }> = [
  { to: '/', label: 'Dashboard', what: 'the failures, health, drift and stream views' },
  { to: '/moments', label: 'Decision Moments', what: 'every trace, classified by significance' },
  { to: '/rules', label: 'Custom Rules', what: 'the rules deployed on this server' },
  { to: '/audit', label: 'Audit Log', what: 'who deployed, paused or removed a rule' },
];

export function NotFoundPage() {
  const location = useLocation();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', padding: 'var(--space-6)' }} data-page="not-found">
      <div>
        <h2 style={{ margin: 0, fontSize: 'var(--font-size-xl)' }}>Nothing at this address</h2>
        <p style={{ margin: 'var(--space-2) 0 0', color: 'var(--text-muted)' }}>
          The dashboard has no page at <code>{location.pathname}</code>. A link may be out of date, or the address was typed by hand.
        </p>
      </div>
      <ul style={{ margin: 0, paddingLeft: 'var(--space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {SECTIONS.map((s) => (
          <li key={s.to}>
            <Link to={s.to}>{s.label}</Link> <span style={{ color: 'var(--text-muted)' }}>— {s.what}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
