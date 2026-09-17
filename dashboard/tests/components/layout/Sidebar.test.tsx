/*
 * The sidebar has four entries for three concepts (D-5), every label from
 * NAV_LABELS, and none of the raw views or the moments timeline as a top-
 * level entry — those are reachable from Runs, Failures and the palette.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { axe } from 'jest-axe';
import { NAV_LABELS, NAV_LABEL_SETS } from '../../../src/components/layout/navLabels';

vi.mock('../../../src/hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: { sidebarCollapsed: false, theme: 'dark', density: 'compact', autoLaunch: true, dismissedBanners: [], momentFilters: {}, dismissedTours: [], archivedMoments: [] },
    displayPath: null,
    loading: false,
    error: null,
    patch: vi.fn().mockResolvedValue(null),
    refetch: vi.fn(),
  }),
}));
vi.mock('../../../src/components/command/CommandPaletteProvider', () => ({
  useCommandPalette: () => ({ open: vi.fn(), close: vi.fn(), toggle: vi.fn(), isOpen: false }),
}));

import { Sidebar } from '../../../src/components/layout/Sidebar';

function sidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe('Sidebar (D-5): four entries for three concepts', () => {
  it('shows exactly the four entries, named from NAV_LABELS, in order', () => {
    const { container } = sidebar();
    const nav = container.querySelector('nav');
    const labels = [...(nav?.querySelectorAll('a') ?? [])].map((a) => a.textContent?.trim());
    expect(labels).toEqual([NAV_LABELS.failures, NAV_LABELS.runs, NAV_LABELS.rules, NAV_LABELS.audit]);
    const hrefs = [...(nav?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/', '/runs', '/rules', '/audit']);
  });

  it('the raw views and the moments timeline are not top-level entries', () => {
    const { container } = sidebar();
    const text = container.querySelector('nav')?.textContent ?? '';
    for (const absent of ['Traces', 'Evaluations', NAV_LABELS.moments]) expect(text).not.toContain(absent);
  });

  it('both label sets name the same four entries, so one edit flips every surface', () => {
    expect(Object.keys(NAV_LABEL_SETS.current).sort()).toEqual(Object.keys(NAV_LABEL_SETS.proposed).sort());
    expect(NAV_LABEL_SETS.proposed).toEqual({ failures: 'Failures', runs: 'Runs', rules: 'Rules', audit: 'Audit', moments: 'Moments' });
  });

  it('has no axe violations', async () => {
    const { container } = sidebar();
    expect((await axe(container)).violations).toEqual([]);
  });
});
