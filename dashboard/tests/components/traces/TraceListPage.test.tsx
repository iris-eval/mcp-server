/*
 * The trace list's search (#7): the box commits after a pause in typing and
 * puts the search in the URL, the request carries q, each result shows
 * where it matched with the matched words marked, the count is announced,
 * a query with no word in it shows a hint instead of a request, Escape
 * clears — and the trace's own text is rendered as text, never as markup.
 */
import React from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { axe } from 'jest-axe';
import type { Trace, TraceQueryResult } from '../../../src/api/types';

const useTracesMock = vi.fn();
vi.mock('../../../src/api/hooks', () => ({
  useTraces: (...args: unknown[]) => useTracesMock(...args),
  useFilters: () => ({ data: { agent_names: ['support-bot'], frameworks: ['langchain'] }, loading: false, error: null, refetch: vi.fn() }),
  CADENCE: { FAST: 3000, NORMAL: 10000, SLOW: 30000 },
}));

import { TraceListPage } from '../../../src/components/traces/TraceListPage';
import { SEARCH_DEBOUNCE_MS } from '../../../src/components/traces/TraceSearch';

const trace = (id: string, extra: Partial<Trace> = {}): Trace => ({
  trace_id: id,
  agent_name: 'support-bot',
  output: `output of ${id}`,
  timestamp: '2026-09-21T12:00:00.000Z',
  ...extra,
});

const page = (traces: Trace[], search?: TraceQueryResult['search']): TraceQueryResult => ({ traces, total: traces.length, limit: 50, offset: 0, ...(search ? { search } : {}) });

const ready = (data: TraceQueryResult) => ({ data, loading: false, error: null, refetch: vi.fn(), rateLimitedUntil: null });

let location = '';
function LocationProbe() {
  const l = useLocation();
  location = `${l.pathname}${l.search}`;
  return null;
}

function renderAt(url = '/traces') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <TraceListPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const lastParams = () => useTracesMock.mock.calls[useTracesMock.mock.calls.length - 1][0] as Record<string, string>;

