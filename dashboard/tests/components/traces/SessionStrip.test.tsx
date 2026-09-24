/*
 * The session strip: rendered only for a trace in a session;
 * says which turn this is, links the previous and the next, lists them all.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { axe } from 'jest-axe';
import type { Trace } from '../../../src/api/types';

const useTracesMock = vi.fn();
vi.mock('../../../src/api/hooks', () => ({
  useTraces: (...args: unknown[]) => useTracesMock(...args),
  CADENCE: { FAST: 3000, NORMAL: 10000, SLOW: 30000 },
}));

import { SessionStrip } from '../../../src/components/traces/SessionStrip';

const turn = (i: number, session = 'sess-1'): Trace => ({
  trace_id: `t-${i}`,
  agent_name: 'bot',
  input: `turn ${i} asks something`,
  output: `answer ${i}`,
  timestamp: `2026-09-21T12:0${i}:00.000Z`,
  session_id: session,
});

describe('SessionStrip', () => {
  it('names the session, this turn\'s place in it, and links the previous and the next', async () => {
    const turns = [turn(1), turn(2), turn(3)];
    useTracesMock.mockReturnValue({ data: { traces: turns, total: 3, limit: 200, offset: 0 }, loading: false, error: null, refetch: vi.fn() });
    const { container } = render(
      <MemoryRouter>
        <SessionStrip trace={turns[1]} />
      </MemoryRouter>,
    );
    expect(useTracesMock).toHaveBeenCalledWith({ session: 'sess-1', sort_by: 'timestamp', sort_order: 'asc', limit: '200' });
    expect(container.querySelector('[data-session-strip="sess-1"]')).not.toBeNull();
    expect(container.querySelector('[data-session-turn]')?.textContent).toBe('turn 2 of 3');
    expect(container.querySelector('[data-session-prev="t-1"]')?.getAttribute('href')).toBe('/traces/t-1');
    expect(container.querySelector('[data-session-next="t-3"]')?.getAttribute('href')).toBe('/traces/t-3');
    expect(container.querySelectorAll('[data-session-turn-link]')).toHaveLength(3);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('the first turn has no previous and the last no next', () => {
    const turns = [turn(1), turn(2)];
    useTracesMock.mockReturnValue({ data: { traces: turns, total: 2, limit: 200, offset: 0 }, loading: false, error: null, refetch: vi.fn() });
    const first = render(<MemoryRouter><SessionStrip trace={turns[0]} /></MemoryRouter>).container;
    expect(first.querySelector('[data-session-prev]')).toBeNull();
    expect(first.querySelector('[data-session-next="t-2"]')).not.toBeNull();
    const last = render(<MemoryRouter><SessionStrip trace={turns[1]} /></MemoryRouter>).container;
    expect(last.querySelector('[data-session-next]')).toBeNull();
    expect(last.querySelector('[data-session-prev="t-1"]')).not.toBeNull();
  });

  it('renders nothing for a trace outside any session', () => {
    useTracesMock.mockReturnValue({ data: null, loading: false, error: null, refetch: vi.fn() });
    const { container } = render(
      <MemoryRouter>
        <SessionStrip trace={{ ...turn(1), session_id: undefined }} />
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-session-strip]')).toBeNull();
  });
});
