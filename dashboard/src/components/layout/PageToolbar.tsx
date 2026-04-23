/*
 * PageToolbar — filter pills + actions strip beneath PageHeader.
 *
 * Standardized chrome that every list-shaped page uses: filter chips on
 * the left, action buttons on the right. Sized to the locked
 * --page-toolbar-height (40px) so the visual rhythm stays consistent
 * across all surfaces.
 */
import type { ReactNode } from 'react';

const styles = {
  toolbar: {
    minHeight: 'var(--page-toolbar-height)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--space-3)',
    flexWrap: 'wrap',
    padding: 'var(--space-2) var(--space-3)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius)',
    marginBottom: 'var(--space-4)',
  } as const,
  group: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    flexWrap: 'wrap',
  } as const,
};

export interface PageToolbarProps {
  /** Filter pills, time range pickers — anchored left. */
  filters?: ReactNode;
  /** Action buttons (Export CSV, + New, etc.) — anchored right. */
  actions?: ReactNode;
}

export function PageToolbar({ filters, actions }: PageToolbarProps) {
  return (
    <div style={styles.toolbar}>
      <div style={styles.group}>{filters}</div>
      <div style={styles.group}>{actions}</div>
    </div>
  );
}
