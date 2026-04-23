/*
 * SectionHeader — names a story chapter on a dashboard view.
 *
 * The dashboard's information architecture isn't "9 cards stacked" — it's
 * "the page tells a 4-act story." This primitive marks the act break.
 *
 * Visual hierarchy (the thing the previous pass was missing):
 *   - Section heading is REAL h2 size (text-heading-sm), sentence case,
 *     not the 12px uppercase caption every card title uses.
 *   - Optional sub-line gives the chapter's question in plain language.
 *   - Optional period suffix anchors the section to the active window.
 *
 * Used to make the page scannable BOTH linearly (top-down narrative)
 * AND non-linearly (each section stands alone, eye knows where to land).
 */
import type { ReactNode } from 'react';

const styles = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    paddingTop: 'var(--space-3)',
    marginBottom: 'var(--space-1)',
  } as const,
  topRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 'var(--space-3)',
    flexWrap: 'wrap',
  } as const,
  title: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-heading-sm)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    letterSpacing: '-0.015em',
    margin: 0,
  } as const,
  trailing: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
  } as const,
  question: {
    fontSize: 'var(--text-body-sm)',
    color: 'var(--text-secondary)',
    margin: 0,
    fontStyle: 'italic',
  } as const,
};

export interface SectionHeaderProps {
  /** Section name — sentence case. */
  title: string;
  /** The question this section answers. Italicized one-liner. */
  question?: string;
  /** Optional right-aligned slot — typically a period label or count. */
  trailing?: ReactNode;
}

export function SectionHeader({ title, question, trailing }: SectionHeaderProps) {
  return (
    <div style={styles.wrap}>
      <div style={styles.topRow}>
        <h2 style={styles.title}>{title}</h2>
        {trailing && <span style={styles.trailing}>{trailing}</span>}
      </div>
      {question && <p style={styles.question}>{question}</p>}
    </div>
  );
}
