import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import type { DeployedCustomRule, Trace, EvalResult } from '../../../src/api/types';
import { CommandPalette } from '../../../src/components/command/CommandPalette';
import { ThemeProvider } from '../../../src/components/layout/ThemeProvider';

/*
 * The palette searches the user's data through the api client (via
 * useCommandSearch). Mock ONLY the three corpus fetchers — everything
 * else on the module (RateLimitError, etc.) stays real so unrelated
 * imports keep working.
 */
const getCustomRulesMock = vi.fn();
const getTracesMock = vi.fn();
const getEvaluationsMock = vi.fn();

vi.mock('../../../src/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/api/client')>();
  return {
    ...original,
    api: {
      ...original.api,
      getCustomRules: (...args: unknown[]) => getCustomRulesMock(...args),
      getTraces: (...args: unknown[]) => getTracesMock(...args),
      getEvaluations: (...args: unknown[]) => getEvaluationsMock(...args),
    },
  };
});

function makeRule(overrides: Partial<DeployedCustomRule> = {}): DeployedCustomRule {
  return {
    id: 'r-1',
    name: 'no_checkout_pii',
    description: 'Fail when checkout output leaks PII',
    evalType: 'safety',
    severity: 'critical',
    definition: { name: 'no_checkout_pii', type: 'regex_no_match', config: {} },
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    ...overrides,
  };
}

function makeTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    trace_id: 'trace-abc-123',
    agent_name: 'checkout-agent',
    timestamp: new Date().toISOString(),
    output: 'Order placed.',
    ...overrides,
  };
}

function makeEval(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    id: 'e-1',
    trace_id: 'trace-abc-123',
    eval_type: 'safety',
    output_text: 'Sure! The SSN is 123-45-6789.',
    score: 0,
    passed: false,
    rule_results: [],
    suggestions: [],
    ...overrides,
  };
}

/* Probe that exposes the router's current path so tests can assert that
 * selecting a data result actually navigated somewhere. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderPalette(open = true, onClose = vi.fn(), onOpenShortcuts = vi.fn()) {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <CommandPalette open={open} onClose={onClose} onOpenShortcuts={onOpenShortcuts} />
        <LocationProbe />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const PLACEHOLDER = 'Search your rules, traces, evals — or type a command…';

beforeEach(() => {
  window.localStorage.clear();
  getCustomRulesMock.mockReset().mockResolvedValue({ rules: [] });
  getTracesMock.mockReset().mockResolvedValue({ traces: [], total: 0, limit: 100, offset: 0 });
  getEvaluationsMock.mockReset().mockResolvedValue({ results: [], total: 0 });
});

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    renderPalette(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the palette + input when open', () => {
    renderPalette(true);
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
  });

  it('lists Navigate commands by default without touching the data APIs', () => {
    renderPalette(true);
    expect(screen.getByRole('option', { name: /Decision Moments/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Custom Rules/ })).toBeInTheDocument();
    // No query yet — the corpus fetch must not fire on open.
    expect(getCustomRulesMock).not.toHaveBeenCalled();
    expect(getTracesMock).not.toHaveBeenCalled();
    expect(getEvaluationsMock).not.toHaveBeenCalled();
  });

  it('filters commands by query', async () => {
    const user = userEvent.setup();
    renderPalette(true);
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    await user.type(input, 'rules');
    // Custom Rules navigation match remains; non-matching items hidden
    expect(screen.queryByRole('option', { name: /Custom Rules/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Toggle theme/ })).not.toBeInTheDocument();
  });

  it('shows empty state when query matches nothing', async () => {
    const user = userEvent.setup();
    renderPalette(true);
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    await user.type(input, 'asdfqwerty');
    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    renderPalette(true, onClose);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('runs the active command on Enter and pushes to recents', async () => {
    const onClose = vi.fn();
    renderPalette(true, onClose);
    // First option is the highest-scored Navigate command — Dashboard with empty query
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    expect(onClose).toHaveBeenCalled();
    const recents = JSON.parse(window.localStorage.getItem('iris-recent-commands') ?? '[]');
    expect(recents.length).toBeGreaterThan(0);
  });

  it('arrow keys move selection', async () => {
    renderPalette(true);
    const initial = document.querySelector('[role="option"][aria-selected="true"]');
    expect(initial).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'ArrowDown' });
    });
    const next = document.querySelector('[role="option"][aria-selected="true"]');
    expect(next).toBeTruthy();
    expect(next).not.toBe(initial);
  });

  it('opens shortcuts overlay via the help command', async () => {
    const onOpenShortcuts = vi.fn();
    const user = userEvent.setup();
    renderPalette(true, vi.fn(), onOpenShortcuts);
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    await user.type(input, 'shortcut');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    expect(onOpenShortcuts).toHaveBeenCalled();
  });

  describe('data search', () => {
    it('surfaces a deployed rule by name under a Rules section', async () => {
      getCustomRulesMock.mockResolvedValue({ rules: [makeRule()] });
      const user = userEvent.setup();
      renderPalette(true);

      await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'checkout_pii');

      expect(await screen.findByRole('option', { name: /no_checkout_pii/ })).toBeInTheDocument();
      expect(screen.getByText('Rules')).toBeInTheDocument();
      expect(getCustomRulesMock).toHaveBeenCalledTimes(1);
    });

    it('surfaces a trace by agent name and navigates to its detail page on click', async () => {
      getTracesMock.mockResolvedValue({
        traces: [makeTrace()],
        total: 1,
        limit: 100,
        offset: 0,
      });
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderPalette(true, onClose);

      await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'checkout-agent');

      const option = await screen.findByRole('option', { name: /checkout-agent/ });
      await user.click(option);

      expect(screen.getByTestId('location')).toHaveTextContent('/traces/trace-abc-123');
      expect(onClose).toHaveBeenCalled();
    });

    it('surfaces a failed eval by its output text and links it to its trace', async () => {
      getEvaluationsMock.mockResolvedValue({ results: [makeEval()], total: 1 });
      const user = userEvent.setup();
      renderPalette(true);

      await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'SSN');

      const option = await screen.findByRole('option', { name: /safety — FAIL/ });
      await user.click(option);

      expect(screen.getByTestId('location')).toHaveTextContent('/traces/trace-abc-123');
    });

    it('keeps the surviving sections when one data source fails', async () => {
      getCustomRulesMock.mockResolvedValue({ rules: [makeRule()] });
      getTracesMock.mockRejectedValue(new Error('API error: 500'));
      const user = userEvent.setup();
      renderPalette(true);

      await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'checkout');

      // The rules result renders even though the traces fetch died.
      expect(await screen.findByRole('option', { name: /no_checkout_pii/ })).toBeInTheDocument();
    });

    it('fetches the corpus once per open — keystrokes filter locally', async () => {
      getTracesMock.mockResolvedValue({
        traces: [makeTrace(), makeTrace({ trace_id: 'trace-def-456', agent_name: 'support-agent' })],
        total: 2,
        limit: 100,
        offset: 0,
      });
      const user = userEvent.setup();
      renderPalette(true);
      const input = screen.getByPlaceholderText(PLACEHOLDER);

      await user.type(input, 'checkout-agent');
      expect(await screen.findByRole('option', { name: /checkout-agent/ })).toBeInTheDocument();

      await user.clear(input);
      await user.type(input, 'support-agent');
      expect(await screen.findByRole('option', { name: /support-agent/ })).toBeInTheDocument();

      expect(getTracesMock).toHaveBeenCalledTimes(1);
    });
  });
});
