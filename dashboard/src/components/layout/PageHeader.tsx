/*
 * PageHeader — page-level context strip beneath the app chrome.
 *
 * The app `<Header>` (resolveRouteMeta) carries the page identity (h1
 * title + short subtitle + status pill). PageHeader is for *richer*
 * per-page context that doesn't belong in the chrome — long-form
 * description, count badges, action buttons, env indicators.
 *
 * NOTE: `title` is intentionally optional and renders as `h2`, not `h1`.
 * The chrome already owns the document's only `h1`. Pages that don't
 * need a secondary heading can pass only `subtitle` + `meta`/`actions`.
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
    flex: '1 1 480px',
  } as const,
  title: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-heading-sm)',
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
    margin: 0,
  } as const,
  metaRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
    flexShrink: 0,
  } as const,
};

export interface PageHeaderProps {
  /**
   * Optional secondary heading. The chrome owns the page's `h1`; this
   * renders as `h2` when provided. Most pages should omit this and just
   * supply `subtitle`.
   */
  title?: string;
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
          {title && <h2 style={styles.title}>{title}</h2>}
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
