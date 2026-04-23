/*
 * NavGroup — sidebar section with an uppercase caption header + child
 * NavItems. Hides the header when the sidebar is collapsed (icon-only
 * mode); items still render so the rail stays organized in the same
 * vertical order even though section labels are hidden.
 */
import type { ReactNode } from 'react';

const styles = {
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-0_5)',
  } as const,
  label: {
    padding: 'var(--space-3) var(--space-5) var(--space-1)',
    fontSize: 'var(--text-caption-xs)',
    fontWeight: 600,
    fontFamily: 'var(--font-body)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: 'var(--text-muted)',
  } as const,
  divider: {
    height: '1px',
    background: 'var(--border-subtle)',
    margin: 'var(--space-2) var(--space-3)',
  } as const,
};

export function NavGroup({
  label,
  collapsed,
  children,
}: {
  label: string;
  collapsed?: boolean;
  children: ReactNode;
}) {
  return (
    <div style={styles.group} role="group" aria-label={label}>
      {collapsed ? (
        <div style={styles.divider} aria-hidden="true" />
      ) : (
        <div style={styles.label}>{label}</div>
      )}
      {children}
    </div>
  );
}
