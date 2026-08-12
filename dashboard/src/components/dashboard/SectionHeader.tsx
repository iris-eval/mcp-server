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

/* Static styling lives in utilities.css (.section-header block). */

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
    <div className="section-header">
      <div className="section-header__top">
        <h2 className="section-header__title">{title}</h2>
        {trailing && <span className="section-header__trailing">{trailing}</span>}
      </div>
      {question && <p className="section-header__question">{question}</p>}
    </div>
  );
}
