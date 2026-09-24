/*
 * Sidebar v2 — Design System v2.B chrome rebuild.
 *
 * 256px expanded / 64px collapsed. Lucide icons per route. Three
 * navigation groups (MAIN, AUTHORING, RAW DATA) per R2.4 section spec.
 * Active state shows a 3px iris-500 left-rail accent. Footer holds
 * settings, shortcuts, version + env, collapse toggle.
 *
 * Collapse state persists via preferences.sidebarCollapsed (server-
 * mediated through the existing preferences API). Theme + density
 * toggles live in the account menu — NOT here — per R2.5 spec.
 */
import {
  LayoutDashboard,
  Sparkles,
  History,
  Layers,
} from 'lucide-react';
import { useCallback } from 'react';
import { NavItem } from './NavItem';
import { NavGroup } from './NavGroup';
import { SidebarFooter } from './SidebarFooter';
import { usePreferences } from '../../hooks/usePreferences';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { NAV_LABELS } from './navLabels';
import { useCommandPalette } from '../command/CommandPaletteProvider';

const styles = {
  sidebar: {
    width: 'var(--sidebar-width-expanded)',
    background: 'var(--bg-raised)',
    borderRight: '1px solid var(--border-subtle)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    transition: 'width var(--transition-base) var(--ease-iris)',
    flexShrink: 0,
  } as const,
  sidebarCollapsed: {
    width: 'var(--sidebar-width-collapsed)',
  } as const,
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
    padding: 'var(--space-4) var(--space-5)',
    height: 'var(--header-height)',
    borderBottom: '1px solid var(--border-subtle)',
  } as const,
  brandCollapsed: {
    justifyContent: 'center',
    padding: 'var(--space-4) 0',
  } as const,
  brandLogo: {
    width: '24px',
    height: '24px',
    flexShrink: 0,
    color: 'var(--iris-500)',
  } as const,
  brandWordmark: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-heading-sm)',
    fontWeight: 700,
    color: 'var(--text-primary)',
    letterSpacing: '-0.01em',
  } as const,
  navContainer: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
    paddingTop: 'var(--space-4)',
    overflowY: 'auto',
    overflowX: 'hidden',
  } as const,
};

export function Sidebar() {
  const { preferences, patch } = usePreferences();
  const { openShortcuts } = useCommandPalette();

  /*
   * Phone width: below the tablet breakpoint the sidebar is
   * the icon rail whatever the preference says. The width is an inline
   * style (the collapse transition needs it), so the stylesheet rule that
   * used to "compress" it at this width never applied — a 256px sidebar
   * left a 390px phone 134px for the page, and the failure list's links
   * had no width at all. The preference is untouched: the toggle still
   * records it, and it takes effect again on a wider viewport.
   */
  const isNarrow = useMediaQuery('(max-width: 767px)');
  const preferred = preferences?.sidebarCollapsed ?? false;
  const collapsed = isNarrow || preferred;

  const onToggleCollapse = useCallback(() => {
    patch({ sidebarCollapsed: !preferred }).catch(() => undefined);
  }, [patch, preferred]);

  // env hostname: derive from window.location for local dev. v0.5 cloud
  // tier will replace with workspace+region.
  const env =
    typeof window !== 'undefined' ? window.location.host : 'localhost';

  return (
    <aside
      style={{ ...styles.sidebar, ...(collapsed ? styles.sidebarCollapsed : {}) }}
      aria-label="Main navigation"
    >
      <div style={{ ...styles.brand, ...(collapsed ? styles.brandCollapsed : {}) }}>
        <svg
          style={styles.brandLogo}
          viewBox="0 0 32 32"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-label="Iris"
        >
          <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="2.5" />
          <circle cx="16" cy="16" r="8" fill="var(--iris-600)" />
          <circle cx="16" cy="16" r="3.5" fill="#0a0f0e" />
          <circle cx="13" cy="13.5" r="1.5" fill="white" opacity="0.6" />
        </svg>
        {!collapsed && <span style={styles.brandWordmark}>Iris</span>}
      </div>

      <nav style={styles.navContainer}>
        {/*
         * Four entries for three concepts (D-5): what failed, the data,
         * authoring. Traces and evaluations are raw views reachable from
         * Runs; the moments timeline is reachable from Failures and the
         * palette. The names come from NAV_LABELS — one edit flips them.
         */}
        <NavGroup label="Main" collapsed={collapsed}>
          <NavItem to="/" label={NAV_LABELS.failures} icon={LayoutDashboard} collapsed={collapsed} end />
          <NavItem to="/runs" label={NAV_LABELS.runs} icon={Layers} collapsed={collapsed} />
        </NavGroup>

        <NavGroup label="Authoring" collapsed={collapsed}>
          <NavItem to="/rules" label={NAV_LABELS.rules} icon={Sparkles} collapsed={collapsed} />
          <NavItem to="/audit" label={NAV_LABELS.audit} icon={History} collapsed={collapsed} />
        </NavGroup>
      </nav>

      <SidebarFooter
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        onOpenShortcuts={openShortcuts}
        env={env}
      />
    </aside>
  );
}
