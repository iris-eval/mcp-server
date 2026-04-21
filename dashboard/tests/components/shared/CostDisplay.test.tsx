import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CostDisplay } from '../../../src/components/shared/CostDisplay';

describe('CostDisplay', () => {
  it('formats sub-dollar values to 4 decimal places', () => {
    render(<CostDisplay value={0.0123} />);
    expect(screen.getByText('$0.0123')).toBeInTheDocument();
  });
});
