import { NavLink } from 'react-router-dom';

const styles = {
  sidebar: {
    width: '220px',
    background: 'var(--bg-secondary)',
    borderRight: '1px solid var(--border-color)',
    display: 'flex',
    flexDirection: 'column',
    padding: 'var(--space-4)',
  } as const,
  logo: {
    fontSize: 'var(--font-size-xl)',
    fontWeight: 700,
    color: 'var(--accent-primary)',
    marginBottom: 'var(--space-8)',
    padding: 'var(--space-2)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
  } as const,
  logoIcon: {
    width: '24px',
    height: '24px',
  } as const,
  nav: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
  } as const,
  link: {
    padding: 'var(--space-2) var(--space-3)',
    borderRadius: 'var(--border-radius-sm)',
    color: 'var(--text-secondary)',
    fontSize: 'var(--font-size-sm)',
    transition: 'var(--transition-fast)',
    textDecoration: 'none',
    display: 'block',
  } as const,
  activeLink: {
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
  } as const,
};

const links = [
  { to: '/', label: 'Dashboard' },
  { to: '/traces', label: 'Traces' },
  { to: '/evals', label: 'Evaluations' },
];

export function Sidebar() {
  return (
    <aside style={styles.sidebar}>
      <div style={styles.logo}>
        <svg style={styles.logoIcon} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="2.5"/>
          <circle cx="16" cy="16" r="7" fill="currentColor" opacity="0.3"/>
          <circle cx="16" cy="16" r="3.5" fill="currentColor"/>
        </svg>
        Iris
      </div>
      <nav style={styles.nav}>
        {links.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            style={({ isActive }) => ({
              ...styles.link,
              ...(isActive ? styles.activeLink : {}),
            })}
          >
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
