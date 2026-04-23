/*
 * AccountMenu — account dropdown triggered from the Header avatar button.
 *
 * Holds per-user chrome controls that shouldn't live in the header itself:
 *   - Theme switcher (dark / light)
 *   - Density toggle (compact / comfortable)
 *   - Links to Security + Architecture docs + Release notes (external)
 *   - Version + build stamp footer
 *
 * Why not individual buttons in the header? Per R2.5 the header is
 * reserved for page identity + live status + notifications — account-
 * level prefs cluster into this one menu so the header stays quiet.
 *
 * Signing out / switching workspaces belong in Cloud tier and are
 * intentionally absent here. OSS is single-user single-workspace.
 */
import { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Moon, Sun, Gauge, Shield, BookOpen, FileCode2, Check } from 'lucide-react';
import { Icon } from '../shared/Icon';
import { useTheme } from './ThemeProvider';
import { usePreferences } from '../../hooks/usePreferences';

const VERSION = '0.4.0-dev';

const styles = {
  triggerWrap: {
    position: 'relative',
    display: 'inline-block',
  } as const,
  trigger: {
    appearance: 'none',
    width: '32px',
    height: '32px',
    border: '1px solid var(--border-default)',
    background: 'var(--iris-950)',
    color: 'var(--iris-300)',
    borderRadius: '50%',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-caption)',
    fontWeight: 700,
    transition: 'background-color var(--transition-fast), border-color var(--transition-fast)',
  } as const,
  triggerOpen: {
    borderColor: 'var(--border-glow)',
  } as const,
  menu: {
    position: 'absolute',
    top: 'calc(100% + var(--space-2))',
    right: 0,
    minWidth: '260px',
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow-lg)',
    zIndex: 50,
    padding: 'var(--space-2)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
  } as const,
  sectionLabel: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption-xs)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: 'var(--text-muted)',
    padding: 'var(--space-1) var(--space-3)',
    marginTop: 'var(--space-1)',
  } as const,
  divider: {
    height: '1px',
    background: 'var(--border-subtle)',
    margin: 'var(--space-1) calc(-1 * var(--space-2))',
  } as const,
  item: {
    appearance: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    padding: 'var(--space-2) var(--space-3)',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-primary)',
    fontSize: 'var(--text-body-sm)',
    fontFamily: 'inherit',
    textAlign: 'left',
    width: '100%',
    cursor: 'pointer',
    borderRadius: 'var(--radius-xs)',
    textDecoration: 'none',
  } as const,
  itemActive: {
    color: 'var(--text-accent)',
  } as const,
  itemHover: {
    background: 'var(--bg-card-hover)',
  } as const,
  itemLabel: {
    flex: 1,
  } as const,
  footer: {
    padding: 'var(--space-2) var(--space-3)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption-xs)',
    color: 'var(--text-muted)',
    display: 'flex',
    justifyContent: 'space-between',
  } as const,
};

type ThemeOption = 'dark' | 'light';
type DensityOption = 'compact' | 'comfortable';

export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const { theme, setTheme } = useTheme();
  const { preferences, patch } = usePreferences();
  const density: DensityOption = preferences?.density ?? 'compact';

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current || !triggerRef.current) return;
      if (
        menuRef.current.contains(e.target as Node) ||
        triggerRef.current.contains(e.target as Node)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pickTheme = (next: ThemeOption) => {
    setTheme(next);
    patch({ theme: next }).catch(() => undefined);
  };

  const pickDensity = (next: DensityOption) => {
    patch({ density: next }).catch(() => undefined);
  };

  return (
    <div style={styles.triggerWrap}>
      <button
        ref={triggerRef}
        type="button"
        style={{ ...styles.trigger, ...(open ? styles.triggerOpen : {}) }}
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        I
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Account options"
          style={styles.menu}
        >
          <div style={styles.sectionLabel}>Theme</div>
          <MenuItem
            icon={Moon}
            label="Dark"
            active={theme === 'dark'}
            onClick={() => pickTheme('dark')}
          />
          <MenuItem
            icon={Sun}
            label="Light"
            active={theme === 'light'}
            onClick={() => pickTheme('light')}
          />

          <div style={styles.divider} />
          <div style={styles.sectionLabel}>Density</div>
          <MenuItem
            icon={Gauge}
            label="Compact"
            active={density === 'compact'}
            onClick={() => pickDensity('compact')}
          />
          <MenuItem
            icon={Gauge}
            label="Comfortable"
            active={density === 'comfortable'}
            onClick={() => pickDensity('comfortable')}
          />

          <div style={styles.divider} />
          <MenuLink
            href="https://iris-eval.com/security"
            icon={Shield}
            label="Security"
            external
          />
          <MenuLink
            href="https://github.com/iris-eval/mcp-server/blob/main/docs/architecture.md"
            icon={FileCode2}
            label="Architecture docs"
            external
          />
          <MenuLink
            href="https://github.com/iris-eval/mcp-server/releases"
            icon={BookOpen}
            label="Release notes"
            external
          />

          <div style={styles.divider} />
          <div style={styles.footer}>
            <span>Iris v{VERSION}</span>
            <span>local</span>
          </div>
        </div>
      )}
    </div>
  );
}

interface ItemBaseProps {
  icon: LucideIcon;
  label: string;
  active?: boolean;
}

function MenuItem({
  icon,
  label,
  active,
  onClick,
}: ItemBaseProps & { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      style={{
        ...styles.item,
        ...(hover ? styles.itemHover : {}),
        ...(active ? styles.itemActive : {}),
      }}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Icon as={icon} size={14} />
      <span style={styles.itemLabel}>{label}</span>
      {active && <Icon as={Check} size={14} />}
    </button>
  );
}

function MenuLink({
  icon,
  label,
  href,
  external,
}: ItemBaseProps & { href: string; external?: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <a
      role="menuitem"
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      style={{ ...styles.item, ...(hover ? styles.itemHover : {}) }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Icon as={icon} size={14} />
      <span style={styles.itemLabel}>{label}</span>
    </a>
  );
}
