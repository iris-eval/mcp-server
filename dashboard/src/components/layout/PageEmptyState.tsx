/*
 * PageEmptyState — shared empty-state primitive for list pages.
 *
 * Centered hero with optional icon, title, body, primary CTA + optional
 * code snippet (for setup commands). Uses display-tier typography so
 * empty states feel intentional, not accidental.
 */
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Icon } from '../shared/Icon';

const styles = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-4)',
    padding: 'var(--space-16) var(--space-6)',
    textAlign: 'center',
    background: 'var(--bg-card)',
    border: '1px dashed var(--border-default)',
    borderRadius: 'var(--radius-lg)',
  } as const,
  iconWrap: {
    width: '48px',
    height: '48px',
    borderRadius: 'var(--radius-lg)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-accent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  } as const,
  title: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-display-sm)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    letterSpacing: '-0.02em',
    margin: 0,
    lineHeight: 'var(--leading-heading)',
  } as const,
  body: {
    fontSize: 'var(--text-body)',
    color: 'var(--text-secondary)',
    maxWidth: '480px',
    lineHeight: 'var(--leading-body)',
    margin: 0,
  } as const,
  cmd: {
    margin: 'var(--space-2) 0',
    padding: 'var(--space-3) var(--space-4)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-body-sm)',
    color: 'var(--text-primary)',
  } as const,
};

export interface PageEmptyStateProps {
  icon?: LucideIcon;
  title: string;
  body?: ReactNode;
  /** Optional shell snippet shown in a mono code block. */
  command?: string;
  /** Primary action — e.g., "Open Decision Moments" link or button. */
  cta?: ReactNode;
}

export function PageEmptyState({ icon, title, body, command, cta }: PageEmptyStateProps) {
  return (
    <div style={styles.wrap} role="status">
      {icon && (
        <div style={styles.iconWrap}>
          <Icon as={icon} size={24} />
        </div>
      )}
      <h2 style={styles.title}>{title}</h2>
      {body && <p style={styles.body}>{body}</p>}
      {command && <code style={styles.cmd}>{command}</code>}
      {cta}
    </div>
  );
}
