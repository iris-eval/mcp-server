/*
 * Pages load on demand (#662). These hold the pieces the split relies on:
 * the route list matches the title list, every page's module exists and
 * exports the component the route names, the idle prefetch fetches each
 * page once and survives a failure, a page whose code is arriving shows an
 * accessible loading state, and a page whose code cannot arrive says so
 * and offers a reload.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { lazy, Suspense, type ComponentType } from 'react';
import { axe } from 'jest-axe';
import { PAGE_ROUTES, PREFETCH, prefetchPages } from '../src/routes';
import { VIEW_LOADERS } from '../src/components/dashboard/viewLoaders';
import { ROUTE_TITLES } from '../src/components/layout/routeTitles';
import { RouteLoading } from '../src/components/layout/RouteLoading';
import { ErrorBoundary, isChunkLoadError } from '../src/components/layout/ErrorBoundary';

describe('the route list', () => {
  it('routes exactly the pages the title list names (the catch-all aside)', () => {
    const routed = PAGE_ROUTES.map((r) => r.path).sort();
    const titled = ROUTE_TITLES.map((t) => t.pattern).filter((p) => p !== '*').sort();
    expect(routed).toEqual(titled);
  });

  it('every page module loads and exports a component', async () => {
    for (const r of PAGE_ROUTES) {
      const mod = await r.load();
      expect(typeof mod.default, r.path).toBe('function');
    }
  }, 30_000);

  it('the prefetch list is every page and every dashboard view', () => {
    expect(PREFETCH).toHaveLength(PAGE_ROUTES.length + VIEW_LOADERS.length);
  });
});

describe('prefetchPages', () => {
  const immediateIdle = () => {
    // jsdom has no requestIdleCallback; the prefetch falls back to a timer.
    vi.useFakeTimers();
  };

  it('fetches each chunk once, one after another, and carries on past a failure', async () => {
    immediateIdle();
    const order: string[] = [];
    const ok = (name: string) => vi.fn(async () => { order.push(name); });
    const a = ok('a');
    const broken = vi.fn(async () => { order.push('broken'); throw new Error('Failed to fetch dynamically imported module'); });
    const c = ok('c');
    prefetchPages([a, broken, c]);
    // Nothing is fetched until the browser is idle.
    expect(order).toEqual([]);
    await vi.runAllTimersAsync();
    expect(order).toEqual(['a', 'broken', 'c']);
    for (const f of [a, broken, c]) expect(f).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('stops when cancelled', async () => {
    immediateIdle();
    const a = vi.fn(async () => undefined);
    const b = vi.fn(async () => undefined);
    const cancel = prefetchPages([a, b]);
    cancel();
    await vi.runAllTimersAsync();
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('a page whose code is still arriving', () => {
  it('shows a polite status the shell keeps around, then the page', async () => {
    let arrive!: (m: { default: ComponentType }) => void;
    const Page = lazy(() => new Promise<{ default: ComponentType }>((resolve) => { arrive = resolve; }));
    const { container } = render(
      <MemoryRouter>
        <nav>sidebar stays</nav>
        <Suspense fallback={<RouteLoading />}>
          <Routes>
            <Route path="/" element={<Page />} />
          </Routes>
        </Suspense>
      </MemoryRouter>,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading page…');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('sidebar stays')).toBeInTheDocument();
    expect(await axe(container)).toHaveProperty('violations', []);

    await act(async () => arrive({ default: () => <p>the page</p> }));
    expect(await screen.findByText('the page')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('a page whose code cannot arrive', () => {
  it('recognises each browser\'s wording for a failed chunk, and nothing else', () => {
    for (const message of [
      'Failed to fetch dynamically imported module: http://127.0.0.1:6920/assets/RulesPage-abc.js',
      'error loading dynamically imported module: http://127.0.0.1:6920/assets/RulesPage-abc.js',
      'Importing a module script failed.',
      'Unable to preload CSS for /assets/index-abc.css',
    ]) {
      expect(isChunkLoadError(new Error(message)), message).toBe(true);
    }
    expect(isChunkLoadError(new Error('a widget exploded'))).toBe(false);
    expect(isChunkLoadError(new Error('Failed to fetch'))).toBe(false);
  });

  it('says the code could not load and offers a reload, not "Try again"', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Page = lazy(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/AuditPage-x.js')));
    const { container } = render(
      <MemoryRouter>
        <ErrorBoundary resetKey="/audit">
          <Suspense fallback={<RouteLoading />}>
            <Page />
          </Suspense>
        </ErrorBoundary>
      </MemoryRouter>,
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("This page's code could not be loaded.");
    expect(alert).toHaveAttribute('data-error-boundary', 'chunk');
    expect(screen.getByRole('button', { name: 'Reload the dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(await axe(container)).toHaveProperty('violations', []);
    spy.mockRestore();
  });
});
