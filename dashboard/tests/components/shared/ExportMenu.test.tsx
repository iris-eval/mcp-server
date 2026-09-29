/*
 * The export disclosure (#4): a button that shows two download links, each
 * carrying the list's filters and search to the server's streaming export
 * — never limit or offset, since the export is every page — and nothing
 * else a screen reader or a keyboard user would trip on.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { ExportMenu, exportHref } from '../../../src/components/shared/ExportMenu';

describe('exportHref', () => {
  it('carries the filters and the format, and drops the page and empty values', () => {
    expect(exportHref('traces', { limit: '50', offset: '100', agent_name: 'support bot', q: 'refund "order 5521"', framework: '' }, 'csv')).toBe(
      '/api/v1/traces/export?agent_name=support+bot&q=refund+%22order+5521%22&format=csv',
    );
    expect(exportHref('evaluations', { passed: 'false' }, 'jsonl')).toBe('/api/v1/evaluations/export?passed=false&format=jsonl');
  });
});

describe('ExportMenu', () => {
  it('opens to a CSV and a JSON Lines download link for the current filters, and has no accessibility violations', async () => {
    const { container } = render(<ExportMenu kind="traces" filters={{ q: 'refund', agent_name: 'bot' }} total={1234} />);
    const trigger = screen.getByRole('button', { name: 'Export 1,234 traces' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const csv = screen.getByRole('link', { name: /CSV/ });
    const jsonl = screen.getByRole('link', { name: /JSON Lines/ });
    expect(csv.getAttribute('href')).toBe('/api/v1/traces/export?q=refund&agent_name=bot&format=csv');
    expect(jsonl.getAttribute('href')).toBe('/api/v1/traces/export?q=refund&agent_name=bot&format=jsonl');
    expect(csv.hasAttribute('download')).toBe(true);
    expect(screen.getByRole('group', { name: 'Export traces' }).textContent).toContain('across all pages');
    expect(trigger.getAttribute('aria-controls')).toBe(screen.getByRole('group').id);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('Escape closes it and returns focus to the button; choosing a format closes it', () => {
    render(<ExportMenu kind="evaluations" filters={{}} total={1} />);
    const trigger = screen.getByRole('button', { name: 'Export 1 evaluation' });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('link', { name: /CSV/ }));
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('a click elsewhere closes it', () => {
    render(
      <div>
        <p>elsewhere</p>
        <ExportMenu kind="traces" filters={{}} total={3} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export 3 traces' }));
    fireEvent.mouseDown(screen.getByText('elsewhere'));
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('is disabled, and says why, when nothing matches; names the kind while the count is loading', () => {
    const { rerender } = render(<ExportMenu kind="traces" filters={{}} total={0} />);
    const empty = screen.getByRole('button', { name: 'Export 0 traces' });
    expect(empty).toHaveProperty('disabled', true);
    expect(empty.getAttribute('title')).toBe('No traces match these filters');
    rerender(<ExportMenu kind="traces" filters={{}} />);
    expect(screen.getByRole('button', { name: 'Export traces' })).toHaveProperty('disabled', false);
  });
});
