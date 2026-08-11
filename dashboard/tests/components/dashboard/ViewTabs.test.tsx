/*
 * ViewTabs — the landing decision lives here.
 *
 * The default view IS the product call: the dashboard lands on the
 * failure list, with Health one click away. These tests pin that
 * behavior so a refactor can't quietly revert `/` to an aggregate.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ViewTabs, resolveView, DEFAULT_VIEW } from '../../../src/components/dashboard/ViewTabs';

describe('resolveView', () => {
  it('defaults to failures — the dashboard lands on the failure', () => {
    expect(DEFAULT_VIEW).toBe('failures');
    expect(resolveView(new URLSearchParams())).toBe('failures');
  });

  it('resolves every explicit view', () => {
    expect(resolveView(new URLSearchParams('view=failures'))).toBe('failures');
    expect(resolveView(new URLSearchParams('view=health'))).toBe('health');
    expect(resolveView(new URLSearchParams('view=drift'))).toBe('drift');
    expect(resolveView(new URLSearchParams('view=stream'))).toBe('stream');
  });

  it('falls back to failures on unknown values', () => {
    expect(resolveView(new URLSearchParams('view=fleet'))).toBe('failures');
  });
});

describe('ViewTabs', () => {
  it('marks Failures active on `/` and keeps Health one click away', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <ViewTabs />
      </MemoryRouter>,
    );
    expect(screen.getByRole('tab', { name: 'Failures' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const health = screen.getByRole('tab', { name: 'Health' });
    expect(health).toHaveAttribute('aria-selected', 'false');
    expect(health).toHaveAttribute('href', '/?view=health');
  });

  it('links the default tab back to bare `/` (no redundant view param)', () => {
    render(
      <MemoryRouter initialEntries={['/?view=health']}>
        <ViewTabs />
      </MemoryRouter>,
    );
    expect(screen.getByRole('tab', { name: 'Failures' })).toHaveAttribute('href', '/');
  });
});
