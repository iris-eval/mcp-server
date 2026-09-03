/*
 * RulesPage delete flow — pins the window.confirm → ConfirmDialog
 * migration. These tests fail if anyone reverts to native prompts:
 * jsdom's window.confirm returns false silently, so with the old code
 * no dialog role exists and the delete API is never reachable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { axe } from 'jest-axe';
import type { DeployedCustomRule } from '../../../src/api/types';

const useCustomRulesMock = vi.fn();
const deleteCustomRuleMock = vi.fn();
const setCustomRuleEnabledMock = vi.fn();

vi.mock('../../../src/api/hooks', () => ({
  useCustomRules: (...args: unknown[]) => useCustomRulesMock(...args),
}));

vi.mock('../../../src/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/api/client')>();
  return {
    ...original,
    api: {
      ...original.api,
      deleteCustomRule: (...args: unknown[]) => deleteCustomRuleMock(...args),
      setCustomRuleEnabled: (...args: unknown[]) => setCustomRuleEnabledMock(...args),
    },
  };
});

import { RulesPage } from '../../../src/components/rules/RulesPage';

function makeRule(overrides: Partial<DeployedCustomRule> = {}): DeployedCustomRule {
  return {
    id: 'rule-1',
    name: 'no_pii_leak',
    description: 'Fail on leaked PII',
    evalType: 'safety',
    severity: 'critical',
    definition: { name: 'no_pii_leak', type: 'regex_no_match', config: {} },
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    ...overrides,
  };
}

function hookResult(rules: DeployedCustomRule[], refetch = vi.fn()) {
  return { data: rules, loading: false, error: null, rateLimitedUntil: null, refetch };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <RulesPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useCustomRulesMock.mockReset();
  deleteCustomRuleMock.mockReset();
  setCustomRuleEnabledMock.mockReset();
});

describe('RulesPage delete flow', () => {
  it('clicking Delete opens the confirm dialog instead of a native prompt', () => {
    useCustomRulesMock.mockReturnValue(hookResult([makeRule()]));
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(
      screen.getByRole('alertdialog', { name: 'Delete rule "no_pii_leak"?' }),
    ).toBeInTheDocument();
    expect(deleteCustomRuleMock).not.toHaveBeenCalled();
  });

  it('says deletion takes effect on the next evaluation — not after a restart', () => {
    /*
     * The old copy read "It will stop firing on subsequent iris-mcp
     * restart" while the route hot-removes the rule from the live engine.
     * Wrong in the dangerous direction: a user deleting a safety rule was
     * told it was still enforcing when it was not.
     */
    useCustomRulesMock.mockReturnValue(hookResult([makeRule()]));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(/stops firing on the very next evaluation/);
    expect(dialog).not.toHaveTextContent(/subsequent iris-mcp restart/);
  });

  it('Cancel closes the dialog without deleting', () => {
    useCustomRulesMock.mockReturnValue(hookResult([makeRule()]));
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(deleteCustomRuleMock).not.toHaveBeenCalled();
  });

  it('confirming deletes the rule, closes the dialog, and refetches', async () => {
    const refetch = vi.fn();
    useCustomRulesMock.mockReturnValue(hookResult([makeRule()], refetch));
    deleteCustomRuleMock.mockResolvedValue(undefined);
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete rule' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(deleteCustomRuleMock).toHaveBeenCalledWith('rule-1');
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('a failed delete keeps the dialog open with the error inline', async () => {
    useCustomRulesMock.mockReturnValue(hookResult([makeRule()]));
    deleteCustomRuleMock.mockRejectedValue(new Error('API error: 500 Internal Server Error'));
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete rule' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Delete failed: API error: 500 Internal Server Error',
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});

/*
 * The enable/disable switch — the "dashboard toggle affordance" the MCP
 * tool descriptions have pointed at since v0.4 and which did not exist.
 * Optimistic: the row flips at once; a failed PATCH rolls it back with
 * the error inline.
 */
describe('RulesPage enable/disable switch', () => {
  it('renders a labelled switch with a clear state label', () => {
    useCustomRulesMock.mockReturnValue(hookResult([makeRule(), makeRule({ id: 'rule-2', name: 'paused', enabled: false })]));
    renderPage();

    const on = screen.getByRole('switch', { name: 'Enable rule no_pii_leak' });
    expect(on).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Enabled · fires on the next evaluation/)).toBeInTheDocument();

    const off = screen.getByRole('switch', { name: 'Enable rule paused' });
    expect(off).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/Disabled · kept for audit, does not fire/)).toBeInTheDocument();
    expect(screen.getByText('2 deployed · 1 enabled')).toBeInTheDocument();
  });

  it('flips optimistically, calls the API, and refetches', async () => {
    const refetch = vi.fn();
    useCustomRulesMock.mockReturnValue(hookResult([makeRule()], refetch));
    let resolvePatch: (v: unknown) => void = () => {};
    setCustomRuleEnabledMock.mockReturnValue(new Promise((r) => (resolvePatch = r)));
    renderPage();

    const sw = screen.getByRole('switch', { name: 'Enable rule no_pii_leak' });
    fireEvent.click(sw);

    // Flipped before the request resolves.
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/Disabled · kept for audit/)).toBeInTheDocument();
    expect(setCustomRuleEnabledMock).toHaveBeenCalledWith('rule-1', false);

    resolvePatch({ rule: makeRule({ enabled: false }) });
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).not.toHaveAttribute('aria-busy');
  });

  it('rolls back and shows the error inline when the PATCH fails', async () => {
    useCustomRulesMock.mockReturnValue(hookResult([makeRule()]));
    setCustomRuleEnabledMock.mockRejectedValue(new Error('API error: 500 Internal Server Error'));
    renderPage();

    const sw = screen.getByRole('switch', { name: 'Enable rule no_pii_leak' });
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'false');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not disable rule: API error: 500 Internal Server Error',
    );
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Enabled · fires on the next evaluation/)).toBeInTheDocument();
  });

  it('has no axe violations with mixed enabled states', async () => {
    useCustomRulesMock.mockReturnValue(hookResult([makeRule(), makeRule({ id: 'rule-2', name: 'paused', enabled: false })]));
    const { container } = renderPage();
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
