/*
 * PageHeader — shared per-route title strip.
 *
 * Sits at the top of every page's content area. Optionally accepts a
 * trailing slot for actions (e.g., page-level "+ New rule" CTA) and a
 * meta slot for context (e.g., count badges, env indicators).
 *
 * Routes that adopt this drop their own per-page title divs in favor of
 * a single consistent layout.
 */
import type { ReactNode } from 'react';

const styles = {
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
    paddingBottom: 'var(--space-4)',
    borderBottom: '1px solid var(--border-subtle)',
    marginBottom: 'var(--space-5)',
  } as const,
  topRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 'var(--space-4)',
    flexWrap: 'wrap',
  } as const,
  titleBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
    minWidth: 0,
  } as const,
  title: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-heading)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    letterSpacing: '-0.01em',
    margin: 0,
    lineHeight: 'var(--leading-heading)',
  } as const,
  subtitle: {
    fontSize: 'var(--text-body-sm)',
    color: 'var(--text-secondary)',
    maxWidth: '720px',
    lineHeight: 'var(--leading-body)',
  } as const,
  metaRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
    flexShrink: 0,
  } as const,
};

export interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  /** Right-aligned slot for badges, counts, time-since indicators. */
  meta?: ReactNode;
  /** Right-aligned slot for primary actions. Renders below meta on wrap. */
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, meta, actions }: PageHeaderProps) {
  return (
    <div style={styles.header}>
      <div style={styles.topRow}>
        <div style={styles.titleBlock}>
          <h1 style={styles.title}>{title}</h1>
          {subtitle && <p style={styles.subtitle}>{subtitle}</p>}
        </div>
        <div style={styles.metaRow}>
          {meta}
          {actions}
        </div>
      </div>
    </div>
  );
}
