/*
 * NavItem — single sidebar navigation item.
 *
 * Renders a Lucide icon + label + optional badge slot. Active state
 * shows a 3px left-rail accent stripe + icon/text shift to the iris
 * brand color. Hover state lightens the background. When the sidebar
 * is collapsed (icon-only at 64px), the label is replaced with a
 * native `title` tooltip.
 */
import { NavLink } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Icon } from '../shared/Icon';

const styles = {
  link: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
    padding: 'var(--space-2) var(--space-3)',
    margin: '0 var(--space-2)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-secondary)',
    fontSize: 'var(--text-body)',
    fontWeight: 500,
    fontFamily: 'var(--font-body)',
    textDecoration: 'none',
    transition: 'background-color var(--transition-fast), color var(--transition-fast)',
    minHeight: '32px',
  } as const,
  linkCollapsed: {
    justifyContent: 'center',
    padding: 'var(--space-2) 0',
  } as const,
  linkHover: {
    background: 'var(--bg-card-hover)',
    color: 'var(--text-primary)',
  } as const,
  active: {
    color: 'var(--text-primary)',
    background: 'var(--bg-card-hover)',
    fontWeight: 600,
  } as const,
  activeRail: {
    position: 'absolute',
    left: 0,
    top: '6px',
    bottom: '6px',
    width: '3px',
    background: 'var(--iris-500)',
    borderRadius: '0 2px 2px 0',
  } as const,
  label: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  badge: {
    minWidth: '18px',
    height: '18px',
    padding: '0 var(--space-1_5)',
    borderRadius: 'var(--radius-pill)',
    background: 'var(--iris-600)',
    color: 'white',
    fontSize: 'var(--text-caption-xs)',
    fontWeight: 600,
    fontFamily: 'var(--font-mono)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
  } as const,
};

export interface NavItemProps {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Set when sidebar is collapsed — hides label, adds tooltip. */
  collapsed?: boolean;
  /** Optional unread/notification count. Renders as a pill. */
  badge?: number;
  /** Optional end={true} for exact-match routes (e.g., '/'). */
  end?: boolean;
}

export function NavItem({ to, label, icon, collapsed = false, badge, end }: NavItemProps) {
  return (
    <NavLink
      to={to}
      end={end}
      title={collapsed ? label : undefined}
      style={({ isActive }): CSSProperties => ({
        ...styles.link,
        ...(collapsed ? styles.linkCollapsed : {}),
        ...(isActive ? styles.active : {}),
      })}
      aria-label={collapsed ? label : undefined}
    >
      {({ isActive }) => (
        <>
          {isActive && <span style={styles.activeRail} aria-hidden="true" />}
          <Icon as={icon} size={20} />
          {!collapsed && (
            <>
              <span style={styles.label}>{label}</span>
              {badge !== undefined && badge > 0 && (
                <span style={styles.badge} aria-label={`${badge} unseen`}>
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </>
          )}
        </>
      )}
    </NavLink>
  );
}
