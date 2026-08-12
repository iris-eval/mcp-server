/*
 * RulesPage delete flow — pins the window.confirm → ConfirmDialog
 * migration. These tests fail if anyone reverts to native prompts:
 * jsdom's window.confirm returns false silently, so with the old code
 * no dialog role exists and the delete API is never reachable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { DeployedCustomRule } from '../../../src/api/types';

const useCustomRulesMock = vi.fn();
const deleteCustomRuleMock = vi.fn();

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
