/*
 * The header states (D-2): every chip is a fact from the server's last
 * answer, and the pill can go red.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { axe } from 'jest-axe';
import { reportConnection, resetConnection } from '../../../src/api/connection';
import { ApiError } from '../../../src/api/errors';
import type { HealthResponse, CapabilitiesSummary } from '../../../src/api/types';

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

vi.mock('../../../src/hooks/usePreferences', () => ({
  usePreferences: () => preferencesMock,
  PreferencesProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../../src/components/layout/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'dark' as const, setTheme: vi.fn(), toggleTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Not under test here; each has its own suite.
vi.mock('../../../src/components/command/CommandPaletteTrigger', () => ({
  CommandPaletteTrigger: () => null,
}));
vi.mock('../../../src/components/layout/NotificationsPopover', () => ({
  NotificationsPopover: () => null,
}));

const healthMock = vi.fn();
const capabilitiesMock = vi.fn();

vi.mock('../../../src/api/hooks', () => ({
  useHealth: () => healthMock(),
  useCapabilities: () => capabilitiesMock(),
  CADENCE: { FAST: 3000, NORMAL: 10000, SLOW: 30000 },
}));

import { Header } from '../../../src/components/layout/Header';

const ok: HealthResponse = {
  status: 'ok',
  version: '0.13.0',
  uptime_seconds: 42,
  trace_count: 3,
  storage: 'connected',
  judge: { enabled: false, provider: null },
  mode: 'real',
};

const capabilities: CapabilitiesSummary = {
  version: '0.13.0',
  judge: {
    enabled: false,
    howToEnable: [
      'Set ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment that starts Iris.',
      'Restart the server; the capabilities resource then reports the judge as enabled.',
    ],
  },
  retention: { days: 30, sweepIntervalHours: 24 },
  dashboard: { enabled: true, url: null, mode: 'real' },
};

function query<T>(data: T | null, extra: Record<string, unknown> = {}) {
  return { data, loading: false, error: null, refetch: vi.fn(), rateLimitedUntil: null, ...extra };
}

function renderHeader() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Header />
    </MemoryRouter>,
  );
}

function pill(): HTMLElement {
  const el = document.querySelector('header [data-status]');
  if (!el) throw new Error('no status pill rendered');
  return el as HTMLElement;
}

describe('Header (D-2): the pill is the server, not a constant', () => {
  beforeEach(() => {
    resetConnection();
    healthMock.mockReturnValue(query(ok));
    capabilitiesMock.mockReturnValue(query(capabilities));
  });

  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('a healthy answer renders live, the judge chip, and no DEMO', () => {
    renderHeader();
    expect(pill().getAttribute('data-status')).toBe('live');
    expect(pill().textContent).toBe('live');
    const judge = document.querySelector('header [data-judge]');
    expect(judge?.getAttribute('data-judge')).toBe('off');
    expect(judge?.textContent).toBe('judge off');
    expect(document.querySelector('header [data-demo]')).toBeNull();
  });

  it('the health query failing to reach the server renders unreachable', () => {
    healthMock.mockReturnValue(query(null, { error: new ApiError('unreachable', '/api/v1/health') }));
    renderHeader();
    expect(pill().getAttribute('data-status')).toBe('unreachable');
    expect(pill().textContent).toBe('unreachable');
  });

  it('the client seeing a fetch throw anywhere moves the pill, without a re-poll', () => {
    renderHeader();
    expect(pill().getAttribute('data-status')).toBe('live');
    act(() => reportConnection('unreachable'));
    expect(pill().getAttribute('data-status')).toBe('unreachable');
    act(() => reportConnection('connected'));
    expect(pill().getAttribute('data-status')).toBe('live');
  });

  it('a lost session renders signed out', () => {
    renderHeader();
    act(() => reportConnection('signed-out'));
    expect(pill().getAttribute('data-status')).toBe('signed-out');
    expect(pill().textContent).toBe('signed out');
  });

  it('a rate-limit window renders paused', () => {
    healthMock.mockReturnValue(query(ok, { rateLimitedUntil: Date.now() + 10_000 }));
    renderHeader();
    expect(pill().getAttribute('data-status')).toBe('paused');
  });

  it('a background tab renders paused and the foreground brings live back', () => {
    renderHeader();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(pill().getAttribute('data-status')).toBe('paused');
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(pill().getAttribute('data-status')).toBe('live');
  });

  it("the server's own degraded answer renders degraded", () => {
    healthMock.mockReturnValue(query({ ...ok, status: 'degraded', storage: 'disconnected' }));
    renderHeader();
    expect(pill().getAttribute('data-status')).toBe('degraded');
  });

  it('the judge chip names the provider when the judge is on', () => {
    healthMock.mockReturnValue(query({ ...ok, judge: { enabled: true, provider: 'anthropic' } }));
    renderHeader();
    const judge = document.querySelector('header [data-judge]');
    expect(judge?.getAttribute('data-judge')).toBe('on');
    expect(judge?.textContent).toBe('judge anthropic');
  });

  it("the judge chip, off, lists the server's own enable steps on hover", async () => {
    renderHeader();
    const judge = document.querySelector('header [data-judge]') as HTMLElement;
    await userEvent.hover(judge);
    expect(await screen.findByText(capabilities.judge!.howToEnable![0], {}, { timeout: 2500 })).toBeTruthy();
  });

  it('a demo server wears the DEMO chip', () => {
    healthMock.mockReturnValue(query({ ...ok, mode: 'demo' }));
    renderHeader();
    expect(document.querySelector('header [data-demo]')?.textContent).toBe('DEMO');
  });

  it('the account menu shows the retention window once and the running server version', () => {
    healthMock.mockReturnValue(query({ ...ok, version: '9.9.9' }));
    renderHeader();
    fireEvent.click(screen.getByLabelText('Account menu'));
    expect(screen.getByText('keeps 30 days')).toBeTruthy();
    expect(document.querySelectorAll('[data-retention-days]')).toHaveLength(1);
    const version = document.querySelector('[data-server-version]');
    expect(version?.textContent).toContain('Iris v9.9.9');
    expect(version?.textContent).toContain('UI v');
  });

  it('has no axe violations live, unreachable or signed out', async () => {
    const { container, unmount } = renderHeader();
    expect((await axe(container)).violations).toEqual([]);
    act(() => reportConnection('unreachable'));
    expect((await axe(container)).violations).toEqual([]);
    act(() => reportConnection('signed-out'));
    expect((await axe(container)).violations).toEqual([]);
    unmount();
  });
});
