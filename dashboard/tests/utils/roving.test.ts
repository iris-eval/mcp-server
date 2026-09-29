/*
 * rovingIndex — the arrow-key arithmetic shared by the view tabs, the
 * period and cohort radio groups, and the account menu.
 */
import { describe, it, expect } from 'vitest';
import { rovingIndex } from '../../src/utils/roving';

describe('rovingIndex', () => {
  it('moves right and left, wrapping at both ends', () => {
    expect(rovingIndex('ArrowRight', 0, 4, 'horizontal')).toBe(1);
    expect(rovingIndex('ArrowRight', 3, 4, 'horizontal')).toBe(0);
    expect(rovingIndex('ArrowLeft', 2, 4, 'horizontal')).toBe(1);
    expect(rovingIndex('ArrowLeft', 0, 4, 'horizontal')).toBe(3);
  });

  it('Home and End go to the ends on every axis', () => {
    for (const axes of ['horizontal', 'vertical', 'both'] as const) {
      expect(rovingIndex('Home', 2, 4, axes)).toBe(0);
      expect(rovingIndex('End', 1, 4, axes)).toBe(3);
    }
  });

  it('tabs leave Up and Down to the page; a menu leaves Left and Right; a radio group takes all four', () => {
    expect(rovingIndex('ArrowDown', 0, 4, 'horizontal')).toBe(-1);
    expect(rovingIndex('ArrowUp', 0, 4, 'horizontal')).toBe(-1);
    expect(rovingIndex('ArrowRight', 0, 4, 'vertical')).toBe(-1);
    expect(rovingIndex('ArrowDown', 0, 4, 'vertical')).toBe(1);
    expect(rovingIndex('ArrowUp', 0, 4, 'vertical')).toBe(3);
    expect(rovingIndex('ArrowDown', 1, 4, 'both')).toBe(2);
    expect(rovingIndex('ArrowRight', 1, 4, 'both')).toBe(2);
  });

  it('ignores other keys and empty groups', () => {
    expect(rovingIndex('Enter', 1, 4, 'both')).toBe(-1);
    expect(rovingIndex('a', 1, 4, 'both')).toBe(-1);
    expect(rovingIndex('ArrowRight', 0, 0, 'both')).toBe(-1);
  });

  it('with no current item, next is the first item and previous the last', () => {
    expect(rovingIndex('ArrowDown', -1, 4, 'vertical')).toBe(0);
    expect(rovingIndex('ArrowUp', -1, 4, 'vertical')).toBe(3);
  });
});
