import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScoreBadge } from '../../../src/components/shared/ScoreBadge';

describe('ScoreBadge', () => {
  it('renders passing styling when score >= 0.7', () => {
    render(<ScoreBadge score={0.85} />);
    const el = screen.getByText('85%');
    expect(el).toHaveStyle({ background: '#052e16', color: '#22c55e' });
  });

  it('renders failing styling when score < 0.7', () => {
    render(<ScoreBadge score={0.42} />);
    const el = screen.getByText('42%');
    expect(el).toHaveStyle({ background: '#450a0a', color: '#ef4444' });
  });
});
