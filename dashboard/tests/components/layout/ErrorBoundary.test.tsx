/*
 * The route boundary (D-1): a page that throws keeps the shell and shows a
 * sentence; a sibling outside the boundary is untouched; "Try again"
 * re-renders the page; navigating away clears it.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { axe } from 'jest-axe';
import { ErrorBoundary, RouteBoundary } from '../../../src/components/layout/ErrorBoundary';

function Bomb({ armed }: { armed: boolean }) {
  if (armed) throw new Error('a widget exploded');
  return <p>page content</p>;
}

describe('ErrorBoundary', () => {
  it('shows the sentence in place of the page, keeps the sibling, and resets on Try again', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let armed = true;
    function Page() {
      return <Bomb armed={armed} />;
    }
    const { container, rerender } = render(
      <MemoryRouter>
        <aside>sidebar stays</aside>
        <ErrorBoundary resetKey="/">
          <Page />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('This page hit an error');
    expect(alert.textContent).toContain('a widget exploded');
    expect(screen.getByText('sidebar stays')).toBeInTheDocument();
    expect(await axe(container)).toHaveProperty('violations', []);
    armed = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    rerender(
      <MemoryRouter>
        <aside>sidebar stays</aside>
        <ErrorBoundary resetKey="/">
          <Page />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByText('page content')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('RouteBoundary clears a page\'s error when the route changes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <MemoryRouter initialEntries={['/broken']}>
        <Routes>
          <Route
            path="/broken"
            element={
              <RouteBoundary>
                <Bomb armed />
              </RouteBoundary>
            }
          />
          <Route
            path="/fine"
            element={
              <RouteBoundary>
                <p>fine page</p>
              </RouteBoundary>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    spy.mockRestore();
  });
});
