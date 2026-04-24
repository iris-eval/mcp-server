/*
 * Chrome a11y tests — AccountMenu + NotificationsPopover.
 *
 * The v2.C header chrome introduced two popovers that shipped with
 * Storybook stories + manual smoke but no axe coverage. Axe catches
 * what both miss: aria-expanded state correctness, aria-checked on
 * radio items, focus-trap behavior expectations, landmark roles.
 *
 * Both popovers share a trigger-pattern (button in header opens a
 * dialog/menu) so the tests exercise:
 *   - Closed state: trigger is the only interactive surface
 *   - Open state: menu/dialog rendered, aria-expanded="true",
 *     menuitemradio children have valid aria-checked
 *   - After-close cleanup: aria-expanded back to "false"
 *
 * Uses the same matcher-free axe pattern as the chart and detail-page
 * tests for vitest compatibility.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'jest-axe';

/*
 * ─── Mocks ──────────────────────────────────────────────────────────
 * Both components depend on the preferences + audit-log APIs. Stub
 * them so a11y is a pure render-tree property, not an I/O property.
 */
const preferencesMock = {
  preferences: {
    theme: 'dark' as const,
    density: 'compact' as const,
    sidebarCollapsed: false,
    notificationsLastSeen: undefined,
    autoLaunch: true,
    dismissedBanners: [],
    momentFilters: {},
    dismissedTours: [] as string[],
    archivedMoments: [] as string[],
  },
  loading: false,
  error: null,
  patch: vi.fn().mockResolvedValue(null),
  refetch: vi.fn(),
};

const useAuditLogMock = vi.fn();

vi.mock('../../src/hooks/usePreferences', () => ({
  usePreferences: () => preferencesMock,
  PreferencesProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../src/api/hooks', () => ({
  useAuditLog: (...args: unknown[]) => useAuditLogMock(...args),
  CADENCE: { FAST: 3000, NORMAL: 10000, SLOW: 30000 },
}));

vi.mock('../../src/components/layout/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'dark' as const, setTheme: vi.fn(), toggleTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { AccountMenu } from '../../src/components/layout/AccountMenu';
import { NotificationsPopover } from '../../src/components/layout/NotificationsPopover';
import type { AuditLogEntry } from '../../src/api/types';

const auditFixture: AuditLogEntry[] = [
  {
    ts: '2026-04-23T12:00:00Z',
    tenantId: 'local',
    action: 'rule.deploy',
    user: 'local',
    ruleId: 'rule-1',
    ruleName: 'no-stub-output',
  },
  {
    ts: '2026-04-23T11:00:00Z',
    tenantId: 'local',
    action: 'rule.toggle',
    user: 'local',
    ruleId: 'rule-2',
    ruleName: 'min-output-length',
  },
];

function wrap(ui: React.ReactElement): HTMLElement {
  const { container } = render(<MemoryRouter>{ui}</MemoryRouter>);
  return container;
}

describe('a11y · AccountMenu', () => {
  beforeEach(() => {
    preferencesMock.patch.mockClear();
  });

  it('closed state has no violations', async () => {
    const container = wrap(<AccountMenu />);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it('trigger exposes correct aria-expanded and aria-haspopup', () => {
    const container = wrap(<AccountMenu />);
    const btn = container.querySelector('[aria-label="Account menu"]');
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn!.getAttribute('aria-expanded')).toBe('false');
  });

  it('opened menu has no violations', async () => {
    const container = wrap(<AccountMenu />);
    const btn = container.querySelector('[aria-label="Account menu"]') as HTMLButtonElement;
    act(() => {
      fireEvent.click(btn);
    });
    // Menu is now in the DOM
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it('theme + density radios have aria-checked reflecting preferences', () => {
    const container = wrap(<AccountMenu />);
    fireEvent.click(container.querySelector('[aria-label="Account menu"]')!);
    const radios = container.querySelectorAll('[role="menuitemradio"]');
    // 2 theme + 2 density = 4 radios
    expect(radios.length).toBe(4);
    const checkedLabels = Array.from(radios)
      .filter((r) => r.getAttribute('aria-checked') === 'true')
      .map((r) => r.textContent?.trim());
    // Theme=dark + density=compact should both be checked
    expect(checkedLabels).toContain('Dark');
    expect(checkedLabels).toContain('Compact');
    // Light + Comfortable should NOT be checked
    const uncheckedLabels = Array.from(radios)
      .filter((r) => r.getAttribute('aria-checked') === 'false')
      .map((r) => r.textContent?.trim());
    expect(uncheckedLabels).toContain('Light');
    expect(uncheckedLabels).toContain('Comfortable');
  });

  it('Escape closes the menu', () => {
    const container = wrap(<AccountMenu />);
    const btn = container.querySelector('[aria-label="Account menu"]') as HTMLButtonElement;
    fireEvent.click(btn);
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('a11y · NotificationsPopover', () => {
  beforeEach(() => {
    preferencesMock.patch.mockClear();
  });

  it('closed state with no entries has no violations', async () => {
    useAuditLogMock.mockReturnValue({
      data: { entries: [], total: 0, limit: 10, offset: 0, path: '' },
      loading: false,
      error: null,
      rateLimitedUntil: null,
      refetch: vi.fn(),
    });
    const container = wrap(<NotificationsPopover />);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it('closed state with unread entries has no violations + unread badge', async () => {
    useAuditLogMock.mockReturnValue({
      data: { entries: auditFixture, total: 2, limit: 10, offset: 0, path: '' },
      loading: false,
      error: null,
      rateLimitedUntil: null,
      refetch: vi.fn(),
    });
    const container = wrap(<NotificationsPopover />);
    const btn = container.querySelector('[aria-label*="Notifications"]');
    expect(btn).not.toBeNull();
    // aria-label reflects unread count so AT users know there's new activity
    expect(btn!.getAttribute('aria-label')).toMatch(/2 unread/);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it('opened dialog has no violations + entries rendered as links', async () => {
    useAuditLogMock.mockReturnValue({
      data: { entries: auditFixture, total: 2, limit: 10, offset: 0, path: '' },
      loading: false,
      error: null,
      rateLimitedUntil: null,
      refetch: vi.fn(),
    });
    const container = wrap(<NotificationsPopover />);
    fireEvent.click(container.querySelector('[aria-label*="Notifications"]')!);
    const dialog = container.querySelector('[role="dialog"][aria-label="Notifications"]');
    expect(dialog).not.toBeNull();
    const entryLinks = dialog!.querySelectorAll('a');
    // 1 "View all →" + 2 audit entries
    expect(entryLinks.length).toBe(3);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it('Escape closes the popover', () => {
    useAuditLogMock.mockReturnValue({
      data: { entries: auditFixture, total: 2, limit: 10, offset: 0, path: '' },
      loading: false,
      error: null,
      rateLimitedUntil: null,
      refetch: vi.fn(),
    });
    const container = wrap(<NotificationsPopover />);
    fireEvent.click(container.querySelector('[aria-label*="Notifications"]')!);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('empty state renders explanatory text + no violations', async () => {
    useAuditLogMock.mockReturnValue({
      data: { entries: [], total: 0, limit: 10, offset: 0, path: '' },
      loading: false,
      error: null,
      rateLimitedUntil: null,
      refetch: vi.fn(),
    });
    const container = wrap(<NotificationsPopover />);
    fireEvent.click(container.querySelector('[aria-label*="Notifications"]')!);
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toMatch(/No rule activity yet/);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
