/*
 * ViewTabs — the landing decision lives here.
 *
 * The default view IS the product call: the dashboard lands on the
 * failure list, with Health one click away. These tests pin that
 * behavior so a refactor can't quietly revert `/` to an aggregate.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { ViewTabs, resolveView, DEFAULT_VIEW } from '../../../src/components/dashboard/ViewTabs';
import { PeriodSelector } from '../../../src/components/dashboard/PeriodSelector';
import { CohortSelector } from '../../../src/components/dashboard/CohortSelector';

/** Renders the current URL so a test can read where a key press navigated to. */
function Location() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname + loc.search}</output>;
}

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

describe('ViewTabs · the ARIA tabs pattern', () => {
  it('each tab has the id its panel names, and only the selected tab names a panel', () => {
    render(
      <MemoryRouter initialEntries={['/?view=drift']}>
        <ViewTabs />
      </MemoryRouter>,
    );
    for (const [name, view] of [['Failures', 'failures'], ['Health', 'health'], ['Drift', 'drift'], ['Stream', 'stream']]) {
      expect(screen.getByRole('tab', { name })).toHaveAttribute('id', `${view}-tab`);
    }
    expect(screen.getByRole('tab', { name: 'Drift' })).toHaveAttribute('aria-controls', 'view-panel-drift');
    expect(screen.getByRole('tab', { name: 'Health' })).not.toHaveAttribute('aria-controls');
  });

  it('is one Tab stop: the selected tab', () => {
    render(
      <MemoryRouter initialEntries={['/?view=health']}>
        <ViewTabs />
      </MemoryRouter>,
    );
    expect(screen.getByRole('tab', { name: 'Health' })).toHaveAttribute('tabindex', '0');
    for (const name of ['Failures', 'Drift', 'Stream']) {
      expect(screen.getByRole('tab', { name })).toHaveAttribute('tabindex', '-1');
    }
  });

  it('Right, Left, Home and End select a tab, move focus to it, and keep the other params', () => {
    render(
      <MemoryRouter initialEntries={['/?period=7d']}>
        <ViewTabs />
        <Location />
      </MemoryRouter>,
    );
    const location = screen.getByTestId('location');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Failures' }), { key: 'ArrowRight' });
    expect(location).toHaveTextContent('/?period=7d&view=health');
    expect(screen.getByRole('tab', { name: 'Health' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Health' }), { key: 'End' });
    expect(location).toHaveTextContent('/?period=7d&view=stream');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Stream' }), { key: 'ArrowRight' });
    expect(location).toHaveTextContent('/?period=7d');
    expect(screen.getByRole('tab', { name: 'Failures' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Failures' }), { key: 'ArrowLeft' });
    expect(location).toHaveTextContent('/?period=7d&view=stream');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Stream' }), { key: 'Home' });
    expect(location).toHaveTextContent('/?period=7d');
  });

  it('keeps the period selector out of the tablist, which may own only tabs', () => {
    render(
      <MemoryRouter initialEntries={['/?view=health']}>
        <ViewTabs trailing={<PeriodSelector defaultPeriod="30d" />} />
      </MemoryRouter>,
    );
    const tablist = screen.getByRole('tablist');
    expect(tablist.querySelectorAll('[role="radiogroup"]')).toHaveLength(0);
    expect(screen.getByRole('radiogroup', { name: 'Time period' })).toBeInTheDocument();
  });
});

describe('radio groups · one Tab stop, arrows move and select', () => {
  it('PeriodSelector', () => {
    render(
      <MemoryRouter initialEntries={['/?view=health']}>
        <PeriodSelector defaultPeriod="30d" />
        <Location />
      </MemoryRouter>,
    );
    expect(screen.getByRole('radio', { name: '30d' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: '7d' })).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(screen.getByRole('radio', { name: '30d' }), { key: 'ArrowDown' });
    expect(screen.getByTestId('location')).toHaveTextContent('/?view=health&period=90d');
    expect(screen.getByRole('radio', { name: '90d' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: '90d' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(screen.getByRole('radio', { name: '90d' }), { key: 'ArrowRight' });
    expect(screen.getByTestId('location')).toHaveTextContent('/?view=health&period=24h');
  });

  it('CohortSelector', () => {
    render(
      <MemoryRouter initialEntries={['/?view=drift']}>
        <CohortSelector />
        <Location />
      </MemoryRouter>,
    );
    expect(screen.getByRole('radio', { name: 'All evaluations' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'By run' })).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'All evaluations' }), { key: 'ArrowRight' });
    expect(screen.getByTestId('location')).toHaveTextContent('/?view=drift&cohort=run');
    expect(screen.getByRole('radio', { name: 'By run' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('radio', { name: 'By run' }), { key: 'ArrowUp' });
    expect(screen.getByTestId('location')).toHaveTextContent('/?view=drift');
  });
});
