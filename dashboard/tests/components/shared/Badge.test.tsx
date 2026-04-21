import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '../../../src/components/shared/Badge';

describe('Badge', () => {
  it('renders the label text', () => {
    render(<Badge label="OK" />);
    expect(screen.getByText('OK')).toBeInTheDocument();
  });

  it('applies variant-specific background when variant prop is set', () => {
    render(<Badge label="pass" variant="OK" />);
    const el = screen.getByText('pass');
    expect(el).toHaveStyle({ background: '#052e16' });
  });
});
