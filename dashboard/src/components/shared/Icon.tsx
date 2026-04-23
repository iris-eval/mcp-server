/*
 * Icon — single primitive that wraps lucide-react with our 4-size system
 * and currentColor inheritance. The whole dashboard uses this; never
 * import from lucide-react directly in feature components.
 *
 * Sizes (locked per Design System v2):
 *   - 14px: inline with body text
 *   - 16px: table cells, filter chips, dropdown carets
 *   - 20px: sidebar nav items, header buttons
 *   - 24px: primary CTAs, empty-state hero, modal headers
 *
 * Stroke: 1.5px Lucide default — DO NOT override per icon.
 *
 * Color: inherits from `color` (currentColor). Active state uses iris-9
 * via parent class; default uses neutral text token.
 */
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';

export type IconSize = 14 | 16 | 20 | 24;

export interface IconProps {
  /** Lucide icon component imported from 'lucide-react'. */
  as: LucideIcon;
  /** Pixel size — must be one of 14 / 16 / 20 / 24. */
  size?: IconSize;
  /** Optional aria-label. Set when icon stands alone (no adjacent text label). */
  label?: string;
  /** Inline style escape hatch — use sparingly; prefer parent class. */
  style?: CSSProperties;
  /** Optional className for further styling. */
  className?: string;
}

export function Icon({ as: Component, size = 16, label, style, className }: IconProps) {
  // aria-hidden when no label is provided — screen readers should ignore
  // decorative icons that sit next to a text label.
  const a11yProps = label
    ? { 'aria-label': label, role: 'img' as const }
    : { 'aria-hidden': true };
  return (
    <Component
      size={size}
      strokeWidth={1.5}
      style={{ flexShrink: 0, color: 'inherit', ...style }}
      className={className}
      {...a11yProps}
    />
  );
}