describe('TraceListPage search', () => {
  beforeEach(() => {
    useTracesMock.mockReset();
    useTracesMock.mockReturnValue(ready(page([trace('t-1'), trace('t-2')])));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('commits the typed search after a pause, puts it in the URL and sends it as q', () => {
    vi.useFakeTimers();
    renderAt();
    expect(lastParams().q).toBeUndefined();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search traces' }), { target: { value: 'refund approved' } });
    // Not yet: a request per keystroke is what the pause is for.
    expect(lastParams().q).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(lastParams()).toMatchObject({ q: 'refund approved', offset: '0' });
    expect(location).toBe('/traces?q=refund+approved');
  });

  it('Enter commits at once', () => {
    renderAt();
    const box = screen.getByRole('searchbox', { name: 'Search traces' });
    fireEvent.change(box, { target: { value: 'kestrel' } });
    fireEvent.submit(box.closest('form')!);
    expect(lastParams().q).toBe('kestrel');
  });

  it('reads a search from the URL, marks where each trace matched, and announces the count', async () => {
    useTracesMock.mockReturnValue(
      ready(
        page(
          [
            trace('t-1', {
              match: {
                field: 'output',
                snippet: 'Your refund was approved today.',
                fragments: [
                  { text: 'Your ', hit: false },
                  { text: 'refund', hit: true },
                  { text: ' was ', hit: false },
                  { text: 'approved', hit: true },
                  { text: ' today.', hit: false },
                ],
              },
            }),
            trace('t-2', { match: { field: 'tool_calls', snippet: 'issue_refund · approved', fragments: [{ text: 'issue_refund · ', hit: false }, { text: 'approved', hit: true }] } }),
            trace('t-3', {
              match: {
                field: 'spans',
                snippet: 'refund approved by the payments tool',
                fragments: [{ text: 'refund approved', hit: true }, { text: ' by the payments tool', hit: false }],
                span: { span_id: 'sp-9', name: 'execute_tool issue_refund' },
              },
            }),
          ],
          { terms: ['refund', 'approved'], index: 'fts5', complete: true },
        ),
      ),
    );
    const { container } = renderAt('/traces?q=refund%20approved');
    expect(lastParams().q).toBe('refund approved');
    expect((screen.getByRole('searchbox', { name: 'Search traces' }) as HTMLInputElement).value).toBe('refund approved');
    expect(screen.getByRole('columnheader', { name: 'Match' })).toBeTruthy();
    const marks = [...container.querySelectorAll('mark')].map((m) => m.textContent);
    expect(marks).toEqual(['refund', 'approved', 'approved', 'refund approved']);
    const snippets = container.querySelectorAll('[data-testid="match-snippet"]');
    expect(snippets[0].textContent).toBe('OutputYour refund was approved today.');
    expect(snippets[1].textContent).toBe('Tool callissue_refund · approved');
    // A match in span text names the span.
    expect(snippets[2].textContent).toBe('Spanexecute_tool issue_refundrefund approved by the payments tool');
    expect(screen.getByRole('status').textContent).toBe('3 traces match “refund approved”, best match first.');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('renders the trace’s text as text: markup in a snippet never becomes an element', () => {
    useTracesMock.mockReturnValue(
      ready(page([trace('t-x', { match: { field: 'output', snippet: '<img src=x onerror=alert(1)> script', fragments: [{ text: '<img src=x onerror=alert(1)> ', hit: false }, { text: 'script', hit: true }] } })], { terms: ['script'], index: 'fts5', complete: true })),
    );
    const { container } = renderAt('/traces?q=script');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="match-snippet"]')?.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('a search with no word in it shows a hint and sends no q', () => {
    renderAt('/traces?q=(*)');
    expect(lastParams().q).toBeUndefined();
    expect(screen.getByRole('status').textContent).toMatch(/matches words and numbers/);
    expect(screen.queryByRole('columnheader', { name: 'Match' })).toBeNull();
  });

  it('says so when nothing matches, and when the server searched without the full-text index', () => {
    useTracesMock.mockReturnValue(ready(page([], { terms: ['zebra'], index: 'fts5', complete: true })));
    const empty = renderAt('/traces?q=zebra');
    expect(screen.getByRole('status').textContent).toBe('No traces match “zebra”.');
    expect(empty.container.textContent).toContain('No traces match “zebra”');
    empty.unmount();

    useTracesMock.mockReturnValue(ready(page([trace('t-1', { match: { field: 'input', snippet: 'zebra', fragments: [{ text: 'zebra', hit: true }] } })], { terms: ['zebra'], index: 'scan', complete: true })));
    renderAt('/traces?q=zebra');
    expect(screen.getByRole('status').textContent).toMatch(/^1 trace matches “zebra”.*without the full-text index/);
  });

  it('a prefix too short to search shows a hint and sends no q (#703)', () => {
    renderAt('/traces?q=re*');
    expect(lastParams().q).toBeUndefined();
    expect(screen.getByRole('status').textContent).toBe('A prefix needs at least 3 letters before the * (re* starts too many words to narrow the search): type more of the word, or drop the *.');
    expect(screen.queryByRole('columnheader', { name: 'Match' })).toBeNull();
  });

  it('says when a search stopped at its time limit, and that the count is of the newest traces it read', () => {
    const cut = { ...page([trace('t-1', { match: { field: 'output', snippet: 'refund', fragments: [{ text: 'refund', hit: true }] } })], { terms: ['refund'], index: 'fts5', complete: false, budget_ms: 1000 }), total: 1234 };
    useTracesMock.mockReturnValue(ready(cut));
    const one = renderAt('/traces?q=refund');
    expect(screen.getByRole('status').textContent).toBe(
      'At least 1,234 traces match “refund”: the search stopped at its limit of 1 second, so these are the best matches among the newest traces it read. Add a word or a filter to narrow it.',
    );
    one.unmount();

    useTracesMock.mockReturnValue(ready(page([], { terms: ['zebra'], index: 'scan', complete: false, budget_ms: 2500 })));
    renderAt('/traces?q=zebra');
    expect(screen.getByRole('status').textContent).toBe(
      'No match for “zebra” in the newest traces read before the search stopped at its limit of 2.5 seconds. Add a word or a filter to narrow it. (Searched without the full-text index, so larger stores search slowly.)',
    );
  });

  it('Escape clears the search and the URL', async () => {
    renderAt('/traces?q=refund');
    const box = screen.getByRole('searchbox', { name: 'Search traces' }) as HTMLInputElement;
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('');
    await waitFor(() => expect(location).toBe('/traces'));
    expect(lastParams().q).toBeUndefined();
  });

  it('a new search goes back to the first page', () => {
    vi.useFakeTimers();
    useTracesMock.mockReturnValue(ready({ ...page(Array.from({ length: 50 }, (_, i) => trace(`t-${i}`))), total: 120 }));
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(lastParams().offset).toBe('50');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search traces' }), { target: { value: 'refund' } });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(lastParams()).toMatchObject({ q: 'refund', offset: '0' });
  });
});

describe('TraceListPage export (#4)', () => {
  beforeEach(() => {
    useTracesMock.mockReset();
    useTracesMock.mockReturnValue(ready({ ...page([trace('t-1')]), total: 321 }));
  });

  it('offers every matching trace — the count the list reports — with the search and filters, never the page', () => {
    renderAt('/traces?q=refund');
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by agent' }), { target: { value: 'support-bot' } });
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(lastParams().offset).toBe('50');
    fireEvent.click(screen.getByRole('button', { name: 'Export 321 traces' }));
    const href = screen.getByRole('link', { name: /CSV/ }).getAttribute('href')!;
    const url = new URL(href, 'http://localhost');
    expect(url.pathname).toBe('/api/v1/traces/export');
    expect(Object.fromEntries(url.searchParams)).toEqual({ agent_name: 'support-bot', q: 'refund', format: 'csv' });
  });
});
