/*
 * roving — arrow-key movement inside a composite widget (a tablist or a
 * radio group), per the WAI-ARIA Authoring Practices:
 *
 *   - the group is ONE Tab stop: the selected item has tabIndex 0, the
 *     rest -1, so Tab moves past the group rather than through it;
 *   - the arrow keys move to the next or previous item and wrap;
 *   - Home and End move to the first and last item;
 *   - moving selects (automatic activation), because every view and
 *     every option here takes effect at once.
 *
 * Tabs move on Left and Right only (Up and Down stay with the page, which
 * scrolls); a menu moves on Up and Down only; a radio group on both.
 */
import type { KeyboardEvent } from 'react';

export type RovingAxes = 'horizontal' | 'vertical' | 'both';

/** The index a key moves to from `at` in a group of `count`, or -1 if the key does not move. */
export function rovingIndex(key: string, at: number, count: number, axes: RovingAxes): number {
  if (count <= 0) return -1;
  const last = count - 1;
  const across = axes !== 'vertical';
  const down = axes !== 'horizontal';
  const next = (across && key === 'ArrowRight') || (down && key === 'ArrowDown');
  const prev = (across && key === 'ArrowLeft') || (down && key === 'ArrowUp');
  // With no current item (at = -1), next is the first item and previous the last.
  if (next) return at < 0 || at === last ? 0 : at + 1;
  if (prev) return at <= 0 ? last : at - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  return -1;
}

/**
 * The keydown handler for one item of a group. `items` are the group's
 * item ids in order, `active` the selected one. On a movement key it
 * focuses the item it lands on (found by `role` inside the same group
 * element) and calls `select` with its id.
 */
export function onRovingKeyDown<T extends string>(
  event: KeyboardEvent<HTMLElement>,
  items: readonly T[],
  active: T,
  axes: RovingAxes,
  select: (id: T) => void,
): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const to = rovingIndex(event.key, items.indexOf(active), items.length, axes);
  if (to < 0) return;
  event.preventDefault();
  const role = event.currentTarget.getAttribute('role');
  const group = event.currentTarget.parentElement;
  const peers = group ? Array.from(group.querySelectorAll<HTMLElement>(`:scope > [role="${role}"]`)) : [];
  peers[to]?.focus();
  select(items[to]);
}
