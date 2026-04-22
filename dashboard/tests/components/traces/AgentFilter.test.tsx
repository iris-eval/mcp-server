import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentFilter } from '../../../src/components/traces/AgentFilter';

describe('AgentFilter', () => {
  it('renders an All-agents option plus one option per agent', () => {
    render(
      <AgentFilter
        agents={['support-bot', 'code-reviewer', 'doc-writer']}
        value=""
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('option', { name: 'All agents' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'support-bot' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'code-reviewer' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'doc-writer' })).toBeInTheDocument();
  });

  it('shows the value as the currently-selected option', () => {
    render(
      <AgentFilter
        agents={['support-bot', 'code-reviewer']}
        value="support-bot"
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('combobox')).toHaveValue('support-bot');
  });

  it('calls onChange with the new value when selection changes', () => {
    const onChange = vi.fn();
    render(
      <AgentFilter
        agents={['support-bot', 'code-reviewer']}
        value=""
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'code-reviewer' },
    });
    expect(onChange).toHaveBeenCalledWith('code-reviewer');
  });

  it('calls onChange with empty string when "All agents" is selected', () => {
    const onChange = vi.fn();
    render(
      <AgentFilter
        agents={['support-bot']}
        value="support-bot"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: '' },
    });
    expect(onChange).toHaveBeenCalledWith('');
  });
});
